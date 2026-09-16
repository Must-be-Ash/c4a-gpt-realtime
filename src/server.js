import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import express from "express";

import { config, publicConfig } from "./config.js";
import { fetchJson } from "./lib/http.js";
import {
  createCoinbaseTrader,
  describeInsufficientFunds,
  prepareOrderForPreview,
} from "./services/coinbase-cli.js";
import { createCoinbaseMcpClient } from "./services/coinbase-mcp.js";
import { getCandles, getProduct, getProductBook } from "./services/coinbase-market.js";
import { buildDepthSeries, normalizeCandles } from "./services/market-artifacts.js";
import { summarizeSmartMoney } from "./services/nansen-cli.js";
import { PreviewStore } from "./services/preview-store.js";
import { buildReport, saveReport } from "./services/reports.js";
import { getPolymarketSnapshot, researchCrypto, researchCryptoNews } from "./services/research.js";
import { getCatalystCalendar } from "./services/catalysts.js";
import {
  buildCatalystArtifact,
  buildDerivativesArtifact,
  buildNansenFlowIntelligenceRequest,
  buildNansenPerpPositionsRequest,
  buildNansenTokenScreenerRequest,
  buildOnchainFlowArtifact,
  buildPortfolioRiskArtifact,
  buildTradeImpactArtifact,
  calculateBookImpact,
  getDerivativesPositioning,
  selectTokenRepresentation,
  summarizePerpPositions,
  symbolFromProduct,
} from "./services/trader-insights.js";
import {
  buildAgentCashNansenRequest,
  createAgentCashMcpClient,
  normalizeAgentCashMcpResult,
  parseAgentCashToolResult,
  preferAgentCashPayment,
} from "./services/agentcash-mcp.js";
import { createOrthogonalDiscoveryClient } from "./services/orthogonal.js";
import { createRuntimeLogger } from "./services/runtime-log.js";
import { createMarketData } from "./pitch/market-data.js";
import { createDeskSource } from "./pitch/desk-source.js";
import { createNewsCheck } from "./pitch/news-check.js";
import { createPitchStore } from "./pitch/pitch-store.js";
import { createPitchScheduler } from "./pitch/scheduler.js";
import { createPitchDialer } from "./pitch/vapi-outbound.js";
import { createPitchToolRunners, PITCH_TOOL_NAMES } from "./pitch/tools.js";
import { createRealtimePitch } from "./pitch/realtime-pitch.js";
import { createTelnyxPitchDialer } from "./pitch/telnyx-dialer.js";
import { equityPreviewEstimate, estimateNotionalUsd, isEquityPreviewUnavailable, pitchGuardViolation } from "./pitch/order-guard.js";
import { buildToolRegistry } from "./agent/tools.js";
import { createVapiWebhook } from "./agent/vapi-webhook.js";
import { createEventBus } from "./agent/event-bus.js";
import { createCallStore } from "./agent/call-store.js";
import { createAuth, loginPageHtml } from "./agent/auth.js";
import { createOpenAiSip } from "./agent/openai-sip.js";
import { createOpenAiLive } from "./agent/openai-live.js";
import { createOpenAiWebhookRouter } from "./agent/openai-webhook-router.js";
import { agentCatalog, createSettingsStore } from "./agent/settings-store.js";
import {
  agentSafeX402,
  createSpongeMcpClient,
} from "./services/sponge-mcp.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDirectory = join(root, "reports");
const runtimeLogPath = join(root, "runtime", "events.jsonl");
const agentInstructions = await readFile(join(root, "AGENT.md"), "utf8");
const pitchPromptTemplate = await readFile(join(root, "src", "pitch", "PITCH_AGENT.md"), "utf8");
const app = express();
const previews = new PreviewStore({ ttlMs: config.previewTtlMs });
const trader = createCoinbaseTrader();
const coinbaseMcp = createCoinbaseMcpClient();
const agentCash = createAgentCashMcpClient();
const orthogonal = createOrthogonalDiscoveryClient({ apiKey: config.orthogonalApiKey });
const sponge = createSpongeMcpClient({ apiKey: config.spongeApiKey });
const runtimeLogger = createRuntimeLogger({ filePath: runtimeLogPath });
const marketData = createMarketData();

const summarizeBalances = (payload) => ({
  balances: (payload?.accounts ?? []).map((account) => ({
    currency: account.currency,
    available: account.available_balance?.value ?? "0",
    hold: account.hold?.value ?? "0",
  })),
});

const logEvent = runtimeLogger.log;

const normalizeMcpResult = (result, provider) => {
  const text = result?.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
  if (result?.isError) throw new Error(text || `${provider} tool call failed.`);
  if (result?.structuredContent != null) return result.structuredContent;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { result: text };
  }
};

const callAgentCashData = async (argumentsValue, context) => {
  logEvent("agentcash.tool.requested", { toolName: "fetch", arguments: argumentsValue, context });
  try {
    const result = await agentCash.callTool("fetch", argumentsValue);
    const parsed = parseAgentCashToolResult(result);
    const status = Number(parsed?.statusCode ?? parsed?.status);
    if (parsed?.cause || parsed?.success === false || parsed?.ok === false || status >= 400) {
      const error = new Error(parsed?.providerError?.message || parsed?.error || parsed?.message || "Paid data request failed.");
      error.status = status >= 400 ? status : 502;
      throw error;
    }
    logEvent("agentcash.tool.completed", { toolName: "fetch", arguments: argumentsValue, context, result });
    return parsed;
  } catch (error) {
    logEvent("agentcash.tool.failed", { toolName: "fetch", arguments: argumentsValue, context, error });
    throw error;
  }
};

const validProductId = (value) => /^[A-Z0-9][A-Z0-9-]{0,23}-USD$/.test(value);
const newsTimeframes = new Set(["today", "yesterday", "today_and_yesterday", "last_7_days", "last_30_days"]);

const parseNewsRequest = (body, { requireFocus = false } = {}) => {
  const productId = String(body?.productId || config.defaultProduct).toUpperCase();
  if (!validProductId(productId)) {
    const error = new Error("productId must be a valid USD product such as SOL-USD.");
    error.status = 400;
    throw error;
  }
  const focusQuery = String(body?.focusQuery ?? "").trim();
  if (requireFocus && !focusQuery) {
    const error = new Error("focusQuery is required for a focused news search.");
    error.status = 400;
    throw error;
  }
  if (focusQuery.length > 500) {
    const error = new Error("focusQuery must be 500 characters or fewer.");
    error.status = 400;
    throw error;
  }
  const timeframe = newsTimeframes.has(body?.timeframe) ? body.timeframe : "last_7_days";
  const parsedOffset = Number(body?.timezoneOffsetMinutes);
  const timezoneOffsetMinutes = Number.isFinite(parsedOffset)
    ? Math.max(-840, Math.min(840, parsedOffset))
    : 0;
  return { productId, focusQuery, timeframe, timezoneOffsetMinutes };
};

app.disable("x-powered-by");
// Health check for Fly (harmless locally).
app.get("/healthz", (_request, response) => response.json({ ok: true }));

const asyncRoute = (handler) => async (request, response, next) => {
  try {
    await handler(request, response);
  } catch (error) {
    next(error);
  }
};

// ── Hosted phone capability (additive; off unless ENABLE_WEB_PHONE). Mounted
//    before the global 100kb JSON parser so Vapi payloads get their own limit. ──
if (config.enableWebPhone || config.enableOpenAiSip) {
  // ── Private access: gate the app behind a password, EXCEPT the phone webhooks,
  //    the login page, the landing page, and login-page assets. The tool
  //    registry's own localhost fetches carry an internal token to pass. ──
  const auth = createAuth({ password: config.dashboardPassword, secret: config.sessionSecret });
  const OPEN_PATHS = new Set(["/healthz", "/login", "/", "/index.html", "/styles.css", "/landing.js", "/landing.css", "/og.png", "/favicon.ico", "/skill", "/skill-web-vapi", "/skill-web-openai"]);
  const isOpen = (path) => OPEN_PATHS.has(path) || path.startsWith("/vapi/") || path.startsWith("/openai/") || path.startsWith("/telnyx/");
  if (auth.enabled) {
    app.use((request, response, next) => {
      if (isOpen(request.path)) { next(); return; }
      auth.requireAuth(request, response, next);
    });
    app.get("/login", (_request, response) => response.type("html").send(loginPageHtml()));
    app.post("/login", express.urlencoded({ extended: false }), auth.login);
  }

  const toolRegistry = buildToolRegistry({
    baseUrl: `http://127.0.0.1:${config.port}`,
    headers: config.sessionSecret ? { "x-internal-token": config.sessionSecret } : {},
  });
  const eventBus = createEventBus();
  const callStore = createCallStore({ dir: join(root, "runtime", "calls") });
  const emitEvent = (event) => {
    try { eventBus.publish(event); } catch { /* never let dashboard fan-out break a call */ }
    callStore.record(event).catch(() => { /* history is best-effort */ });
  };

  // A call counts as live while its events keep arriving; a lost end-of-call
  // report must not block outbound pitches forever.
  const lastCallEventAt = new Map();
  eventBus.subscribe((event) => { if (event.callId) lastCallEventAt.set(event.callId, Date.now()); });
  const isCallActive = () => {
    const id = eventBus.currentCallId;
    return Boolean(id) && Date.now() - (lastCallEventAt.get(id) ?? 0) < 15 * 60_000;
  };

  // ── Outbound pitch calls ("Jordan"). The webhook side is on whenever the pitch
  //    assistant and number are configured (so callbacks work); the scheduler
  //    only runs with ENABLE_PITCH_CALLS. ──
  const pitchConfigured = Boolean(config.enableWebPhone && config.pitch.assistantId && config.pitch.phoneNumberId);
  const pitchStore = createPitchStore({ dir: join(root, "runtime") });
  const pitchRunners = createPitchToolRunners({ store: pitchStore });
  // gpt-realtime-2.1 engine: Telnyx dials, OpenAI SIP answers with Jordan.
  const realtimePitchReady = Boolean(pitchConfigured && config.enableOpenAiSip && config.pitch.telnyxApiKey && config.pitch.telnyxConnectionId && config.pitch.openAiProjectId);
  const realtimePitch = createRealtimePitch({
    store: pitchStore,
    registry: toolRegistry,
    runners: pitchRunners,
    promptTemplate: pitchPromptTemplate,
    sharedDefinitions: toolRegistry.staticDefinitions,
    settings: config.pitch,
    emit: emitEvent,
    log: logEvent,
  });
  const telnyxPitch = createTelnyxPitchDialer({ settings: config.pitch, store: pitchStore, emit: emitEvent, log: logEvent });
  if (realtimePitchReady) app.post("/telnyx/pitch-events", express.json({ limit: "1mb" }), telnyxPitch.handleEvent);

  // ── Phone transport A: Vapi (managed OpenAI Realtime; limited to Vapi's model list) ──
  if (config.enableWebPhone) {
    app.post(
      "/vapi/webhook",
      express.json({ limit: "5mb" }),
      createVapiWebhook({
        registry: toolRegistry,
        secret: config.vapiWebhookSecret,
        allowedCallers: config.allowedCallers,
        assistantId: config.vapiAgentId,
        emit: emitEvent,
        onCallEnd: (report) => callStore.finalize(report).catch(() => {}),
        pitch: pitchConfigured
          ? {
            phoneNumberId: config.pitch.phoneNumberId,
            assistantId: config.pitch.assistantId,
            store: pitchStore,
            runners: pitchRunners,
            toolNames: PITCH_TOOL_NAMES,
            maxOrderUsd: config.pitch.maxOrderUsd,
          }
          : null,
      }),
    );
  }

  // ── Armed-agent settings (which OpenAI path answers the shared Telnyx number) ──
  const settings = createSettingsStore({ dir: join(root, "runtime"), defaultSipAgent: config.openAiSipDefaultAgent, defaultPitchEngine: config.pitch.engine });
  const agentState = async () => ({
    ...(await settings.get()),
    agents: agentCatalog({ telnyxNumber: config.sipPhoneNumber, vapiNumber: config.vapiPhoneNumber }),
  });
  app.get("/api/agent", asyncRoute(async (_request, response) => response.json(await agentState())));
  app.post("/api/agent", express.json({ limit: "10kb" }), asyncRoute(async (request, response) => {
    try {
      await settings.select(String(request.body?.agent ?? ""));
      logEvent("agent.selected", await settings.get());
      response.json(await agentState());
    } catch (error) {
      response.status(error.status || 500).json({ error: error.message });
    }
  }));

  // ── Pitch scheduler + dashboard controls ──
  const vapiPitchDial = createPitchDialer({ settings: config.pitch });
  const pitchScheduler = config.pitch.enabled && pitchConfigured
    ? createPitchScheduler({
      desk: createDeskSource({ url: config.pitch.deskDatabaseUrl, log: logEvent }),
      market: marketData,
      store: pitchStore,
      checkNews: createNewsCheck({ exaApiKey: config.exaApiKey, openAiApiKey: config.openAiApiKey, model: config.summaryModel }),
      dial: (vapi, pitch) => (pitch.engine === "realtime" ? telnyxPitch.dial(vapi, pitch) : vapiPitchDial(vapi)),
      // Fall back to ElevenLabs if the realtime engine isn't configured on this deployment.
      getEngine: () => (settings.pitchEngine() === "realtime" && realtimePitchReady ? "realtime" : "elevenlabs"),
      getBalances: () => trader.balance(),
      settings: config.pitch,
      openAi: { apiKey: config.openAiApiKey, model: config.summaryModel },
      isPaused: () => settings.pitchPaused(),
      isCallActive,
      emit: emitEvent,
      log: logEvent,
    })
    : null;
  const pitchState = async () => ({
    enabled: Boolean(pitchScheduler),
    dryRun: config.pitch.dryRun,
    paused: settings.pitchPaused(),
    engine: settings.pitchEngine(),
    engines: [
      { id: "elevenlabs", label: "ElevenLabs (Vapi)", available: pitchConfigured },
      { id: "realtime", label: `${config.pitch.realtimeModel} (${config.pitch.realtimeVoice})`, available: realtimePitchReady },
    ],
    pitchNumber: config.pitch.phoneNumber || null,
    maxCallsPerDay: config.pitch.maxCallsPerDay,
    maxOrderUsd: config.pitch.maxOrderUsd,
    ...(await pitchStore.dialState()),
    lastRun: pitchScheduler?.lastRun ?? null,
    nextScanAt: pitchScheduler?.nextScanAt() ?? null,
    recent: (await pitchStore.list({ limit: 5 })).map(({ id, symbol, asset, status, calledAt, createdAt, outcome, voice, engine }) => ({ id, symbol, asset, status, calledAt, createdAt, outcome, voice, engine })),
  });
  app.get("/api/pitch/state", asyncRoute(async (_request, response) => response.json(await pitchState())));
  app.post("/api/pitch/pause", express.json({ limit: "1kb" }), asyncRoute(async (request, response) => {
    await settings.setPitchPaused(request.body?.paused === true);
    logEvent("pitch.paused", { paused: settings.pitchPaused() });
    response.json(await pitchState());
  }));
  app.post("/api/pitch/engine", express.json({ limit: "1kb" }), asyncRoute(async (request, response) => {
    const engine = String(request.body?.engine ?? "");
    if (engine === "realtime" && !realtimePitchReady) {
      response.status(409).json({ error: "The gpt-realtime-2.1 engine needs ENABLE_OPENAI_SIP, OPENAI_PROJECT_ID, TELNYX_API_KEY and TELNYX_PITCH_CONNECTION_ID." });
      return;
    }
    try {
      await settings.setPitchEngine(engine);
    } catch (error) {
      response.status(error.status || 500).json({ error: error.message });
      return;
    }
    logEvent("pitch.engine", { engine });
    response.json(await pitchState());
  }));
  app.post("/api/pitch/run", express.json({ limit: "1kb" }), asyncRoute(async (request, response) => {
    if (!pitchScheduler) {
      response.status(409).json({ error: "Pitch calls are off (set ENABLE_PITCH_CALLS=1 and the VAPI_PITCH_* settings)." });
      return;
    }
    // Optional { symbol } targets one desk position for a test call (any age).
    const symbol = /^[A-Za-z.]{1,10}$/.test(String(request.body?.symbol ?? "")) ? request.body.symbol : null;
    const result = await pitchScheduler.runOnce({ manual: true, symbol });
    logEvent("pitch.run.manual", { target: symbol, action: result.action, symbol: result.symbol ?? null, reasons: result.reasons ?? [] });
    const { vapi: _vapi, ...summary } = result;
    response.json({ ...summary, state: await pitchState() });
  }));
  if (pitchScheduler) {
    settings.ready.then(() => pitchScheduler.start());
    logEvent("pitch.enabled", { dryRun: config.pitch.dryRun, maxCallsPerDay: config.pitch.maxCallsPerDay, maxOrderUsd: config.pitch.maxOrderUsd });
  }

  // ── Phone transport B: OpenAI over SIP (direct). Two agents share the Telnyx
  //    number: gpt-realtime-2.1 (Realtime API) and gpt-live-1 (GPT-Live API). ──
  if (config.enableOpenAiSip) {
    // Tool definitions: static immediately, refreshed with live Coinbase MCP tools.
    let sipToolDefs = toolRegistry.staticDefinitions;
    toolRegistry.listDefinitions().then((defs) => { sipToolDefs = defs; }).catch(() => {});
    const phoneInstructions = `${agentInstructions}\n\n## Phone-call style (voice)\nYou are on a live phone call. Keep replies short and spoken. Never read raw JSON, IDs, or long lists aloud; summarize. Charts and reports appear on the caller's dashboard, so briefly acknowledge show_/present tools. Before any trade you MUST call preview_order, read the exact preview back, and get an explicit spoken confirmation before execute_order.`;
    const sip = createOpenAiSip({
      apiKey: config.openAiApiKey,
      model: config.openAiSipModel,
      voice: config.realtimeVoice,
      instructions: phoneInstructions,
      getToolDefinitions: () => sipToolDefs,
      registry: toolRegistry,
      allowedCallers: config.allowedCallers,
      webhookSecret: config.openAiWebhookSecret,
      ...(config.openAiSipTurnDetection ? { turnDetection: config.openAiSipTurnDetection } : {}),
      ...(config.openAiSipTranscribeModel ? { inputTranscription: { model: config.openAiSipTranscribeModel } } : {}),
      filler: config.openAiSipFiller,
      emit: emitEvent,
      onCallEnd: (report) => callStore.finalize(report).catch(() => {}),
      log: (event, data) => logEvent(event, data),
      resolveCall: realtimePitchReady ? realtimePitch.resolveCall : null,
    });
    // GPT-Live splits the prompt: a short voice-layer prompt (tone, interruptions,
    // when to delegate) and the full agent prompt on the delegation backend (tools).
    // Voice-layer prompt follows OpenAI's GPT-Live prompting template (personality,
    // backchannels, interruptions, delegation policy). Tool procedures stay on the backend.
    const liveVoiceInstructions = `# Personality
You are the voice of the caller's personal crypto research and trading agent, on a live phone call. Calm, direct, brief. One or two short spoken sentences at a time, at a natural pace. Never read raw JSON, IDs, or long lists aloud.

# Backchannel policy
Use moderate backchannels. Acknowledge naturally without competing with the main response.

# Interruption policy
Stop speaking when the user interrupts. Listen to what they say. "Stop" means stop talking; it does not cancel work already delegated.

# Delegation policy
Backend tools: live prices, candle charts, order books, balances and positions, news and research, on-chain flows, derivatives positioning, prediction markets (Polymarket), catalysts, paid data via AgentCash, and Coinbase order preview and execution.

Delegate to the backend when:
- the caller asks for any price, chart, balance, position, market, news, research, on-chain, or prediction-market information
- the caller wants to preview, confirm, or place a trade
- the answer depends on live data you do not have

Do not delegate to the backend when:
- the caller is greeting you, thinking aloud, or asking you to repeat or clarify what you just said

Delegate before giving an answer that depends on backend work. Do not guess the result while waiting. Never promise a trade, quote a price, or say an action finished before the backend confirms it.

# While the backend works
The backend is fast (usually under a second) and the caller sees results on a dashboard the moment they are ready. Do NOT announce that you are looking something up: never say "pulling that up", "checking", "one moment", "let me", or similar. Delegate silently and stay quiet until the backend result arrives, then speak only the result in one short sentence. When the backend confirms a chart or report is shown, say so in a few words and stop.`;
    const liveBackendInstructions = `${phoneInstructions}\n\n## Delegation backend (GPT-Live)\nYou are the backend for a full-duplex voice model that speaks your output aloud. Call the needed tools immediately; do not narrate. Return only the facts and status the voice model needs, in at most two short sentences. No headings, no lists, no restating the question. When a show_/present tool succeeds, reply with a few words (for example: "BTC weekly chart is on the dashboard.").`;
    const live = createOpenAiLive({
      apiKey: config.openAiApiKey,
      backendModel: config.openAiLiveBackendModel,
      reasoningEffort: config.openAiLiveReasoningEffort,
      voice: config.realtimeVoice,
      voiceInstructions: liveVoiceInstructions,
      backendInstructions: liveBackendInstructions,
      getToolDefinitions: () => sipToolDefs,
      registry: toolRegistry,
      allowedCallers: config.allowedCallers,
      emit: emitEvent,
      onCallEnd: (report) => callStore.finalize(report).catch(() => {}),
      log: (event, data) => logEvent(event, data),
    });
    app.post("/openai/incoming-call", express.raw({ type: "*/*", limit: "1mb" }), createOpenAiWebhookRouter({
      secret: config.openAiWebhookSecret,
      getArmedAgent: () => settings.activeSipAgent(),
      sip, live,
      isPitchCall: realtimePitch.isPitchCall,
      log: (event, data) => logEvent(event, data),
    }));
    // TeXML for the SIP trunk (Telnyx): dial the OpenAI SIP endpoint for our project,
    // preserving the caller's number as callerId so OpenAI's From header (and our
    // caller allowlist) sees the real caller. Point the Telnyx number's TeXML/Voice
    // app at this URL — no manual SIP config.
    app.all("/telnyx/texml", express.urlencoded({ extended: false }), (request, response) => {
      const from = String(request.body?.From || request.query?.From || "").replace(/[^0-9+]/g, "");
      logEvent("telnyx.texml.served", { from, to: request.body?.To || request.query?.To || null, armed: settings.activeSipAgent() });
      const callerId = from ? ` callerId="${from}"` : "";
      // GPT-Live SIP calls require SRTP ("srtp_required" on accept otherwise). Telnyx
      // enables it per endpoint via the `secure` URI parameter. Realtime keeps the
      // proven plain-TLS leg.
      const secure = settings.activeSipAgent() === "gpt-live-1" ? ";secure=srtp" : "";
      response.type("application/xml").send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Dial${callerId} answerOnBridge="true"><Sip>sip:${config.openAiProjectId}@sip.api.openai.com;transport=tls${secure}</Sip></Dial></Response>`,
      );
    });
    settings.ready.then(() => logEvent("openai_sip.enabled", { model: config.openAiSipModel, liveBackend: config.openAiLiveBackendModel, armed: settings.activeSipAgent() }));
  }

  // Dashboard config (behind the gate): the number to call.
  app.get("/api/dashboard/config", asyncRoute(async (_request, response) => {
    const state = await agentState();
    const selected = state.agents.find((a) => a.id === state.selectedAgent);
    response.json({ phoneNumber: selected?.number || config.sipPhoneNumber || config.vapiPhoneNumber });
  }));

  // Call history (auth wraps these in M7).
  app.get("/api/calls", asyncRoute(async (_request, response) => {
    response.json(await callStore.listCalls());
  }));
  app.get("/api/calls/:id", asyncRoute(async (request, response) => {
    const call = await callStore.getCall(request.params.id);
    if (!call) { response.status(404).json({ error: "Call not found." }); return; }
    response.json(call);
  }));

  // Live dashboard feed (SSE). Auth wraps this in M7.
  const writeSseEvent = (response, event) => {
    // No `event:` field on purpose — the dashboard switches on data.kind via onmessage.
    response.write(`id: ${event.id}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  app.get("/api/stream", (request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    let unsubscribe = () => {};
    let heartbeat = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      try { response.end(); } catch { /* already gone */ }
    };
    // Isolate each write: a dead/slow subscriber must self-remove, never break
    // fan-out to the other connected dashboards.
    const send = (event) => {
      if (closed) return;
      try { writeSseEvent(response, event); } catch { cleanup(); }
    };
    response.write(`retry: 3000\n: connected (currentCall=${eventBus.currentCallId ?? "none"})\n\n`);
    const lastEventId = Number(request.headers["last-event-id"] || request.query.lastEventId || 0);
    if (lastEventId) {
      // Reconnect: replay everything the client missed.
      for (const event of eventBus.since(lastEventId)) send(event);
    } else if (eventBus.currentCallId) {
      // Fresh open mid-call: replay the active call so the dashboard isn't blank.
      for (const event of eventBus.snapshot()) {
        if (event.callId === eventBus.currentCallId) send(event);
      }
    }
    unsubscribe = eventBus.subscribe(send);
    heartbeat = setInterval(() => {
      if (closed) return;
      try { response.write(": ping\n\n"); } catch { cleanup(); }
    }, 15_000);
    request.on("close", cleanup);
    request.on("error", cleanup);
  });

  // Read-only dashboard viewer (static assets). Auth wraps these in M7.
  const dashboardDir = join(root, "dashboard");
  app.get(["/dashboard", "/dashboard/"], (_request, response) => response.sendFile(join(dashboardDir, "index.html")));
  app.use("/dashboard", express.static(dashboardDir));

  logEvent("web_phone.enabled", { publicBaseUrl: config.publicBaseUrl });
}

app.use(express.json({ limit: "100kb" }));
app.use("/reports", express.static(reportsDirectory));
for (const skill of ["skill", "skill-web-vapi", "skill-web-openai"]) {
  app.get(`/${skill}`, (_request, response) => {
    response.set({
      "cache-control": "public, max-age=300",
      "content-type": "text/markdown; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.sendFile(join(root, "public", skill));
  });
}
app.use(express.static(join(root, "public")));


app.get("/api/config", (_request, response) => response.json({
  ...publicConfig(),
  agentInstructions,
}));

app.get("/api/balance", asyncRoute(async (_request, response) => {
  const balances = summarizeBalances(await trader.balance());
  logEvent("balance.checked", { currencies: balances.balances.map(({ currency }) => currency) });
  response.json(balances);
}));

app.post("/api/logs/voice", (request, response) => {
  const role = request.body?.role;
  const text = String(request.body?.text ?? "").trim().slice(0, 2_000);
  if (["user", "model"].includes(role) && text) logEvent("voice.transcript", { role, text });
  response.sendStatus(204);
});

app.get("/api/coinbase/tools", asyncRoute(async (_request, response) => {
  const tools = await coinbaseMcp.listTools();
  response.json({
    connected: true,
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  });
}));

app.post("/api/coinbase/call", asyncRoute(async (request, response) => {
  const toolName = String(request.body?.toolName ?? "");
  const argumentsValue = request.body?.arguments ?? {};
  if (!argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== "object") {
    response.status(400).json({ error: "arguments must contain a JSON object." });
    return;
  }
  logEvent("coinbase.tool.requested", { toolName, arguments: argumentsValue });
  try {
    const result = normalizeMcpResult(await coinbaseMcp.callTool(toolName, argumentsValue), "Coinbase");
    logEvent("coinbase.tool.completed", { toolName, arguments: argumentsValue, result });
    response.json(result);
  } catch (error) {
    logEvent("coinbase.tool.failed", { toolName, arguments: argumentsValue, error });
    throw error;
  }
}));

app.get("/api/agentcash/tools", asyncRoute(async (_request, response) => {
  const tools = await agentCash.listTools();
  response.json({
    connected: true,
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  });
}));

app.post("/api/agentcash/call", asyncRoute(async (request, response) => {
  const toolName = String(request.body?.toolName ?? "");
  const intent = String(request.body?.intent ?? "").trim().slice(0, 1_000);
  const argumentsValue = request.body?.arguments ?? {};
  if (!argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== "object") {
    response.status(400).json({ error: "arguments must contain a JSON object." });
    return;
  }
  const effectiveArguments = toolName === "fetch"
    ? preferAgentCashPayment(argumentsValue)
    : argumentsValue;
  logEvent("agentcash.tool.requested", { toolName, intent, arguments: effectiveArguments });
  try {
    const result = normalizeAgentCashMcpResult(await agentCash.callTool(toolName, effectiveArguments));
    logEvent("agentcash.tool.completed", {
      toolName,
      intent,
      arguments: effectiveArguments,
      isError: Boolean(result.isError),
      result,
    });
    response.json(result);
  } catch (error) {
    logEvent("agentcash.tool.failed", { toolName, intent, arguments: effectiveArguments, error });
    throw error;
  }
}));

app.post("/api/logs/paid-recovery", (request, response) => {
  logEvent("paid_tool.recovery", {
    intent: String(request.body?.intent ?? "").slice(0, 1_000),
    toolName: String(request.body?.toolName ?? "").slice(0, 120),
    endpoint: String(request.body?.endpoint ?? "").slice(0, 1_000),
    outcome: String(request.body?.outcome ?? "").slice(0, 120),
    failureKind: String(request.body?.failureKind ?? "").slice(0, 120),
    attemptCount: Number(request.body?.attemptCount) || 0,
    distinctEndpointCount: Number(request.body?.distinctEndpointCount) || 0,
    alternativeCount: Number(request.body?.alternativeCount) || 0,
  });
  response.sendStatus(204);
});

app.post("/api/orthogonal/discover", asyncRoute(async (request, response) => {
  if (!config.orthogonalApiKey) {
    response.status(503).json({ error: "ORTHOGONAL_API_KEY is not configured on the server." });
    return;
  }
  const action = String(request.body?.action ?? "search");
  const argumentsValue = request.body?.arguments ?? {};
  logEvent("orthogonal.discovery.requested", { action, arguments: argumentsValue });
  let result;
  if (action === "search") {
    const prompt = String(argumentsValue.prompt ?? "").trim();
    if (!prompt) {
      response.status(400).json({ error: "prompt is required for Orthogonal search." });
      return;
    }
    result = await orthogonal.search({ prompt, limit: Math.min(10, Math.max(1, Number(argumentsValue.limit) || 5)) });
  } else if (action === "details") {
    const api = String(argumentsValue.api ?? "").trim();
    const path = String(argumentsValue.path ?? "").trim();
    if (!api || !path) {
      response.status(400).json({ error: "api and path are required for Orthogonal details." });
      return;
    }
    result = await orthogonal.details({ api, path });
  } else if (action === "list") {
    result = await orthogonal.list({
      limit: Math.min(50, Math.max(1, Number(argumentsValue.limit) || 20)),
      offset: Math.max(0, Number(argumentsValue.offset) || 0),
    });
  } else {
    response.status(400).json({ error: "action must be search, details, or list." });
    return;
  }
  logEvent("orthogonal.discovery.completed", { action, arguments: argumentsValue, result });
  response.json(result);
}));

app.get("/api/x402/tools", asyncRoute(async (_request, response) => {
  if (!config.spongeApiKey) {
    response.json({ connected: false, tools: [] });
    return;
  }
  const tools = await sponge.listTools();
  response.json({
    connected: true,
    tools: tools.map(({ name, description, inputSchema }) => agentSafeX402({ name, description, inputSchema })),
  });
}));

app.post("/api/x402/call", asyncRoute(async (request, response) => {
  const toolName = String(request.body?.toolName ?? "");
  const argumentsValue = request.body?.arguments ?? {};
  if (!argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== "object") {
    response.status(400).json({ error: "arguments must contain a JSON object." });
    return;
  }
  logEvent("sponge.tool.requested", { toolName, arguments: argumentsValue });
  try {
    const result = await sponge.callTool(toolName, argumentsValue);
    logEvent("sponge.tool.completed", {
      toolName,
      arguments: argumentsValue,
      isError: Boolean(result.isError),
      result,
    });
    response.json(agentSafeX402(result));
  } catch (error) {
    logEvent("sponge.tool.failed", { toolName, arguments: argumentsValue, error });
    throw error;
  }
}));

app.post("/api/smart-money", asyncRoute(async (request, response) => {
  const symbol = String(request.body?.symbol ?? "").trim().toUpperCase();
  logEvent("nansen.smart_money.requested", { symbol });
  const paidRequest = buildAgentCashNansenRequest(symbol);
  logEvent("agentcash.tool.requested", { toolName: "fetch", arguments: paidRequest, context: "smart-money" });
  let paidResult;
  try {
    paidResult = await agentCash.callTool("fetch", paidRequest);
    logEvent("agentcash.tool.completed", {
      toolName: "fetch",
      arguments: paidRequest,
      context: "smart-money",
      result: paidResult,
    });
  } catch (error) {
    logEvent("agentcash.tool.failed", {
      toolName: "fetch",
      arguments: paidRequest,
      context: "smart-money",
      error,
    });
    throw error;
  }
  const paid = parseAgentCashToolResult(paidResult);
  const result = {
    ...summarizeSmartMoney(paid, symbol),
    payment: paid.paymentInfo ?? null,
    route: paid.route ?? null,
  };
  logEvent("nansen.smart_money.completed", {
    symbol,
    tradeCount: result.tradeCount,
    lean: result.lean,
    paymentMade: Boolean(result.payment),
  });
  response.json(agentSafeX402(result));
}));

app.post("/api/realtime-token", asyncRoute(async (_request, response) => {
  if (!config.openAiApiKey) {
    response.status(503).json({ error: "OPENAI_API_KEY is not configured on the server." });
    return;
  }
  const clientSecret = await fetchJson("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openAiApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: config.realtimeModel,
        audio: { output: { voice: config.realtimeVoice } },
      },
    }),
  });
  if (!clientSecret?.value) throw new Error("OpenAI did not return a Realtime client secret.");
  response.json({ value: clientSecret.value });
}));

app.post("/api/research", asyncRoute(async (request, response) => {
  const newsRequest = parseNewsRequest(request.body);
  logEvent("news.search.requested", { mode: "research", ...newsRequest });
  const raw = await researchCrypto(newsRequest, {
    exaApiKey: config.exaApiKey,
    openAiApiKey: config.openAiApiKey,
    summaryModel: config.summaryModel,
  });
  logEvent("news.search.completed", {
    mode: "research",
    productId: newsRequest.productId,
    ...raw.search,
    resultCount: raw.news.length,
    titles: raw.news.map((item) => item.title),
  });
  const report = buildReport(raw);
  const filename = await saveReport(report, reportsDirectory);
  response.json({ report, reportUrl: `/reports/${filename}` });
}));

app.post("/api/news", asyncRoute(async (request, response) => {
  const newsRequest = parseNewsRequest(request.body, { requireFocus: true });
  logEvent("news.search.requested", { mode: "news", ...newsRequest });
  const raw = await researchCryptoNews(newsRequest, {
    exaApiKey: config.exaApiKey,
    openAiApiKey: config.openAiApiKey,
    summaryModel: config.summaryModel,
  });
  logEvent("news.search.completed", {
    mode: "news",
    productId: newsRequest.productId,
    ...raw.search,
    resultCount: raw.news.length,
    titles: raw.news.map((item) => item.title),
  });
  const report = buildReport(raw);
  const filename = await saveReport(report, reportsDirectory);
  response.json({ report, reportUrl: `/reports/${filename}` });
}));

app.post("/api/artifacts/candles", asyncRoute(async (request, response) => {
  const productId = String(request.body?.productId ?? "").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,23}-USD$/.test(productId)) {
    response.status(400).json({ error: "productId must be a valid USD product such as SOL-USD." });
    return;
  }
  const candles = normalizeCandles(await getCandles(productId, {
    granularity: "ONE_DAY",
    limit: 30,
  }));
  response.json({ type: "candles", productId, granularity: "1 day", generatedAt: new Date().toISOString(), candles });
}));

app.post("/api/artifacts/order-book", asyncRoute(async (request, response) => {
  const productId = String(request.body?.productId ?? "").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,23}-USD$/.test(productId)) {
    response.status(400).json({ error: "productId must be a valid USD product such as SOL-USD." });
    return;
  }
  response.json({ type: "order-book", ...buildDepthSeries(await getProductBook(productId, { limit: 50 })) });
}));

app.post("/api/artifacts/polymarket", asyncRoute(async (request, response) => {
  const productId = String(request.body?.productId ?? "").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,23}-USD$/.test(productId)) {
    response.status(400).json({ error: "productId must be a valid USD product such as SOL-USD." });
    return;
  }
  response.json(await getPolymarketSnapshot(productId));
}));

app.post("/api/artifacts/derivatives-positioning", asyncRoute(async (request, response) => {
  const productId = String(request.body?.productId ?? "").toUpperCase();
  if (!validProductId(productId)) {
    response.status(400).json({ error: "productId must be a valid USD product such as HYPE-USD." });
    return;
  }
  const market = await getDerivativesPositioning(productId);
  const warnings = [];
  let positions = null;
  try {
    const paid = await callAgentCashData(buildNansenPerpPositionsRequest(market.symbol), "derivatives-positioning");
    positions = summarizePerpPositions(paid, market.markPrice);
  } catch (error) {
    warnings.push(`Position aggregation unavailable: ${error.message}`);
  }
  logEvent("insight.derivatives.completed", { productId, positionCount: positions?.positionCount ?? 0, warnings });
  response.json({ spec: buildDerivativesArtifact(market, positions, warnings), generatedAt: market.generatedAt });
}));

app.post("/api/artifacts/position-risk", asyncRoute(async (_request, response) => {
  const listed = normalizeMcpResult(await coinbaseMcp.callTool("coinbase_portfolios_list", {}), "Coinbase");
  const portfolioRows = listed?.portfolios ?? [];
  const portfolios = await Promise.all(portfolioRows.map(({ uuid }) => coinbaseMcp
    .callTool("coinbase_portfolios_get", { portfolio_id: uuid })
    .then((result) => normalizeMcpResult(result, "Coinbase"))));
  const orderResult = normalizeMcpResult(await coinbaseMcp.callTool("coinbase_orders_list", {
    status: "OPEN",
    limit: 100,
  }), "Coinbase");
  const openOrders = orderResult?.orders ?? [];
  logEvent("insight.portfolio_risk.completed", { portfolioCount: portfolios.length, openOrderCount: openOrders.length });
  response.json({
    spec: buildPortfolioRiskArtifact(portfolios, openOrders),
    generatedAt: new Date().toISOString(),
  });
}));

app.post("/api/artifacts/trade-impact", asyncRoute(async (request, response) => {
  const productId = String(request.body?.productId ?? "").toUpperCase();
  const quoteSize = Number(request.body?.quoteSize);
  if (!validProductId(productId)) {
    response.status(400).json({ error: "productId must be a valid USD product such as BTC-USD." });
    return;
  }
  if (!Number.isFinite(quoteSize) || quoteSize <= 0 || quoteSize > 1_000_000) {
    response.status(400).json({ error: "quoteSize must be between 0 and 1,000,000 USD." });
    return;
  }
  const [book, fees] = await Promise.all([
    getProductBook(productId, { limit: 100 }),
    coinbaseMcp.callTool("coinbase_fees", {}).then((result) => normalizeMcpResult(result, "Coinbase")),
  ]);
  const impact = calculateBookImpact(book, quoteSize, fees?.fee_tier);
  logEvent("insight.trade_impact.completed", { productId, quoteSize, spreadBps: impact.spreadBps });
  response.json({ spec: buildTradeImpactArtifact(impact, quoteSize), generatedAt: impact.generatedAt });
}));

app.post("/api/artifacts/onchain-flows", asyncRoute(async (request, response) => {
  const productId = String(request.body?.productId ?? "").toUpperCase();
  if (!validProductId(productId)) {
    response.status(400).json({ error: "productId must be a valid USD product such as HYPE-USD." });
    return;
  }
  const symbol = symbolFromProduct(productId);
  const chain = request.body?.chain == null ? null : String(request.body.chain).trim().toLowerCase();
  const tokenAddress = request.body?.tokenAddress == null ? null : String(request.body.tokenAddress).trim();
  let screener = null;
  if (!(chain && tokenAddress)) {
    const candidateChains = ["ethereum", "solana", "base", "arbitrum", "hyperevm"];
    const settled = await Promise.allSettled(candidateChains.map((candidateChain) => callAgentCashData(
      buildNansenTokenScreenerRequest([candidateChain]),
      `onchain-token-resolution:${candidateChain}`,
    )));
    const records = settled.flatMap((result) => result.status === "fulfilled"
      ? result.value?.data?.data ?? result.value?.data ?? []
      : []);
    screener = { data: records };
  }
  const token = selectTokenRepresentation(screener, symbol, { chain, tokenAddress });
  if (!token) {
    const error = new Error(`Nansen did not return an exact or wrapped ${symbol} token representation. Provide its chain and token address for holder-segment flows.`);
    error.status = 404;
    throw error;
  }
  let flowPayload = null;
  try {
    flowPayload = await callAgentCashData(buildNansenFlowIntelligenceRequest({
      chain: token.chain,
      tokenAddress: token.token_address,
    }), "onchain-flow-intelligence");
  } catch (error) {
    logEvent("insight.onchain_flows.partial", { productId, chain: token.chain, tokenAddress: token.token_address, error });
  }
  logEvent("insight.onchain_flows.completed", { productId, chain: token.chain, tokenSymbol: token.token_symbol });
  response.json({
    spec: buildOnchainFlowArtifact(symbol, token, flowPayload),
    generatedAt: new Date().toISOString(),
  });
}));

app.post("/api/artifacts/catalysts", asyncRoute(async (request, response) => {
  const productId = String(request.body?.productId ?? "").toUpperCase();
  const horizonDays = Math.min(180, Math.max(7, Number(request.body?.horizonDays) || 90));
  if (!validProductId(productId)) {
    response.status(400).json({ error: "productId must be a valid USD product such as HYPE-USD." });
    return;
  }
  const result = await getCatalystCalendar({ productId, horizonDays }, {
    exaApiKey: config.exaApiKey,
    openAiApiKey: config.openAiApiKey,
    summaryModel: config.summaryModel,
  });
  logEvent("insight.catalysts.completed", { productId, horizonDays, eventCount: result.catalysts.length });
  response.json({
    spec: buildCatalystArtifact(result.symbol, result.catalysts, result.warnings),
    generatedAt: result.generatedAt,
  });
}));

app.post("/api/orders/preview", asyncRoute(async (request, response) => {
  const {
    order: requestedOrder,
    requestedQuoteSize,
    baseIncrement,
  } = await prepareOrderForPreview(request.body ?? {}, {
    // The public market API 404s on stocks; the authenticated CLI knows them.
    getProduct: (id) => getProduct(id).catch(async (error) => (await marketData.coinbaseProduct(id)) ?? Promise.reject(error)),
  });
  logEvent("order.preview.requested", {
    productId: requestedOrder.productId,
    side: requestedOrder.side,
    amount: requestedQuoteSize ?? requestedOrder.quoteSize ?? requestedOrder.baseSize,
    amountCurrency: requestedQuoteSize != null || requestedOrder.quoteSize != null
      ? requestedOrder.productId.split("-").at(-1)
      : requestedOrder.productId.endsWith("-CDE") ? "contracts" : requestedOrder.productId.split("-")[0],
    baseSize: requestedOrder.baseSize ?? null,
    baseIncrement,
  });
  const pitchGuard = request.body?.pitchGuard
    ? { maxUsd: Number(request.body.pitchGuard.maxUsd), productId: String(request.body.pitchGuard.productId ?? "") }
    : null;
  let preview;
  try {
    preview = await trader.preview(requestedOrder);
  } catch (error) {
    if (isEquityPreviewUnavailable(error)) {
      // Coinbase has no API preview for stocks; estimate at the live price.
      const ticker = requestedOrder.productId.replace(/-(USD|USDC)$/, "");
      const quote = await marketData.quote({ source: "yahoo", symbol: ticker });
      preview = { order: requestedOrder, result: equityPreviewEstimate(requestedOrder, quote?.price) };
      logEvent("order.preview.estimated", { productId: requestedOrder.productId, price: quote?.price ?? null });
    } else if (/insufficient fund/i.test(error.message)) {
      const balances = await trader.balance().catch(() => null);
      const enriched = new Error(describeInsufficientFunds(requestedOrder, balances), { cause: error });
      enriched.status = 400;
      throw enriched;
    } else {
      throw error;
    }
  }
  const { order, result } = preview;
  let guard = null;
  if (pitchGuard) {
    const isFuture = order.productId.endsWith("-CDE");
    const contract = isFuture ? (await marketData.futuresList()).find((p) => p.product_id === order.productId) : null;
    const notionalUsd = estimateNotionalUsd(order, result, {
      price: contract ? Number(contract.price) : null,
      contractSize: contract ? Number(contract.future_product_details?.contract_size) : null,
    });
    const violation = pitchGuardViolation(pitchGuard, order, notionalUsd);
    logEvent("order.preview.pitch_guard", { productId: order.productId, notionalUsd, maxUsd: pitchGuard.maxUsd, violation });
    if (violation) {
      const blocked = new Error(violation);
      blocked.status = 400;
      throw blocked;
    }
    guard = { ...pitchGuard, notionalUsd };
  }
  const item = previews.create({ ...order, clientOrderId: randomUUID(), ...(guard ? { pitchGuard: guard } : {}) }, result);
  logEvent("order.preview.created", { previewId: item.id, productId: order.productId, side: order.side });
  response.json({
    previewId: item.id,
    expiresAt: item.expiresAt,
    order,
    requestedQuoteSize,
    preview: result,
  });
}));

app.post("/api/orders/execute", asyncRoute(async (request, response) => {
  const previewId = String(request.body?.previewId ?? "");
  const item = previews.claim(previewId);
  // Pitch calls may only execute pitch-guarded previews, and the guard is
  // re-checked against the stored preview before anything reaches Coinbase.
  const guardError = request.body?.pitchGuard && !item.order.pitchGuard
    ? "This line can only execute orders previewed for the pitched trade."
    : pitchGuardViolation(item.order.pitchGuard, item.order, item.order.pitchGuard?.notionalUsd);
  if (guardError) {
    previews.release(previewId);
    const blocked = new Error(guardError);
    blocked.status = 400;
    throw blocked;
  }
  logEvent("order.execution.requested", {
    previewId,
    productId: item.order.productId,
    side: item.order.side,
    amount: item.order.quoteSize ?? item.order.baseSize,
  });
  try {
    const result = await trader.execute(item.order, item.order.clientOrderId);
    previews.complete(previewId, result);
    logEvent("order.execution.completed", { previewId, orderId: result.order_id ?? null });
    response.json({ previewId, order: item.order, result });
  } catch (error) {
    previews.release(previewId);
    throw error;
  }
}));

app.use((error, request, response, _next) => {
  console.error(error);
  logEvent("server.request.failed", {
    method: request.method,
    path: request.path,
    error,
  });
  response.status(error.status && error.status >= 400 ? error.status : 500).json({
    error: agentSafeX402(error.message || "Unexpected server error."),
    details: error.body ?? undefined,
  });
});

const server = app.listen(config.port, () => {
  console.log(`Voice market demo: http://localhost:${config.port}`);
  console.log(`Runtime log: ${runtimeLogPath}`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    await Promise.all([
      coinbaseMcp.close().catch((error) => console.error("Coinbase MCP shutdown failed", error)),
      agentCash.close().catch((error) => console.error("AgentCash MCP shutdown failed", error)),
      runtimeLogger.flush(),
    ]);
    process.exit(0);
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
