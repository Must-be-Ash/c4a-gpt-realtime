import test from "node:test";
import assert from "node:assert/strict";

import {
  agentSafeX402,
  buildNansenSmartMoneyRequest,
  createSpongeMcpClient,
  parseSpongeTextResult,
} from "../src/services/sponge-mcp.js";

test("redacts the provider name without corrupting catalog URLs", () => {
  assert.deepEqual(agentSafeX402({
    description: "Pay with Sponge wallet from PaySponge.",
    baseUrl: "https://api.paysponge.com/x402/purchase/service-123",
    docs: "Use https://example.com/sponge/docs?provider=sponge for PaySponge setup.",
    sponge: "Sponge metadata",
  }), {
    description: "Pay with x402 provider wallet from x402 provider.",
    baseUrl: "https://api.paysponge.com/x402/purchase/service-123",
    docs: "Use https://example.com/sponge/docs?provider=sponge for x402 provider setup.",
    sponge: "x402 provider metadata",
  });
});

test("initializes one MCP session and exposes only scoped x402 tools", async () => {
  const methods = [];
  const fetchFn = async (_url, options) => {
    const message = JSON.parse(options.body);
    methods.push(message.method);
    if (message.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26" } }, {
        headers: { "mcp-session-id": "session-123" },
      });
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "paid_fetch", description: "Pay for an API call", inputSchema: { type: "object" } },
        { name: "transfer", description: "Send funds", inputSchema: { type: "object" } },
      ] } });
    }
    throw new Error(`Unexpected method: ${message.method}`);
  };
  const client = createSpongeMcpClient({ apiKey: "test-key", fetchFn });

  assert.deepEqual((await client.listTools()).map(({ name }) => name), ["paid_fetch"]);
  assert.deepEqual((await client.listTools()).map(({ name }) => name), ["paid_fetch"]);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
});

test("calls an allowed tool and rejects wallet mutation tools", async () => {
  const fetchFn = async (_url, options) => {
    const message = JSON.parse(options.body);
    if (message.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: message.id, result: {} }, { headers: { "mcp-session-id": "session-123" } });
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/call") {
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "paid" }] } });
    }
    throw new Error(`Unexpected method: ${message.method}`);
  };
  const client = createSpongeMcpClient({ apiKey: "test-key", fetchFn });

  assert.equal((await client.callTool("paid_fetch", { url: "https://example.com" })).content[0].text, "paid");
  await assert.rejects(client.callTool("transfer", { amount: "1" }), /not enabled/i);
});

test("fails clearly when the Sponge key is missing", async () => {
  const client = createSpongeMcpClient({ apiKey: "" });
  await assert.rejects(client.listTools(), /SPONGE_API_KEY/);
});

test("builds and parses the paid Nansen smart-money call", () => {
  assert.deepEqual(buildNansenSmartMoneyRequest("hype").body.filters, { token_symbol: "HYPE" });
  assert.equal(buildNansenSmartMoneyRequest("hype").protocol, "x402");
  assert.deepEqual(parseSpongeTextResult({ content: [{ type: "text", text: '{"ok":true,"data":{"data":[]}}' }] }), {
    ok: true,
    data: { data: [] },
  });
  assert.throws(() => parseSpongeTextResult({ content: [] }), /text result/i);
  assert.deepEqual(parseSpongeTextResult({ structuredContent: { ok: true } }), { ok: true });
  assert.throws(() => parseSpongeTextResult({ isError: true, content: [{ type: "text", text: "payment failed" }] }), /payment failed/i);
});

test("retries the full handshake after initialization fails", async () => {
  let notificationAttempts = 0;
  const fetchFn = async (_url, options) => {
    const message = JSON.parse(options.body);
    if (message.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: message.id, result: {} }, { headers: { "mcp-session-id": `session-${notificationAttempts}` } });
    }
    if (message.method === "notifications/initialized") {
      notificationAttempts += 1;
      if (notificationAttempts === 1) return Response.json({ error: "temporary" }, { status: 503 });
      return new Response(null, { status: 202 });
    }
    if (message.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
    }
    throw new Error(`Unexpected method: ${message.method}`);
  };
  const client = createSpongeMcpClient({ apiKey: "test-key", fetchFn });

  await assert.rejects(client.listTools(), /temporary|503/);
  assert.deepEqual(await client.listTools(), []);
  assert.equal(notificationAttempts, 2);
});
