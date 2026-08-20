import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentCashNansenRequest,
  createAgentCashMcpClient,
  normalizeAgentCashMcpResult,
  parseAgentCashToolResult,
  preferAgentCashPayment,
} from "../src/services/agentcash-mcp.js";

const tools = [
  { name: "fetch", description: "Fetch paid data", inputSchema: { type: "object" } },
  { name: "get_balance", description: "Balance", inputSchema: { type: "object" } },
  { name: "discover_api_endpoints", description: "Discover", inputSchema: { type: "object" } },
  { name: "check_endpoint_schema", description: "Check", inputSchema: { type: "object" } },
  { name: "search", description: "Search", inputSchema: { type: "object" } },
  { name: "list_accounts", description: "Accounts", inputSchema: { type: "object" } },
  { name: "bridge", description: "Move funds", inputSchema: { type: "object" } },
  { name: "update_settings", description: "Settings", inputSchema: { type: "object" } },
];

test("exposes AgentCash data tools while blocking wallet mutation tools", async () => {
  const calls = [];
  const client = createAgentCashMcpClient({
    clientFactory: async () => ({
      listTools: async () => ({ tools }),
      callTool: async (request) => { calls.push(request); return { structuredContent: { ok: true } }; },
      close: async () => {},
    }),
  });

  assert.deepEqual((await client.listTools()).map(({ name }) => name), [
    "fetch", "get_balance", "discover_api_endpoints", "check_endpoint_schema", "search", "list_accounts",
  ]);
  await client.callTool("discover_api_endpoints", { url: "https://stableenrich.dev" });
  assert.deepEqual(calls[0], { name: "discover_api_endpoints", arguments: { url: "https://stableenrich.dev" } });
  await assert.rejects(client.callTool("bridge", { from: "base", to: "solana", amount: 1 }), /not exposed/i);
});

test("normalizes AgentCash fetch content for generic artifacts", () => {
  const result = {
    content: [
      { type: "text", text: '{"people":[{"name":"Ada"}]}' },
      { type: "text", text: '{"headers":{"content-type":"application/json"}}' },
    ],
  };
  assert.deepEqual(parseAgentCashToolResult(result), { people: [{ name: "Ada" }] });
  assert.deepEqual(normalizeAgentCashMcpResult(result).structuredContent.people, [{ name: "Ada" }]);
  assert.throws(() => parseAgentCashToolResult({ isError: true, content: [{ type: "text", text: "failed" }] }), /failed/i);
});

test("preserves provider errors and payment metadata from every AgentCash response block", () => {
  const result = normalizeAgentCashMcpResult({
    content: [
      { type: "text", text: '{"cause":"http","statusCode":403,"message":"Forbidden","type":"fetch"}' },
      { type: "text", text: '{"success":false,"error":"Not enough credits"}' },
      { type: "text", text: '{"protocol":"x402","network":"base","payment":null}' },
    ],
  });

  assert.equal(result.structuredContent.error, "Not enough credits");
  assert.equal(result.structuredContent.providerError.success, false);
  assert.equal(result.structuredContent.paymentInfo.protocol, "x402");
});

test("recognizes payment metadata even when a failed provider returns only two blocks", () => {
  const result = normalizeAgentCashMcpResult({
    content: [
      { type: "text", text: '{"success":false,"error":"Validation errors","validationErrors":[{"field":"query"}]}' },
      { type: "text", text: '{"protocol":"x402","network":"base","payment":{"success":true}}' },
    ],
  });

  assert.equal(result.structuredContent.providerError, undefined);
  assert.equal(result.structuredContent.paymentInfo.protocol, "x402");
});

test("builds an AgentCash Nansen request using x402 on Base", () => {
  const request = buildAgentCashNansenRequest("hype");
  assert.equal(request.url, "https://api.nansen.ai/api/v1/smart-money/perp-trades");
  assert.equal(request.paymentProtocol, "x402");
  assert.equal(request.paymentNetwork, "base");
  assert.deepEqual(request.body.filters, { token_symbol: "HYPE" });
});

test("prefers x402 on Base without overriding an endpoint's explicit payment route", () => {
  assert.deepEqual(preferAgentCashPayment({ url: "https://example.com/data" }), {
    url: "https://example.com/data",
    paymentProtocol: "x402",
    paymentNetwork: "base",
  });
  assert.deepEqual(preferAgentCashPayment({
    url: "https://example.com/tempo-only",
    paymentProtocol: "mpp",
    paymentNetwork: "tempo",
  }), {
    url: "https://example.com/tempo-only",
    paymentProtocol: "mpp",
    paymentNetwork: "tempo",
  });
});

test("restarts the AgentCash process after a wallet file changes", async () => {
  let walletRevision = "wallet-a";
  const clients = [];
  const client = createAgentCashMcpClient({
    walletRevision: async () => walletRevision,
    clientFactory: async () => {
      const instance = {
        closed: false,
        calls: [],
        listTools: async () => ({ tools }),
        callTool: async (request) => {
          instance.calls.push(request);
          return { structuredContent: request.arguments };
        },
        close: async () => { instance.closed = true; },
      };
      clients.push(instance);
      return instance;
    },
  });

  await client.callTool("get_balance");
  walletRevision = "wallet-b";
  await client.callTool("fetch", { url: "https://example.com/data" });

  assert.equal(clients.length, 2);
  assert.equal(clients[0].closed, true);
  assert.deepEqual(clients[1].calls[0], {
    name: "fetch",
    arguments: {
      url: "https://example.com/data",
      paymentProtocol: "x402",
      paymentNetwork: "base",
    },
  });
});
