import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const X402_TOOL = /^coinbase_x402(?:_|$)/;
const X402_HELPERS = new Set(["coinbase_help", "coinbase_template"]);

const containsX402 = (value) => {
  if (typeof value === "string") return /(^|[^a-z0-9])x402([^a-z0-9]|$)/i.test(value);
  if (Array.isArray(value)) return value.some(containsX402);
  if (value && typeof value === "object") return Object.values(value).some(containsX402);
  return false;
};

const isBlockedX402Call = (name, argumentsValue = {}) =>
  X402_TOOL.test(name) || (X402_HELPERS.has(name) && containsX402(argumentsValue));

async function createDefaultClient({ env }) {
  const client = new Client({ name: "coinbase-for-agents-demo", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "coinbase",
    args: ["mcp"],
    env: {
      ...env,
      COINBASE_ENV: env.COINBASE_ENV || "live",
      COINBASE_NO_HISTORY: "1",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

export function createCoinbaseMcpClient({
  env = process.env,
  clientFactory = createDefaultClient,
} = {}) {
  let clientPromise = null;
  let toolsCache = null;

  const getClient = () => {
    if (!clientPromise) {
      clientPromise = clientFactory({ env }).catch((error) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  };

  const getTools = async () => {
    if (toolsCache) return toolsCache;
    const client = await getClient();
    const result = await client.listTools();
    toolsCache = (result.tools || []).filter(({ name }) => !X402_TOOL.test(name));
    return toolsCache;
  };

  return {
    listTools: getTools,

    async callTool(name, argumentsValue = {}) {
      if (isBlockedX402Call(name, argumentsValue)) {
        throw new Error("Coinbase x402 tools are not exposed. Use the dedicated x402 tool instead.");
      }
      const tools = await getTools();
      if (!tools.some((item) => item.name === name)) throw new Error(`Unknown Coinbase tool: ${name}`);
      return (await getClient()).callTool({ name, arguments: argumentsValue });
    },

    async close() {
      const pendingClient = clientPromise;
      clientPromise = null;
      toolsCache = null;
      const client = await pendingClient?.catch(() => null);
      await client?.close();
    },
  };
}
