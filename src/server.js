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
import {
  agentSafeX402,
  createSpongeMcpClient,
} from "./services/sponge-mcp.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDirectory = join(root, "reports");
const runtimeLogPath = join(root, "runtime", "events.jsonl");
const agentInstructions = await readFile(join(root, "AGENT.md"), "utf8");
const app = express();
const previews = new PreviewStore({ ttlMs: config.previewTtlMs });
const trader = createCoinbaseTrader();
const coinbaseMcp = createCoinbaseMcpClient();
const agentCash = createAgentCashMcpClient();
const orthogonal = createOrthogonalDiscoveryClient({ apiKey: config.orthogonalApiKey });
const sponge = createSpongeMcpClient({ apiKey: config.spongeApiKey });
const runtimeLogger = createRuntimeLogger({ filePath: runtimeLogPath });

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
app.use(express.json({ limit: "100kb" }));
app.use("/reports", express.static(reportsDirectory));
app.get("/skill", (_request, response) => {
  response.set({
    "cache-control": "public, max-age=300",
    "content-type": "text/markdown; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.sendFile(join(root, "public", "skill"));
});
app.use(express.static(join(root, "public")));

const asyncRoute = (handler) => async (request, response, next) => {
  try {
    await handler(request, response);
  } catch (error) {
    next(error);
  }
};

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
    ...summarizeSmartMoney(paid.data ?? paid, symbol),
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
  } = await prepareOrderForPreview(request.body ?? {}, { getProduct });
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
  let preview;
  try {
    preview = await trader.preview(requestedOrder);
  } catch (error) {
    if (!/insufficient fund/i.test(error.message)) throw error;
    const balances = await trader.balance().catch(() => null);
    const enriched = new Error(describeInsufficientFunds(requestedOrder, balances), { cause: error });
    enriched.status = 400;
    throw enriched;
  }
  const { order, result } = preview;
  const item = previews.create({ ...order, clientOrderId: randomUUID() }, result);
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
