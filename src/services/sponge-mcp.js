const DEFAULT_ENDPOINT = "https://api.wallet.paysponge.com/mcp";
const PROTOCOL_VERSION = "2025-03-26";
const HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const PROVIDER_NAME_PATTERN = /\b(?:paysponge|sponge)\b/gi;

const redactProviderText = (value) => {
  let redacted = "";
  let cursor = 0;
  value.replace(HTTP_URL_PATTERN, (url, offset) => {
    redacted += value.slice(cursor, offset).replace(PROVIDER_NAME_PATTERN, "x402 provider");
    redacted += url;
    cursor = offset + url.length;
    return url;
  });
  return redacted + value.slice(cursor).replace(PROVIDER_NAME_PATTERN, "x402 provider");
};

export const agentSafeX402 = (value) => {
  if (typeof value === "string") return redactProviderText(value);
  if (Array.isArray(value)) return value.map(agentSafeX402);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, agentSafeX402(item)]));
  }
  return value;
};

const ENABLED_TOOLS = new Set([
  "get_balance",
  "discover_services",
  "get_service",
  "get_openapi_spec",
  "paid_fetch",
]);

export function buildNansenSmartMoneyRequest(symbol) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(normalizedSymbol)) {
    throw new Error("symbol must be a crypto ticker such as HYPE or BTC.");
  }
  return {
    url: "https://api.nansen.ai/api/v1/smart-money/perp-trades",
    method: "POST",
    protocol: "x402",
    chain: "base",
    body: {
      filters: { token_symbol: normalizedSymbol },
      pagination: { page: 1, per_page: 100 },
      order_by: [{ field: "block_timestamp", direction: "DESC" }],
    },
  };
}

export function parseSpongeTextResult(result) {
  const text = result?.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
  if (result?.isError) throw new Error(text || "x402 tool call failed.");
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  if (!text) throw new Error("The x402 tool did not return a text result.");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("The x402 tool returned invalid JSON.");
  }
  if (payload.ok === false) {
    const error = new Error(payload.hint || payload.error || `x402 paid request failed (${payload.status ?? "unknown"}).`);
    error.status = payload.status;
    throw error;
  }
  return payload;
}

const errorFrom = async (response) => {
  const payload = await response.json().catch(() => ({}));
  const error = new Error(payload?.error?.message || payload?.error || `x402 provider request failed (${response.status}).`);
  error.status = response.status;
  return error;
};

export function createSpongeMcpClient({
  apiKey,
  endpoint = DEFAULT_ENDPOINT,
  fetchFn = fetch,
} = {}) {
  let sessionId = null;
  let initialized = false;
  let initializePromise = null;
  let toolsCache = null;
  let requestId = 0;

  const post = async (message) => {
    if (!apiKey) throw new Error("SPONGE_API_KEY is not configured on the server.");
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw await errorFrom(response);
    sessionId ||= response.headers.get("mcp-session-id");
    if (!message.id) return null;
    const payload = await response.json();
    if (payload.error) {
      const error = new Error(payload.error.message || "The x402 provider returned an error.");
      error.code = payload.error.code;
      throw error;
    }
    return payload.result;
  };

  const initialize = async () => {
    if (initialized) return;
    if (!initializePromise) {
      initializePromise = (async () => {
        try {
          await post({
            jsonrpc: "2.0",
            id: ++requestId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "coinbase-for-agents-demo", version: "0.1.0" },
            },
          });
          if (!sessionId) throw new Error("The x402 provider did not return a session ID.");
          await post({ jsonrpc: "2.0", method: "notifications/initialized" });
          initialized = true;
        } catch (error) {
          sessionId = null;
          initialized = false;
          toolsCache = null;
          throw error;
        }
      })().finally(() => { initializePromise = null; });
    }
    await initializePromise;
  };

  return {
    async listTools() {
      await initialize();
      if (toolsCache) return toolsCache;
      const result = await post({ jsonrpc: "2.0", id: ++requestId, method: "tools/list", params: {} });
      toolsCache = (result.tools || []).filter(({ name }) => ENABLED_TOOLS.has(name));
      return toolsCache;
    },

    async callTool(name, argumentsValue = {}) {
      if (!ENABLED_TOOLS.has(name)) throw new Error(`x402 tool is not enabled for this demo: ${name}`);
      await initialize();
      return post({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: argumentsValue },
      });
    },
  };
}
