import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { artifactSpecSchema } from "../src/shared/artifact-schema.js";
import { previewInstruction } from "../src/shared/order-preview.js";
import { x402RouterParameters } from "../src/services/realtime-tool-schemas.js";
import { captionWindow } from "./caption-window.js";
import { classifyPaidFailure, createPaidAttemptTracker } from "./paid-recovery.js";
import {
  buildSmartMoneyArtifact,
  buildToolResultArtifact,
  classifyX402Result,
  isEmptyToolResult,
  toolTitle,
  unwrapToolResult,
} from "./tool-result-artifact.js";
import {
  append,
  compact,
  percent,
  renderCandles,
  renderDepth,
  renderPolymarketArtifact,
  populateGenericArtifact,
} from "./artifact-render.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  voiceButton: $("#voiceButton"), voiceButtonText: $("#voiceButtonText"),
  status: $(".voice-state"), statusText: $("#statusText"), setupNote: $("#setupNote"),
  reportTemplate: $("#reportTemplate"), tradeTemplate: $("#tradeTemplate"), captions: $("#captions"),
  sessionControls: $("#sessionControls"), speakerButton: $("#speakerButton"), endButton: $("#endButton"),
  queueStatus: $("#queueStatus"), artifacts: $("#artifacts"), agentAudio: $("#agentAudio"),
  themeToggle: $("#themeToggle"), themeColor: $('meta[name="theme-color"]'),
};

let session = null;
let appConfig = null;
let pendingPreviewId = null;
let activeTradeEntry = null;
let runningTasks = 0;
let artifactNumber = 0;
let micHeld = false;
let speakerMuted = false;
let microphoneStream = null;
let liveCaptionRole = null;
let liveCaptionText = "";
let captionDismissTimer = null;
const paidAttemptTracker = createPaidAttemptTracker();

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  elements.themeToggle.setAttribute("aria-label", `Switch to ${nextTheme === "dark" ? "light" : "dark"} mode`);
  elements.themeToggle.title = `Switch to ${nextTheme === "dark" ? "light" : "dark"} mode`;
  elements.themeColor.content = nextTheme === "dark" ? "#080a0f" : "#f6f8fc";
}

applyTheme(document.documentElement.dataset.theme);
elements.themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  try { localStorage.setItem("coinbase-agents-theme", nextTheme); } catch { /* Theme still applies for this page. */ }
});

const cancelCaptionDismiss = () => {
  if (captionDismissTimer) window.clearTimeout(captionDismissTimer);
  captionDismissTimer = null;
};

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
};

const logVoiceTranscript = (role, text) => {
  const transcript = String(text ?? "").trim();
  if (!transcript) return;
  console.info(`[voice:${role}]`, transcript);
  fetch("/api/logs/voice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, text: transcript }),
    keepalive: true,
  }).catch(() => {});
};

const setStatus = (label, live = false) => {
  elements.statusText.textContent = label;
  elements.status.classList.toggle("live", live);
};

function appendTimelineEntry(entry, { scroll = false } = {}) {
  artifactNumber += 1;
  entry.dataset.timelinePosition = String(artifactNumber);
  elements.artifacts.hidden = false;
  document.body.classList.add("has-report");
  elements.artifacts.append(entry);
  if (scroll) entry.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return artifactNumber;
}

function clearLiveCaption() {
  cancelCaptionDismiss();
  liveCaptionRole = null;
  liveCaptionText = "";
  elements.captions.replaceChildren();
  elements.captions.hidden = true;
  document.body.classList.remove("has-captions");
}

function scheduleCaptionDismiss(delayMs) {
  cancelCaptionDismiss();
  captionDismissTimer = window.setTimeout(clearLiveCaption, delayMs);
}

function renderLiveCaption() {
  const text = captionWindow(liveCaptionText);
  if (!liveCaptionRole || !text) return;
  elements.captions.replaceChildren();
  const caption = append(elements.captions, "div", `caption caption-${liveCaptionRole}`);
  append(caption, "span", "caption-label", liveCaptionRole === "user" ? "YOU" : "MODEL");
  append(caption, "strong", "caption-text", text);
  elements.captions.hidden = false;
  document.body.classList.add("has-captions");
}

function appendLiveCaption(role, delta) {
  if (!delta) return;
  cancelCaptionDismiss();
  if (liveCaptionRole !== role) {
    liveCaptionRole = role;
    liveCaptionText = "";
  }
  liveCaptionText += delta;
  renderLiveCaption();
}

function handleTransportEvent(event) {
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    if (micHeld) appendLiveCaption("user", event.delta);
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    logVoiceTranscript("user", event.transcript);
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.failed" && liveCaptionRole === "user") {
    clearLiveCaption();
    return;
  }
  if (event.type === "response.output_audio_transcript.delta") {
    appendLiveCaption("model", event.delta);
    return;
  }
  if (event.type === "response.output_audio_transcript.done") {
    logVoiceTranscript("model", event.transcript);
    return;
  }
  if (event.type === "output_audio_buffer.stopped") {
    scheduleCaptionDismiss(1_100);
    return;
  }
  if (event.type === "output_audio_buffer.cleared") {
    clearLiveCaption();
  }
}


function renderGenericArtifact(spec, { variant = null } = {}) {
  const artifact = document.createElement("article");
  populateGenericArtifact(artifact, spec, { variant });
  const position = appendTimelineEntry(artifact, { scroll: true });
  return { id: crypto.randomUUID(), position, title: spec.title };
}

function displayToolResult({ title, source, result, spec, variant }) {
  const data = unwrapToolResult(result);
  const artifact = renderGenericArtifact(
    spec || buildToolResultArtifact({ title, source, result: data }),
    { variant },
  );
  return JSON.stringify({
    data,
    display: { displayed: true, ...artifact },
    instruction: "The completed tool result is visible. State only the most important conclusion in one short sentence.",
  });
}

function updateQueueStatus() {
  elements.queueStatus.hidden = runningTasks === 0;
  elements.queueStatus.textContent = runningTasks === 1 ? "1 artifact running" : `${runningTasks} artifacts running`;
}

function queueArtifact({
  title,
  productId,
  endpoint,
  renderer,
  loadingLabel = "fetching Coinbase…",
  sourceLabel = "Coinbase live market data",
}) {
  runningTasks += 1;
  updateQueueStatus();

  const artifact = document.createElement("article");
  artifact.className = "artifact";
  const header = append(artifact, "header", "artifact-header");
  append(header, "h2", null, title);
  const state = append(header, "span", "artifact-state", loadingLabel);
  const chart = append(artifact, "div", "chart");
  const footer = append(artifact, "footer", "artifact-footer");
  const source = append(footer, "span", null, sourceLabel);
  const timestamp = append(footer, "span", null, "queued");
  const id = crypto.randomUUID();
  const position = appendTimelineEntry(artifact);

  requestJson(endpoint, { method: "POST", body: JSON.stringify({ productId }) })
    .then((payload) => {
      renderer(chart, payload);
      state.textContent = "ready";
      state.classList.add("done");
      if (payload.spreadBps != null) source.textContent = `Coinbase live market data · ${payload.spreadBps.toFixed(2)} bps spread`;
      timestamp.textContent = new Date(payload.generatedAt).toLocaleString();
    })
    .catch((error) => {
      chart.replaceChildren();
      append(chart, "p", "artifact-error", error.message);
      state.textContent = "failed";
      state.classList.add("error");
    })
    .finally(() => {
      runningTasks -= 1;
      updateQueueStatus();
    });

  return { id, position, title };
}

function queueGenericArtifact({
  title,
  endpoint,
  body = {},
  loadingLabel = "fetching live data…",
  variant = "insight",
}) {
  runningTasks += 1;
  updateQueueStatus();

  const artifact = document.createElement("article");
  artifact.className = "artifact";
  const header = append(artifact, "header", "artifact-header");
  append(header, "h2", null, title);
  const state = append(header, "span", "artifact-state", loadingLabel);
  const placeholder = append(artifact, "div", "generic-artifact-body");
  append(placeholder, "p", "generic-subtitle", "Loading current data…");
  const id = crypto.randomUUID();
  const position = appendTimelineEntry(artifact);

  requestJson(endpoint, { method: "POST", body: JSON.stringify(body) })
    .then((payload) => {
      const spec = artifactSpecSchema.parse(payload.spec ?? payload);
      populateGenericArtifact(artifact, spec, {
        variant,
        timestamp: payload.generatedAt ? new Date(payload.generatedAt) : new Date(),
      });
    })
    .catch((error) => {
      placeholder.replaceChildren();
      append(placeholder, "p", "artifact-error", error.message);
      state.textContent = "failed";
      state.classList.add("error");
    })
    .finally(() => {
      runningTasks -= 1;
      updateQueueStatus();
    });

  return { id, position, title };
}

function renderReport(report, reportUrl) {
  const entry = elements.reportTemplate.content.firstElementChild.cloneNode(true);
  const reportTime = entry.querySelector(".report-time");
  const reportAsset = entry.querySelector(".report-asset");
  const toolTrace = entry.querySelector(".tool-trace");
  const reportSummary = entry.querySelector(".report-summary");
  const metrics = entry.querySelector(".metrics");
  const news = entry.querySelector(".news");
  const warnings = entry.querySelector(".warnings");
  const standaloneLink = entry.querySelector(".standalone-link");
  const newsOnly = report.mode === "news";
  reportTime.textContent = new Date(report.generatedAt).toLocaleString();
  reportAsset.textContent = report.asset.productId;
  reportSummary.textContent = report.summary;
  toolTrace.textContent = [
    report.market && "Coinbase spot",
    report.volume && `Coinbase ${report.volume.sampleDays} daily candles`,
    `Exa ${report.news.length} results`,
  ].filter(Boolean).join("  ·  ");
  standaloneLink.href = reportUrl;

  metrics.hidden = newsOnly;
  const metric = (label, value, detail) => {
    const node = append(metrics, "div", "metric");
    append(node, "span", null, label); append(node, "strong", null, value); append(node, "span", null, detail);
  };
  if (!newsOnly) {
    metric("Spot price", report.market ? `$${Number(report.market.price).toLocaleString()}` : "—", report.market ? `${percent(report.market.change24hPercent)} in 24h` : "unavailable");
    metric("30-day volume change", percent(report.volume?.percentChange), "compared with prior 30 days");
    metric("30-day volume", report.volume ? `${compact(report.volume.latest30)} ${report.asset.symbol}` : "—", `${report.volume?.sampleDays ?? 0} daily candles`);
  }

  report.news.slice(0, 6).forEach((item) => {
    const card = $("#newsCardTemplate").content.firstElementChild.cloneNode(true);
    card.querySelector(".source").textContent = item.source;
    const direction = card.querySelector(".direction"); direction.textContent = item.direction; direction.classList.add(item.direction);
    const headline = card.querySelector(".headline"); headline.textContent = item.title; headline.href = item.url;
    card.querySelector(".summary").textContent = item.summary || "No excerpt returned.";
    news.append(card);
  });
  if (!report.news.length) append(news, "p", "muted", "No news results returned.");

  warnings.textContent = report.warnings.length ? `Partial data: ${report.warnings.join(" · ")}` : "";
  appendTimelineEntry(entry, { scroll: true });
}

function renderPreview(payload) {
  pendingPreviewId = payload.previewId;
  const panel = elements.tradeTemplate.content.firstElementChild.cloneNode(true);
  const tradeTitle = panel.querySelector(".trade-title");
  const tradeDetails = panel.querySelector(".trade-details");
  const tradeStatus = panel.querySelector(".trade-status");
  const order = payload.order;
  const quoteCurrency = order.productId.split("-").at(-1);
  const isFutures = order.productId.endsWith("-CDE");
  const amount = payload.requestedQuoteSize != null
    ? `${payload.requestedQuoteSize} ${quoteCurrency}`
    : order.quoteSize != null
      ? `${order.quoteSize} ${quoteCurrency}`
      : isFutures
        ? `${order.baseSize} contracts`
        : `${order.baseSize} ${order.productId.split("-")[0]}`;
  const type = order.type === "stop_limit" ? "STOP LIMIT" : order.type.toUpperCase();
  tradeTitle.textContent = `${order.side} ${amount} of ${order.productId} · ${type}`;
  const estimate = payload.preview.est_average_filled_price || payload.preview.average_filled_price;
  const fee = payload.preview.commission_total;
  const liquidationPrice = payload.preview.predicted_liquidation_price;
  tradeDetails.textContent = [
    order.limitPrice && `limit $${order.limitPrice}`,
    order.stopPrice && `stop $${order.stopPrice} ${order.stopDirection}`,
    order.equityTradingSession && `session ${order.equityTradingSession.replaceAll("_", " ").toLowerCase()}`,
    estimate && (payload.preview.estimated ? `estimate ~$${estimate} (live price; Coinbase has no stock preview)` : `estimated fill $${estimate}`),
    fee && `fee $${fee}`,
    liquidationPrice && `estimated liquidation $${liquidationPrice}`,
    `expires ${new Date(payload.expiresAt).toLocaleTimeString()}`,
  ].filter(Boolean).join(" · ");
  activeTradeEntry = { panel, status: tradeStatus };
  appendTimelineEntry(panel, { scroll: true });
}

function renderExecution(payload) {
  const orderId = payload.result.order_id || payload.result.client_order_id || "submitted";
  if (activeTradeEntry) {
    activeTradeEntry.status.textContent = `Executed · ${orderId}`;
    activeTradeEntry.status.classList.add("executed");
  }
  pendingPreviewId = null;
}

const productIdSchema = z.string()
  .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/)
  .max(64)
  .describe("Exact Coinbase product ID discovered with coinbase_products_list or coinbase_products_get, for example AAPL-USD, BTC-USDC, or BIT-28AUG26-CDE");
const cryptoProductIdSchema = z.string()
  .regex(/^[A-Z0-9]{2,15}-(?:USD|USDC)$/)
  .refine((productId) => !productId.endsWith("-CDE"), "Use a spot crypto product ID, not an equity or futures product")
  .describe("Coinbase spot crypto product ID such as BTC-USD or SOL-USDC; equities and futures are not supported by this crypto-specific tool");
const newsFocusSchema = z.string().min(3).max(500)
  .describe("Focused news query. Preserve every user-provided entity, name, date, and topic instead of reducing it to only the asset symbol.");
const newsTimeframeSchema = z.enum(["today", "yesterday", "today_and_yesterday", "last_7_days", "last_30_days"])
  .describe("Publication window requested by the user.");
const newsRequestBody = ({ productId, focusQuery, timeframe }) => ({
  productId,
  focusQuery,
  timeframe,
  timezoneOffsetMinutes: new Date().getTimezoneOffset(),
});

const researchTool = tool({
  name: "research_crypto",
  description: "Combined Coinbase market/volume and Exa news research. Use only when the user asks for both market context and news. Preserve every user-provided entity, name, date, and topic in focusQuery. For a news-only request, do not call research_crypto; call search_crypto_news.",
  parameters: z.object({ productId: cryptoProductIdSchema, focusQuery: newsFocusSchema, timeframe: newsTimeframeSchema }),
  execute: async ({ productId, focusQuery, timeframe }) => {
    setStatus("researching", true);
    try {
      const payload = await requestJson("/api/research", { method: "POST", body: JSON.stringify(newsRequestBody({ productId, focusQuery, timeframe })) });
      renderReport(payload.report, payload.reportUrl);
      return JSON.stringify({ report: payload.report, instruction: "The report is visible. Give a short spoken summary grounded only in these returned values and sources." });
    } finally {
      setStatus(micHeld ? "listening" : "ready", true);
    }
  },
});

const cryptoNewsTool = tool({
  name: "search_crypto_news",
  description: "Focused news-only Exa search that does not fetch Coinbase market data. Crypto news must use search_crypto_news instead of the paid-data router. Preserve every user-provided entity, name, date, and topic in focusQuery. Use this whenever the user asks only for news, an event, a claim, or why something happened; do not call research_crypto unless they also request market or volume data.",
  parameters: z.object({ productId: cryptoProductIdSchema, focusQuery: newsFocusSchema, timeframe: newsTimeframeSchema }),
  execute: async ({ productId, focusQuery, timeframe }) => {
    setStatus("researching", true);
    try {
      const payload = await requestJson("/api/news", { method: "POST", body: JSON.stringify(newsRequestBody({ productId, focusQuery, timeframe })) });
      renderReport(payload.report, payload.reportUrl);
      return JSON.stringify({ report: payload.report, instruction: "The focused news report is visible. Give a short spoken summary grounded only in these returned sources." });
    } finally {
      setStatus(micHeld ? "listening" : "ready", true);
    }
  },
});

const polymarketTool = tool({
  name: "show_polymarket",
  description: "Polymarket-only lookup for a crypto asset. Use this when the user asks specifically for Polymarket markets, probabilities, odds, or sentiment. It calls the live Polymarket API and shows only those results; do not call or fetch research_crypto unless the user also asks for news, volume, or broader research.",
  parameters: z.object({ productId: cryptoProductIdSchema }),
  execute: async ({ productId }) => JSON.stringify({
    queued: true,
    ...queueArtifact({
      title: `${productId} · Polymarket`,
      productId,
      endpoint: "/api/artifacts/polymarket",
      renderer: renderPolymarketArtifact,
      loadingLabel: "fetching Polymarket…",
      sourceLabel: "Polymarket live markets",
    }),
    instruction: `Say only: "Added the current Polymarket markets for ${productId}."`,
  }),
});

const candleChartTool = tool({
  name: "show_candle_chart",
  description: "Add an interactive Coinbase candlestick chart for any USD crypto product using the latest 30 daily OHLCV candles. Hover or use arrow keys for exact values.",
  parameters: z.object({ productId: cryptoProductIdSchema }),
  execute: async ({ productId }) => JSON.stringify({
    queued: true,
    ...queueArtifact({
      title: `${productId} · 1 month · daily candles`,
      productId,
      endpoint: "/api/artifacts/candles",
      renderer: renderCandles,
    }),
    instruction: `Say only: "Added the one-month ${productId} chart."`,
  }),
});

const orderBookTool = tool({
  name: "show_order_book_depth",
  description: "Queue a fresh Coinbase cumulative bid and ask order-book depth artifact for any USD crypto product. It appends without replacing earlier artifacts.",
  parameters: z.object({ productId: cryptoProductIdSchema }),
  execute: async ({ productId }) => JSON.stringify({
    queued: true,
    ...queueArtifact({
      title: `${productId} · order book depth`,
      productId,
      endpoint: "/api/artifacts/order-book",
      renderer: renderDepth,
    }),
    instruction: "The live depth chart is queued and will render independently. Acknowledge briefly; do not wait for it before accepting another request.",
  }),
});

const balanceTool = tool({
  name: "check_balance",
  description: "Fetch the user's real available Coinbase balances. Use this whenever the user asks what they own, what is available to trade, or whether they can afford an order.",
  parameters: z.object({}),
  execute: async () => {
    setStatus("checking balance", true);
    try {
      const result = await requestJson("/api/balance");
      return displayToolResult({ title: "Coinbase balances", source: "Coinbase", result });
    } finally {
      setStatus(micHeld ? "listening" : "ready", true);
    }
  },
});

const smartMoneyTool = tool({
  name: "check_smart_money",
  description: "Fetch real Nansen-labeled Smart Money perpetual trades for a crypto ticker through the configured Nansen API key or x402 wallet, then calculate bullish versus bearish position-changing activity.",
  parameters: z.object({ symbol: z.string().regex(/^[A-Za-z0-9]{2,15}$/).describe("Crypto ticker such as HYPE, BTC, or SOL") }),
  execute: async ({ symbol }) => {
    setStatus("checking smart money", true);
    try {
      const result = await requestJson("/api/smart-money", {
        method: "POST",
        body: JSON.stringify({ symbol }),
      });
      return displayToolResult({
        title: `${result.symbol || symbol} smart-money activity`,
        source: result.source || "Nansen",
        result,
        spec: buildSmartMoneyArtifact(result),
        variant: "smart-money",
      });
    } finally {
      setStatus(micHeld ? "listening" : "ready", true);
    }
  },
});

const derivativesPositioningTool = tool({
  name: "show_derivatives_positioning",
  description: "Show live perpetual-market positioning for a crypto asset: mark price, funding, open interest, 24h volume, premium/crowding, seven-day funding history, and—when Nansen returns it—observed long/short positioning and positions nearest liquidation. Use only when the user asks about derivatives, perps, funding, open interest, crowding, long/short market positioning, or liquidation risk. Do not call news, Polymarket, or broader research tools unless separately requested.",
  parameters: z.object({ productId: cryptoProductIdSchema }),
  execute: async ({ productId }) => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: `${productId} · derivatives positioning`,
      endpoint: "/api/artifacts/derivatives-positioning",
      body: { productId },
      loadingLabel: "fetching derivatives…",
      variant: "derivatives",
    }),
    instruction: `Say only: "Added the live derivatives positioning for ${productId}."`,
  }),
});

const positionRiskTool = tool({
  name: "show_position_risk",
  description: "Show the user's current Coinbase portfolio allocation, concentration, open orders, leveraged positions, PnL, liquidation prices, and margin-risk fields that Coinbase actually returns. Use only for requests about the user's portfolio exposure, open-position risk, liquidation level, margin, or active orders.",
  parameters: z.object({}),
  execute: async () => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: "Coinbase portfolio risk",
      endpoint: "/api/artifacts/position-risk",
      loadingLabel: "fetching portfolio…",
      variant: "portfolio-risk",
    }),
    instruction: "Say only: \"Added your current Coinbase position-risk view.\"",
  }),
});

const tradeImpactTool = tool({
  name: "show_trade_impact",
  description: "Estimate market-order execution quality from the live Coinbase order book and account fee tier. Shows expected average price, price impact, displayed liquidity, and fees across several USD order sizes. This is analysis only and never previews or places an order. Use when the user asks about slippage, market impact, liquidity cost, market versus limit execution, or how an order size may fill.",
  parameters: z.object({
    productId: cryptoProductIdSchema,
    quoteSize: z.number().positive().max(1_000_000).describe("USD notional the user wants to evaluate"),
  }),
  execute: async ({ productId, quoteSize }) => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: `${productId} · ${quoteSize.toLocaleString()} USD execution impact`,
      endpoint: "/api/artifacts/trade-impact",
      body: { productId, quoteSize },
      loadingLabel: "measuring impact…",
      variant: "trade-impact",
    }),
    instruction: `Say only: "Added the live execution-impact estimate for ${quoteSize.toLocaleString()} dollars of ${productId}."`,
  }),
});

const onchainFlowTool = tool({
  name: "show_onchain_flows",
  description: "Show real Nansen on-chain token flows: buy/sell volume, net trading flow, liquidity, and—when available—exchange, Smart Money, whale, fresh-wallet, and top-PnL-holder flows. The server dynamically resolves the token representation; provide chain and tokenAddress only when the user supplies them or an exact contract is important. Use only for on-chain flows, exchange inflows/outflows, whale accumulation/distribution, or holder-segment movement.",
  parameters: z.object({
    productId: cryptoProductIdSchema,
    chain: z.string().max(40).nullable().describe("Nansen chain slug or null to resolve dynamically"),
    tokenAddress: z.string().max(100).nullable().describe("Exact token contract/address or null to resolve dynamically"),
  }),
  execute: async ({ productId, chain, tokenAddress }) => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: `${productId} · on-chain flows`,
      endpoint: "/api/artifacts/onchain-flows",
      body: { productId, chain, tokenAddress },
      loadingLabel: "fetching on-chain flows…",
      variant: "onchain-flows",
    }),
    instruction: `Say only: "Added the current on-chain flow view for ${productId}."`,
  }),
});

const catalystCalendarTool = tool({
  name: "show_catalyst_calendar",
  description: "Search current sources and show a source-linked calendar of explicitly dated upcoming crypto catalysts such as token unlocks, governance votes, upgrades, launches, listings, regulatory deadlines, CPI, and FOMC events. Use only when the user asks for upcoming catalysts, events, deadlines, unlocks, or a calendar. Do not add news or Polymarket artifacts unless separately requested.",
  parameters: z.object({
    productId: cryptoProductIdSchema,
    horizonDays: z.number().int().min(7).max(180).describe("Calendar horizon in days; use 90 when the user does not specify"),
  }),
  execute: async ({ productId, horizonDays }) => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: `${productId} · upcoming catalysts`,
      endpoint: "/api/artifacts/catalysts",
      body: { productId, horizonDays },
      loadingLabel: "building catalyst calendar…",
      variant: "catalysts",
    }),
    instruction: `Say only: "Added the upcoming ${productId} catalyst calendar."`,
  }),
});

const presentArtifactTool = tool({
  name: "present_artifact",
  description: "Create an alternate visual or combine completed real tool results when that adds value beyond the artifact already shown automatically. Use only returned values: metrics for compact summaries, tables for records, lists for highlights or service catalogs, cards for people and candidates with real avatars and contact/profile links, key/value panels for objects, text for conclusions, links for sources, and line or bar charts for numeric series. Never invent missing data and never duplicate an artifact that is already visible.",
  parameters: artifactSpecSchema,
  execute: async (spec) => JSON.stringify({
    displayed: true,
    ...renderGenericArtifact(spec),
    instruction: "The tool result is visible. Acknowledge it in one short sentence without reading the artifact aloud.",
  }),
});

let agentCashToolPromise = null;

const alternativeCount = (catalog) => Array.isArray(catalog?.results)
  ? catalog.results.reduce((count, provider) => count + (provider.endpoints?.length || 0), 0)
  : 0;

const discoverPaidAlternatives = (intent) => {
  if (!appConfig?.readiness?.orthogonal) return Promise.resolve(null);
  return requestJson("/api/orthogonal/discover", {
    method: "POST",
    body: JSON.stringify({
      action: "search",
      arguments: {
        prompt: `Find an API endpoint that directly returns the requested records for this task: ${intent}. Prefer searchable records and filters relevant to the request.`,
        limit: 8,
      },
    }),
  }).catch(() => null);
};

const logPaidRecovery = (payload) => fetch("/api/logs/paid-recovery", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
  keepalive: true,
}).catch(() => {});

async function loadAgentCashTool() {
  const discovery = await requestJson("/api/agentcash/tools").catch(() => null);
  if (!discovery?.connected || !discovery.tools?.length) return null;
  const catalog = discovery.tools.map(({ name, description, inputSchema }) =>
    `${name}: ${description || "No description"}\nInput schema: ${JSON.stringify(inputSchema || {})}`
  ).join("\n\n");
  return tool({
    name: "use_agentcash",
    description: `Use AgentCash for real paid or wallet-authenticated API calls. Do not use this router for crypto news; use search_crypto_news. The intent field must describe the exact records/data needed and useful filters in tool language, not merely repeat the user's conversational wording; recovery uses it to find another provider. For people/company enrichment, non-crypto web search, scraping, maps, LinkedIn, email verification, or non-crypto news, go directly to discover_api_endpoints on https://stableenrich.dev. Use https://stablesocial.dev for social data, https://stablestudio.dev for image/video generation, https://stablejobs.dev only for job postings, and https://stabletravel.dev for travel. A request to find people to hire is a people/enrichment search, not a job-posting search. Use search only when no known origin fits. Always follow discover_api_endpoints -> check_endpoint_schema -> fetch, reading endpoint instructions and exact field names before fetching. Prefer x402 on Base when the endpoint supports it, but follow an endpoint's explicit Solana, Tempo, or MPP requirement. Discovery, search, schema checks, empty results, and failed calls are internal navigation. Do not display or narrate them. On invalid arguments, correct the request using the returned validation/schema details; on an empty or broken endpoint, switch to another suitable provider. The runtime blocks identical repeated fetches. Continue until data is returned or at least two materially different attempts have failed and no suitable unused alternative remains. Never use wallet mutation, settings, bridging, or error-reporting tools. Do not narrate AgentCash or payment mechanics unless the user asks.\n\n${catalog}`,
    parameters: x402RouterParameters,
    strict: false,
    execute: async ({ toolName, arguments: argumentsValue, intent }) => {
      const endpoint = String(argumentsValue?.url ?? argumentsValue?.origin ?? "");
      const attempt = toolName === "fetch"
        ? paidAttemptTracker.register({ intent, toolName, argumentsValue })
        : { duplicate: false, attemptCount: 0, distinctEndpointCount: 0 };
      if (attempt.duplicate) {
        const alternatives = await discoverPaidAlternatives(intent);
        const alternativesFound = alternativeCount(alternatives);
        logPaidRecovery({
          intent,
          toolName,
          endpoint,
          outcome: "duplicate_blocked",
          failureKind: "unchanged_request",
          ...attempt,
          alternativeCount: alternativesFound,
        });
        return JSON.stringify({
          data: { error: "Identical paid request blocked before execution." },
          alternatives,
          display: { displayed: false },
          instruction: `Do not report failure and do not repeat this request. It is identical to an earlier attempt. ${alternativesFound ? "Choose a different provider from alternatives, inspect it with use_orthogonal_catalog details, then call use_agentcash fetch with its exact schema." : "Change the request arguments based on the prior provider error or use AgentCash discovery to choose a different endpoint."}`,
        });
      }
      const result = await requestJson("/api/agentcash/call", {
        method: "POST",
        body: JSON.stringify({ toolName, arguments: argumentsValue, intent }),
      });
      const { data, navigation, failure, empty, autoDisplay } = classifyX402Result(toolName, result);
      if (!autoDisplay) {
        const failureKind = classifyPaidFailure({ failure, empty, data });
        const alternatives = failureKind ? await discoverPaidAlternatives(intent) : null;
        const hasAlternatives = alternatives && !isEmptyToolResult(alternatives);
        logPaidRecovery({
          intent,
          toolName,
          endpoint,
          outcome: navigation ? "navigation" : "recovery_required",
          failureKind,
          ...attempt,
          alternativeCount: alternativeCount(alternatives),
        });
        return JSON.stringify({
          data: failure ? { error: failure } : data,
          alternatives,
          display: { displayed: false },
          instruction: failure || empty
            ? `This was material attempt ${attempt.attemptCount} and it ${empty ? "returned no records" : `failed (${failureKind}): ${failure}`}. Do not tell the user yet and do not display this response. ${failureKind === "invalid_request" ? "Inspect the returned validation error or expected schema and make a corrected request with changed arguments; if the provider contract is contradictory or the correction is unclear, switch providers." : "Switch to a different suitable endpoint or provider."} ${hasAlternatives ? "Relevant alternatives are included. Inspect one with use_orthogonal_catalog details, then call use_agentcash fetch using its exact x402Url or mppUrl and schema." : "Use AgentCash discovery or search to find another suitable endpoint."} Never repeat the same endpoint with unchanged arguments. Continue until requested data is returned; conclude unavailable only after at least two materially different attempts and no unused suitable alternative remains.`
            : `${navigation ? "This is internal AgentCash navigation metadata." : "This result is not displayable."} Continue to the requested data endpoint without summarizing it. Only if the user explicitly asked to see available services, call present_artifact with one concise list block containing service names and short descriptions; never use a table for the catalog.`,
        });
      }
      if (toolName === "fetch") paidAttemptTracker.clear(intent);
      logPaidRecovery({
        intent,
        toolName,
        endpoint,
        outcome: "success",
        ...attempt,
      });
      return displayToolResult({ title: toolTitle(toolName), source: "AgentCash", result });
    },
  });
}

function getAgentCashTool() {
  if (!agentCashToolPromise) {
    agentCashToolPromise = loadAgentCashTool().catch((error) => {
      agentCashToolPromise = null;
      console.error("Unable to load AgentCash tools", error);
      return null;
    });
  }
  return agentCashToolPromise;
}

function loadOrthogonalCatalogTool(agentCashTool) {
  if (!agentCashTool || !appConfig?.readiness?.orthogonal) return null;
  return tool({
    name: "use_orthogonal_catalog",
    description: "Discover additional live API providers and inspect exact endpoint schemas. This tool only discovers endpoints; it never runs or pays for them. Use action search with the user's outcome, then details for the selected api and path. Execute the returned x402Url or mppUrl only through use_agentcash fetch. Keep all catalog and schema results internal unless the user explicitly asks to see available services.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "details", "list"] },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["action", "arguments"],
      additionalProperties: false,
    },
    strict: false,
    execute: async ({ action, arguments: argumentsValue }) => {
      const result = await requestJson("/api/orthogonal/discover", {
        method: "POST",
        body: JSON.stringify({ action, arguments: argumentsValue }),
      });
      return JSON.stringify({
        data: result,
        display: { displayed: false },
        instruction: action === "details"
          ? "Internal endpoint schema. Call use_agentcash fetch with the returned x402Url or mppUrl and the exact documented method, headers, query, and body. Never call an Orthogonal run endpoint."
          : "Internal catalog navigation. Select a suitable endpoint and call use_orthogonal_catalog with action details. Do not summarize or display this catalog unless the user explicitly requested the service list.",
      });
    },
  });
}

let coinbaseToolsPromise = null;

function loadCoinbaseTools() {
  if (!coinbaseToolsPromise) {
    coinbaseToolsPromise = requestJson("/api/coinbase/tools")
      .then((discovery) => {
        if (!discovery?.connected || !discovery.tools?.length) return [];
        return discovery.tools.map(({ name, description, inputSchema }) => tool({
          name,
          description,
          parameters: inputSchema || { type: "object", properties: {} },
          strict: false,
          execute: async (argumentsValue) => {
            const result = await requestJson("/api/coinbase/call", {
              method: "POST",
              body: JSON.stringify({ toolName: name, arguments: argumentsValue }),
            });
            return displayToolResult({ title: `Coinbase ${toolTitle(name)}`, source: "Coinbase", result });
          },
        }));
      })
      .catch((error) => {
        coinbaseToolsPromise = null;
        console.error("Unable to load Coinbase tools", error);
        return [];
      });
  }
  return coinbaseToolsPromise;
}

const previewOrderTool = tool({
  name: "preview_order",
  description: "Get a real Coinbase preview for a spot, equity, or futures market, limit, or stop-limit order, then ask for explicit confirmation. Set amountType to quote for a quote-currency amount or base for shares, contracts, or base-asset units. Futures always use base. The server converts priced quote amounts and quantizes them to Coinbase's live increment; do not calculate or convert a quote amount to base size yourself. Extended-hours equities require a whole-share limit order and equityTradingSession.",
  parameters: z.object({
    productId: productIdSchema,
    side: z.enum(["BUY", "SELL"]),
    type: z.enum(["market", "limit", "stop_limit"]),
    amount: z.number().positive().describe("Amount in the unit selected by amountType"),
    amountType: z.enum(["quote", "base"]).describe("quote for dollars/USDC; base for shares, futures contracts, or base-asset units"),
    limitPrice: z.number().positive().nullable(),
    stopPrice: z.number().positive().nullable(),
    stopDirection: z.enum(["up", "down"]).nullable(),
    equityTradingSession: z.enum(["PRE_MARKET", "AFTER_HOURS", "OVERNIGHT", "MULTI_SESSION"]).nullable(),
  }),
  execute: async ({ productId, side, type, amount, amountType, limitPrice, stopPrice, stopDirection, equityTradingSession }) => {
    const order = {
      productId,
      side,
      type,
      ...(amountType === "quote" ? { quoteSize: String(amount) } : { baseSize: String(amount) }),
      ...(limitPrice == null ? {} : { limitPrice: String(limitPrice) }),
      ...(stopPrice == null ? {} : { stopPrice: String(stopPrice) }),
      ...(stopDirection == null ? {} : { stopDirection }),
      ...(equityTradingSession == null ? {} : { equityTradingSession }),
    };
    const payload = await requestJson("/api/orders/preview", { method: "POST", body: JSON.stringify(order) });
    renderPreview(payload);
    return JSON.stringify({ ...payload, instruction: previewInstruction(payload) });
  },
});

const executeOrderTool = tool({
  name: "execute_order",
  description: "Execute the exact pending Coinbase preview only after the user's newest utterance explicitly confirms it.",
  parameters: z.object({ previewId: z.string().uuid() }),
  execute: async ({ previewId }) => {
    if (!pendingPreviewId || previewId !== pendingPreviewId) throw new Error("This is not the currently displayed preview. Preview the order again.");
    if (activeTradeEntry) activeTradeEntry.status.textContent = "Executing…";
    const payload = await requestJson("/api/orders/execute", { method: "POST", body: JSON.stringify({ previewId }) });
    renderExecution(payload);
    return JSON.stringify(payload);
  },
});

async function startSession() {
  elements.voiceButton.disabled = true;
  let candidate = null;
  try {
    clearLiveCaption();
    setStatus("allow microphone");
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setStatus("connecting");
    const [{ value }, agentCashTool, coinbaseTools] = await Promise.all([
      requestJson("/api/realtime-token", { method: "POST", body: "{}" }),
      getAgentCashTool(),
      loadCoinbaseTools(),
    ]);
    const orthogonalCatalogTool = loadOrthogonalCatalogTool(agentCashTool);
    const agent = new RealtimeAgent({
      name: "Coinbase for Agents",
      instructions: appConfig.agentInstructions,
      tools: [
        researchTool,
        cryptoNewsTool,
        polymarketTool,
        candleChartTool,
        orderBookTool,
        balanceTool,
        smartMoneyTool,
        derivativesPositioningTool,
        positionRiskTool,
        tradeImpactTool,
        onchainFlowTool,
        catalystCalendarTool,
        presentArtifactTool,
        ...(agentCashTool ? [agentCashTool] : []),
        ...(orthogonalCatalogTool ? [orthogonalCatalogTool] : []),
        ...coinbaseTools,
        previewOrderTool,
        executeOrderTool,
      ],
    });
    const transport = new OpenAIRealtimeWebRTC({
      audioElement: elements.agentAudio,
      mediaStream: microphoneStream,
    });
    candidate = new RealtimeSession(agent, {
      model: appConfig.realtimeModel,
      transport,
      config: {
        outputModalities: ["audio"], parallelToolCalls: true, reasoning: { effort: "low" },
        audio: { input: { transcription: { model: "gpt-realtime-whisper" }, turnDetection: { type: "semantic_vad", eagerness: "medium", createResponse: true, interruptResponse: true } }, output: { voice: appConfig.realtimeVoice } },
      },
    });
    candidate.on("transport_event", handleTransportEvent);
    candidate.on("error", (event) => { console.error(event); setStatus("error"); });
    candidate.on("audio_start", () => {
      if (liveCaptionRole === "user") clearLiveCaption();
      setStatus(speakerMuted ? "agent speaking · muted" : "agent speaking", true);
    });
    candidate.on("audio_stopped", () => {
      // response.output_audio.done can arrive before WebRTC finishes playing its buffer.
      // The transport's output_audio_buffer.stopped event clears sooner when available.
      scheduleCaptionDismiss(5_000);
      setStatus(micHeld ? "listening" : "ready", true);
    });
    candidate.on("audio_interrupted", () => {
      clearLiveCaption();
      setStatus(micHeld ? "listening" : "ready", true);
    });
    await candidate.connect({ apiKey: value });
    candidate.mute(true);
    session = candidate;
    micHeld = false;
    setStatus("ready", true);
    elements.voiceButton.classList.add("active", "connected");
    elements.voiceButtonText.textContent = "Hold to talk";
    elements.voiceButton.setAttribute("aria-label", "Hold to talk");
    elements.voiceButton.blur();
    elements.sessionControls.hidden = false;
  } catch (error) {
    candidate?.close();
    microphoneStream?.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
    session = null;
    throw error;
  } finally {
    elements.voiceButton.disabled = false;
  }
}

function stopSession() {
  session?.close(); session = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  micHeld = false;
  speakerMuted = false;
  clearLiveCaption();
  elements.agentAudio.muted = false;
  elements.agentAudio.srcObject = null;
  setStatus("offline");
  elements.voiceButton.classList.remove("active", "connected", "speaking");
  elements.voiceButtonText.textContent = "Start voice";
  elements.voiceButton.setAttribute("aria-label", "Start voice");
  elements.speakerButton.textContent = "Mute agent";
  elements.speakerButton.classList.remove("muted");
  elements.sessionControls.hidden = true;
}

elements.voiceButton.addEventListener("click", async () => {
  if (session) return;
  try { await startSession(); } catch (error) { console.error(error); setStatus("error"); elements.setupNote.textContent = error.message; }
});

function beginTalk() {
  if (!session || micHeld) return;
  clearLiveCaption();
  micHeld = true;
  session.mute(false);
  elements.voiceButton.classList.add("speaking");
  setStatus("listening", true);
}

function endTalk() {
  if (!session || !micHeld) return;
  micHeld = false;
  session.mute(true);
  clearLiveCaption();
  elements.voiceButton.classList.remove("speaking");
  setStatus("working", true);
}

elements.voiceButton.addEventListener("pointerdown", (event) => {
  if (!session) return;
  event.preventDefault();
  elements.voiceButton.setPointerCapture?.(event.pointerId);
  beginTalk();
});
elements.voiceButton.addEventListener("pointerup", endTalk);
elements.voiceButton.addEventListener("pointercancel", endTalk);

elements.speakerButton.addEventListener("click", () => {
  speakerMuted = !speakerMuted;
  elements.agentAudio.muted = speakerMuted;
  elements.speakerButton.textContent = speakerMuted ? "Unmute agent" : "Mute agent";
  elements.speakerButton.classList.toggle("muted", speakerMuted);
});

elements.endButton.addEventListener("click", stopSession);

window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || !session) return;
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(document.activeElement?.tagName) && document.activeElement !== elements.voiceButton) return;
  event.preventDefault();
  beginTalk();
});
window.addEventListener("keyup", (event) => {
  if (event.code !== "Space" || !session) return;
  event.preventDefault();
  endTalk();
});

async function init() {
  appConfig = await requestJson("/api/config");
  const missing = [];
  if (!appConfig.readiness.openAi) missing.push("OPENAI_API_KEY");
  if (!appConfig.readiness.exa) missing.push("EXA_API_KEY");
  if (!appConfig.readiness.coinbase) missing.push("COINBASE_KEY_ID and COINBASE_KEY_SECRET");
  elements.setupNote.textContent = missing.length ? `Missing: ${missing.join(", ")}` : "";
}

init().catch((error) => { elements.setupNote.textContent = error.message; });
