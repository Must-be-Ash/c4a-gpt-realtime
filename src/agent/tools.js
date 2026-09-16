// Shared server-side tool registry.
//
// The browser (public/app.js) defines the agent's tools and executes them by
// calling this server's REST endpoints. The hosted phone path (Vapi -> OpenAI
// Realtime) reuses the SAME endpoints through this registry: Vapi sends a
// `tool-calls` webhook, we look the tool up here, run it, emit any artifact to
// the dashboard, and return a compact string for the model to speak.
//
// See src/agent/TOOL_MAP.md for the tool -> endpoint mapping.

import { artifactSpecSchema } from "../shared/artifact-schema.js";
import { x402RouterParameters } from "../services/realtime-tool-schemas.js";
import { previewInstruction } from "../shared/order-preview.js";

// ── JSON Schema fragments (mirror the zod schemas in public/app.js) ──
const cryptoProductId = {
  type: "string",
  pattern: "^[A-Z0-9]{2,15}-(?:USD|USDC)$",
  description: "Coinbase spot crypto product ID such as BTC-USD or SOL-USDC (not equities or -CDE futures).",
};
const orderProductId = {
  type: "string",
  pattern: "^[A-Z0-9]+(?:-[A-Z0-9]+)+$",
  maxLength: 64,
  description: "Exact Coinbase product ID, e.g. AAPL-USD, BTC-USDC, or BIT-28AUG26-CDE.",
};
const newsFocus = {
  type: "string",
  minLength: 3,
  maxLength: 500,
  description: "Focused news query. Preserve every user-provided entity, name, date, and topic; do not reduce to only the asset symbol.",
};
const newsTimeframe = {
  type: "string",
  enum: ["today", "yesterday", "today_and_yesterday", "last_7_days", "last_30_days"],
  description: "Publication window requested by the user.",
};
const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const str = (value) => (value == null ? value : String(value));

// Build the order body the way public/app.js does for preview_order.
const buildOrderBody = (args) => ({
  productId: args.productId,
  side: args.side,
  type: args.type,
  ...(args.amountType === "quote" ? { quoteSize: str(args.amount) } : { baseSize: str(args.amount) }),
  ...(args.limitPrice == null ? {} : { limitPrice: str(args.limitPrice) }),
  ...(args.stopPrice == null ? {} : { stopPrice: str(args.stopPrice) }),
  ...(args.stopDirection == null ? {} : { stopDirection: args.stopDirection }),
  ...(args.equityTradingSession == null ? {} : { equityTradingSession: args.equityTradingSession }),
});

// ── Static tool definitions. `run(args, ctx, helpers)` returns a string the
//    realtime model speaks from; `helpers.call` hits a local REST endpoint. ──
const STATIC_TOOLS = [
  {
    name: "research_crypto",
    description: "Combined Coinbase market/volume and Exa news research. Use only when the user asks for both market context and news. For a news-only request, call search_crypto_news instead.",
    parameters: obj({ productId: cryptoProductId, focusQuery: newsFocus, timeframe: newsTimeframe }, ["productId", "focusQuery", "timeframe"]),
    async run(args, ctx, { call }) {
      const payload = await call("/api/research", { method: "POST", body: newsBody(args) });
      ctx.emit?.({ kind: "report", title: `${args.productId} · research`, report: payload.report, reportUrl: payload.reportUrl });
      return JSON.stringify({ report: payload.report, instruction: "The report is visible on the dashboard. Give a short spoken summary grounded only in these returned values and sources." });
    },
  },
  {
    name: "search_crypto_news",
    description: "Focused news-only Exa search (no Coinbase market data). Use whenever the user asks only for news, an event, a claim, or why something happened.",
    parameters: obj({ productId: cryptoProductId, focusQuery: newsFocus, timeframe: newsTimeframe }, ["productId", "focusQuery", "timeframe"]),
    async run(args, ctx, { call }) {
      const payload = await call("/api/news", { method: "POST", body: newsBody(args) });
      ctx.emit?.({ kind: "report", title: `${args.productId} · news`, report: payload.report, reportUrl: payload.reportUrl });
      return JSON.stringify({ report: payload.report, instruction: "The focused news report is visible. Give a short spoken summary grounded only in these returned sources." });
    },
  },
  {
    name: "show_polymarket",
    description: "Polymarket-only lookup for a crypto asset (markets, probabilities, odds, sentiment).",
    parameters: obj({ productId: cryptoProductId }, ["productId"]),
    async run(args, ctx, { call }) {
      const data = await call("/api/artifacts/polymarket", { method: "POST", body: { productId: args.productId } });
      ctx.emit?.({ kind: "artifact", variant: "polymarket", title: `${args.productId} · Polymarket`, data });
      return `Say only: "Added the current Polymarket markets for ${args.productId}."`;
    },
  },
  {
    name: "show_candle_chart",
    description: "Add an interactive Coinbase candlestick chart (latest 30 daily OHLCV candles) for a USD crypto product.",
    parameters: obj({ productId: cryptoProductId }, ["productId"]),
    async run(args, ctx, { call }) {
      const data = await call("/api/artifacts/candles", { method: "POST", body: { productId: args.productId } });
      ctx.emit?.({ kind: "artifact", variant: "candles", title: `${args.productId} · 1 month · daily candles`, data });
      return `Say only: "Added the one-month ${args.productId} chart."`;
    },
  },
  {
    name: "show_order_book_depth",
    description: "Add a fresh Coinbase cumulative bid/ask order-book depth chart for a USD crypto product.",
    parameters: obj({ productId: cryptoProductId }, ["productId"]),
    async run(args, ctx, { call }) {
      const data = await call("/api/artifacts/order-book", { method: "POST", body: { productId: args.productId } });
      ctx.emit?.({ kind: "artifact", variant: "order-book", title: `${args.productId} · order book depth`, data });
      return `Say only: "Added the ${args.productId} order-book depth."`;
    },
  },
  {
    name: "check_balance",
    description: "Fetch the user's real available Coinbase balances. Use when the user asks what they own, what's available to trade, or whether they can afford an order.",
    parameters: obj({}),
    async run(_args, ctx, { call }) {
      const result = await call("/api/balance");
      ctx.emit?.({ kind: "balance", title: "Coinbase balances", data: result });
      return JSON.stringify({ result, instruction: "Read back the available balances concisely." });
    },
  },
  {
    name: "check_smart_money",
    description: "Fetch real Nansen-labeled Smart Money perpetual trades for a crypto ticker and summarize bullish vs bearish position-changing activity.",
    parameters: obj({ symbol: { type: "string", pattern: "^[A-Za-z0-9]{2,15}$", description: "Crypto ticker such as HYPE, BTC, or SOL." } }, ["symbol"]),
    async run(args, ctx, { call }) {
      const result = await call("/api/smart-money", { method: "POST", body: { symbol: args.symbol } });
      ctx.emit?.({ kind: "artifact", variant: "smart-money", title: `${result.symbol || args.symbol} smart-money activity`, data: result });
      return JSON.stringify({ result, instruction: "Give a one-sentence spoken read of the smart-money lean grounded only in these values." });
    },
  },
  {
    name: "show_derivatives_positioning",
    description: "Show live perpetual-market positioning for a crypto asset: mark price, funding, open interest, 24h volume, premium/crowding, funding history, and (when available) long/short positioning and liquidation proximity.",
    parameters: obj({ productId: cryptoProductId }, ["productId"]),
    async run(args, ctx, { call }) {
      const data = await call("/api/artifacts/derivatives-positioning", { method: "POST", body: { productId: args.productId } });
      ctx.emit?.({ kind: "artifact", variant: "derivatives", title: `${args.productId} · derivatives positioning`, data });
      return `Say only: "Added the live derivatives positioning for ${args.productId}."`;
    },
  },
  {
    name: "show_position_risk",
    description: "Show the user's current Coinbase portfolio allocation, concentration, open orders, leveraged positions, PnL, liquidation prices, and margin-risk fields.",
    parameters: obj({}),
    async run(_args, ctx, { call }) {
      const data = await call("/api/artifacts/position-risk", { method: "POST", body: {} });
      ctx.emit?.({ kind: "artifact", variant: "portfolio-risk", title: "Coinbase portfolio risk", data });
      return 'Say only: "Added your current Coinbase position-risk view."';
    },
  },
  {
    name: "show_trade_impact",
    description: "Estimate market-order execution quality from the live Coinbase order book and account fee tier (expected average price, price impact, displayed liquidity, fees). Analysis only; never previews or places an order.",
    parameters: obj({ productId: cryptoProductId, quoteSize: { type: "number", exclusiveMinimum: 0, maximum: 1000000, description: "USD notional to evaluate." } }, ["productId", "quoteSize"]),
    async run(args, ctx, { call }) {
      const data = await call("/api/artifacts/trade-impact", { method: "POST", body: { productId: args.productId, quoteSize: args.quoteSize } });
      ctx.emit?.({ kind: "artifact", variant: "trade-impact", title: `${args.productId} · ${args.quoteSize} USD execution impact`, data });
      return `Say only: "Added the live execution-impact estimate for ${args.quoteSize} dollars of ${args.productId}."`;
    },
  },
  {
    name: "show_onchain_flows",
    description: "Show real Nansen on-chain token flows (buy/sell volume, net flow, liquidity, and when available exchange/Smart Money/whale/fresh-wallet/top-PnL flows). Provide chain/tokenAddress only when the user supplies them.",
    parameters: obj({
      productId: cryptoProductId,
      chain: { type: ["string", "null"], maxLength: 40, description: "Nansen chain slug or null to resolve dynamically." },
      tokenAddress: { type: ["string", "null"], maxLength: 100, description: "Exact token contract/address or null to resolve dynamically." },
    }, ["productId"]),
    async run(args, ctx, { call }) {
      const data = await call("/api/artifacts/onchain-flows", { method: "POST", body: { productId: args.productId, chain: args.chain ?? null, tokenAddress: args.tokenAddress ?? null } });
      ctx.emit?.({ kind: "artifact", variant: "onchain-flows", title: `${args.productId} · on-chain flows`, data });
      return `Say only: "Added the current on-chain flow view for ${args.productId}."`;
    },
  },
  {
    name: "show_catalyst_calendar",
    description: "Search current sources and show a source-linked calendar of explicitly dated upcoming crypto catalysts (unlocks, votes, upgrades, launches, listings, regulatory deadlines, CPI, FOMC).",
    parameters: obj({ productId: cryptoProductId, horizonDays: { type: "integer", minimum: 7, maximum: 180, description: "Calendar horizon in days; use 90 when unspecified." } }, ["productId", "horizonDays"]),
    async run(args, ctx, { call }) {
      const data = await call("/api/artifacts/catalysts", { method: "POST", body: { productId: args.productId, horizonDays: args.horizonDays } });
      ctx.emit?.({ kind: "artifact", variant: "catalysts", title: `${args.productId} · upcoming catalysts`, data });
      return `Say only: "Added the upcoming ${args.productId} catalyst calendar."`;
    },
  },
  {
    name: "present_artifact",
    description: "Create an alternate visual or combine completed real tool results when that adds value. Use only returned values; never invent data and never duplicate a visible artifact.",
    parameters: { type: "object", additionalProperties: true, description: "An artifact spec (see artifactSpecSchema): title plus blocks of type metrics/table/list/cards/keyvalue/text/links/line/bar." },
    async run(args, ctx) {
      const spec = artifactSpecSchema.parse(args);
      ctx.emit?.({ kind: "artifact", variant: "custom", title: spec.title, data: { spec } });
      return "The artifact is visible on the dashboard. Acknowledge it in one short sentence without reading it aloud.";
    },
  },
  {
    name: "use_agentcash",
    description: "Use AgentCash for real paid or wallet-authenticated API calls. Do not use for crypto news (use search_crypto_news). Follow discover_api_endpoints -> check_endpoint_schema -> fetch. Prefer x402 on Base. Keep discovery/schema/empty/failed calls internal; do not narrate payment mechanics unless asked.",
    parameters: x402RouterParameters,
    strict: false,
    async run(args, _ctx, { call }) {
      const result = await call("/api/agentcash/call", { method: "POST", body: { toolName: args.toolName, arguments: args.arguments, intent: args.intent } });
      return JSON.stringify({ data: result, instruction: "Use the returned records to answer. If empty or failed, try a materially different provider before concluding unavailable. Do not narrate payment mechanics." });
    },
  },
  {
    name: "use_orthogonal_catalog",
    description: "Discover additional live API providers and inspect exact endpoint schemas. Discovery only; never runs or pays. Execute returned x402Url/mppUrl only via use_agentcash fetch. Keep results internal unless the user asks to see services.",
    parameters: obj({ action: { type: "string", enum: ["search", "details", "list"] }, arguments: { type: "object", additionalProperties: true } }, ["action", "arguments"]),
    strict: false,
    async run(args, _ctx, { call }) {
      const result = await call("/api/orthogonal/discover", { method: "POST", body: { action: args.action, arguments: args.arguments } });
      return JSON.stringify({ data: result, instruction: "Internal catalog navigation. Select an endpoint and call use_agentcash fetch with its exact schema. Do not display unless the user asked for the service list." });
    },
  },
  {
    name: "preview_order",
    description: "Get a Coinbase preview for a spot, equity, or futures order (stock previews are an estimate at the live price because Coinbase has no stock preview yet), then read it back and ask for explicit spoken confirmation before executing. amountType 'quote' for dollars/USDC, 'base' for shares/contracts/base units (futures always base). The server quantizes to Coinbase's live increment.",
    parameters: obj({
      productId: orderProductId,
      side: { type: "string", enum: ["BUY", "SELL"] },
      type: { type: "string", enum: ["market", "limit", "stop_limit"] },
      amount: { type: "number", exclusiveMinimum: 0, description: "Amount in the unit selected by amountType." },
      amountType: { type: "string", enum: ["quote", "base"] },
      limitPrice: { type: ["number", "null"], exclusiveMinimum: 0 },
      stopPrice: { type: ["number", "null"], exclusiveMinimum: 0 },
      stopDirection: { type: ["string", "null"], enum: ["up", "down"] },
      equityTradingSession: { type: ["string", "null"], enum: ["PRE_MARKET", "AFTER_HOURS", "OVERNIGHT", "MULTI_SESSION"] },
    }, ["productId", "side", "type", "amount", "amountType"]),
    async run(args, ctx, { call }) {
      // Pitch calls carry a server-side guard from call context (never from args).
      const body = { ...buildOrderBody(args), ...(ctx.pitchGuard ? { pitchGuard: ctx.pitchGuard } : {}) };
      const payload = await call("/api/orders/preview", { method: "POST", body });
      ctx.emit?.({ kind: "preview", title: "Order preview", data: payload });
      return JSON.stringify({ ...payload, instruction: `${previewInstruction(payload)} Ask out loud and wait for the spoken confirmation.` });
    },
  },
  {
    name: "execute_order",
    description: "Execute the exact pending Coinbase preview only after the user's newest utterance explicitly confirms it.",
    parameters: obj({ previewId: { type: "string", description: "The previewId returned by preview_order." } }, ["previewId"]),
    async run(args, ctx, { call }) {
      const payload = await call("/api/orders/execute", { method: "POST", body: { previewId: args.previewId, ...(ctx.pitchGuard ? { pitchGuard: true } : {}) } });
      ctx.emit?.({ kind: "execution", title: "Order executed", data: payload });
      return JSON.stringify(payload);
    },
  },
];

const newsBody = ({ productId, focusQuery, timeframe }) => ({ productId, focusQuery, timeframe, timezoneOffsetMinutes: 0 });

/**
 * Build the shared tool registry.
 * @param {object} opts
 * @param {string} opts.baseUrl  Base URL of this server, e.g. http://127.0.0.1:4173
 * @param {typeof fetch} [opts.fetchImpl]  Injectable fetch (for tests).
 */
export function buildToolRegistry({ baseUrl, fetchImpl = fetch, headers = {} } = {}) {
  if (!baseUrl) throw new Error("buildToolRegistry requires baseUrl.");
  const byName = new Map(STATIC_TOOLS.map((t) => [t.name, t]));

  async function call(path, { method = "GET", body } = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      throw new Error(data?.error || `Request to ${path} failed (${response.status}).`);
    }
    return data;
  }

  // Static definitions in OpenAI/Vapi tool shape.
  const staticDefinitions = STATIC_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

  // Run a tool by name. Coinbase MCP tools (coinbase_*) are proxied dynamically.
  async function execute(name, args = {}, ctx = {}) {
    const tool = byName.get(name);
    if (tool) return tool.run(args ?? {}, ctx, { call });
    if (typeof name === "string" && name.startsWith("coinbase_")) {
      const result = await call("/api/coinbase/call", { method: "POST", body: { toolName: name, arguments: args ?? {} } });
      return JSON.stringify({ result, instruction: "Use the returned Coinbase data to answer concisely." });
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  // Full definition list = static tools + live Coinbase MCP tools (fetched now).
  async function listDefinitions() {
    let coinbase = [];
    try {
      const discovery = await call("/api/coinbase/tools");
      coinbase = (discovery?.tools ?? []).map(({ name, description, inputSchema }) => ({
        name,
        description,
        parameters: inputSchema || { type: "object", properties: {} },
      }));
    } catch {
      coinbase = [];
    }
    return [...staticDefinitions, ...coinbase];
  }

  return { execute, listDefinitions, staticDefinitions, byName, call };
}

export { STATIC_TOOLS };
