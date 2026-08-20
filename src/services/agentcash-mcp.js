import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const require = createRequire(import.meta.url);
const AGENTCASH_ENTRY = join(dirname(require.resolve("agentcash/package.json")), "dist/esm/index.js");
const WALLET_PATHS = [
  join(homedir(), ".agentcash", "wallet.json"),
  join(homedir(), ".agentcash", "solana-wallet.json"),
];

const EXPOSED_TOOLS = new Set([
  "fetch",
  "get_balance",
  "discover_api_endpoints",
  "check_endpoint_schema",
  "search",
  "list_accounts",
]);

async function createDefaultClient() {
  const client = new Client({ name: "coinbase-for-agents-demo", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [AGENTCASH_ENTRY, "server"],
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

async function defaultWalletRevision() {
  const revisions = await Promise.all(WALLET_PATHS.map(async (path) => {
    try {
      const details = await stat(path);
      return `${details.ino}:${details.size}:${details.mtimeMs}`;
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
  }));
  return revisions.join("|");
}

const textContent = (result) => result?.content
  ?.filter((item) => item?.type === "text" && typeof item.text === "string")
  .map((item) => item.text) || [];

const parseText = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export function parseAgentCashToolResult(result) {
  const texts = textContent(result);
  if (result?.isError) throw new Error(texts.join(" ") || "AgentCash tool call failed.");
  if (result?.structuredContent != null) return result.structuredContent;
  if (!texts.length) return result;
  const primary = parseText(texts[0]);
  if (
    texts.length === 1
    || primary == null
    || typeof primary !== "object"
    || Array.isArray(primary)
  ) return primary;
  const primaryFailed = primary.success === false
    || primary.ok === false
    || Boolean(primary.cause)
    || Number(primary.statusCode ?? primary.status) >= 400;
  if (!primaryFailed) return primary;
  const metadata = texts.slice(1).map(parseText);
  const isPaymentMetadata = (value) => value && typeof value === "object" && (
    value.payment != null
    || (value.protocol != null && value.network != null)
    || value.transactionHash != null
  );
  const paymentInfo = metadata.find(isPaymentMetadata);
  const providerError = metadata.find((value) => !isPaymentMetadata(value));
  return {
    ...primary,
    ...(providerError != null ? { providerError } : {}),
    ...(paymentInfo != null ? { paymentInfo } : {}),
    ...(
      primary.error == null
      && providerError
      && typeof providerError === "object"
      && typeof providerError.error === "string"
        ? { error: providerError.error }
        : {}
    ),
  };
}

export function normalizeAgentCashMcpResult(result) {
  if (result?.isError || result?.structuredContent != null) return result;
  return { ...result, structuredContent: parseAgentCashToolResult(result) };
}

export function preferAgentCashPayment(argumentsValue = {}) {
  if (argumentsValue.paymentProtocol != null && argumentsValue.paymentNetwork != null) {
    return argumentsValue;
  }
  return {
    ...argumentsValue,
    paymentProtocol: argumentsValue.paymentProtocol ?? "x402",
    paymentNetwork: argumentsValue.paymentNetwork ?? "base",
  };
}

export function buildAgentCashNansenRequest(symbol) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(normalizedSymbol)) {
    throw new Error("symbol must be a crypto ticker such as HYPE or BTC.");
  }
  return {
    url: "https://api.nansen.ai/api/v1/smart-money/perp-trades",
    method: "POST",
    paymentProtocol: "x402",
    paymentNetwork: "base",
    body: {
      filters: { token_symbol: normalizedSymbol },
      pagination: { page: 1, per_page: 100 },
      order_by: [{ field: "block_timestamp", direction: "DESC" }],
    },
  };
}

export function createAgentCashMcpClient({
  clientFactory = createDefaultClient,
  walletRevision = defaultWalletRevision,
} = {}) {
  let clientPromise = null;
  let clientWalletRevision = null;
  let toolsCache = null;
  let lifecycle = Promise.resolve();

  const accessClient = async () => {
    const currentWalletRevision = await walletRevision();
    if (clientPromise && clientWalletRevision !== currentWalletRevision) {
      const staleClient = await clientPromise.catch(() => null);
      clientPromise = null;
      clientWalletRevision = null;
      toolsCache = null;
      await staleClient?.close();
    }
    if (!clientPromise) {
      clientWalletRevision = currentWalletRevision;
      const pendingClient = Promise.resolve().then(() => clientFactory());
      const trackedClient = pendingClient.catch((error) => {
        if (clientPromise === trackedClient) {
          clientPromise = null;
          clientWalletRevision = null;
        }
        throw error;
      });
      clientPromise = trackedClient;
    }
    return clientPromise;
  };

  const getClient = () => {
    const operation = lifecycle.then(accessClient, accessClient);
    lifecycle = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const getTools = async () => {
    const client = await getClient();
    if (toolsCache) return toolsCache;
    const { tools = [] } = await client.listTools();
    toolsCache = tools.filter(({ name }) => EXPOSED_TOOLS.has(name));
    return toolsCache;
  };

  return {
    listTools: getTools,

    async callTool(name, argumentsValue = {}) {
      if (!EXPOSED_TOOLS.has(name)) throw new Error(`AgentCash tool is not exposed: ${name}`);
      const client = await getClient();
      if (!toolsCache) {
        const { tools = [] } = await client.listTools();
        toolsCache = tools.filter(({ name: toolName }) => EXPOSED_TOOLS.has(toolName));
      }
      const tools = toolsCache;
      if (!tools.some((item) => item.name === name)) throw new Error(`Unknown AgentCash tool: ${name}`);
      const effectiveArguments = name === "fetch"
        ? preferAgentCashPayment(argumentsValue)
        : argumentsValue;
      return client.callTool({ name, arguments: effectiveArguments });
    },

    async close() {
      const operation = lifecycle.then(async () => {
        const pendingClient = clientPromise;
        clientPromise = null;
        clientWalletRevision = null;
        toolsCache = null;
        const client = await pendingClient?.catch(() => null);
        await client?.close();
      });
      lifecycle = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
