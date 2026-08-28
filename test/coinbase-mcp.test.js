import assert from "node:assert/strict";
import test from "node:test";

import { createCoinbaseMcpClient } from "../src/services/coinbase-mcp.js";

function fakeCoinbaseMcp() {
  const calls = [];
  let closeCount = 0;
  const client = {
    async listTools() {
      return { tools: [
        { name: "coinbase_products_candles", description: "Candles", inputSchema: { type: "object" } },
        { name: "coinbase_products_list", description: "Discover equities and futures", inputSchema: { type: "object" } },
        { name: "coinbase_orders_preview", description: "Preview any supported asset", inputSchema: { type: "object" } },
        { name: "coinbase_orders_create", description: "Create an order", inputSchema: { type: "object" } },
        { name: "coinbase_convert_execute", description: "Execute a conversion", inputSchema: { type: "object" } },
        { name: "coinbase_transfer", description: "Transfer funds", inputSchema: { type: "object" } },
        { name: "coinbase_x402_pay", description: "Pay", inputSchema: { type: "object" } },
      ] };
    },
    async callTool(params) {
      calls.push(params);
      return { content: [{ type: "text", text: "candles" }] };
    },
    async close() { closeCount += 1; },
  };
  return { client, calls, getCloseCount: () => closeCount };
}

test("exposes Coinbase tools except x402 and executes an allowed market-data tool", async () => {
  const fake = fakeCoinbaseMcp();
  const client = createCoinbaseMcpClient({ clientFactory: async () => fake.client });

  assert.deepEqual((await client.listTools()).map(({ name }) => name), [
    "coinbase_products_candles",
    "coinbase_products_list",
    "coinbase_orders_preview",
  ]);
  assert.equal(
    (await client.callTool("coinbase_products_candles", { product_id: "BTC-USD" })).content[0].text,
    "candles",
  );
  assert.deepEqual(fake.calls, [{ name: "coinbase_products_candles", arguments: { product_id: "BTC-USD" } }]);
  await client.close();
  assert.equal(fake.getCloseCount(), 1);
});

test("blocks raw Coinbase mutations before connecting", async () => {
  const client = createCoinbaseMcpClient({ clientFactory: async () => { throw new Error("should not connect"); } });
  for (const name of ["coinbase_orders_create", "coinbase_orders_cancel", "coinbase_convert_execute", "coinbase_transfer", "coinbase_set_env"]) {
    await assert.rejects(client.callTool(name, {}), /read-only.*preview_order.*execute_order/i);
  }
});

test("blocks direct and indirect Coinbase x402 calls before connecting", async () => {
  const client = createCoinbaseMcpClient({ clientFactory: async () => { throw new Error("should not connect"); } });
  const blockedCalls = [
    ["coinbase_x402_fetch", {}],
    ["coinbase_help", { resource: "x402", action: "fetch" }],
    ["coinbase_help", { topic: "How does x402 work?" }],
    ["coinbase_template", { template: { resource: "X402" } }],
  ];

  for (const [name, argumentsValue] of blockedCalls) {
    await assert.rejects(client.callTool(name, argumentsValue), /not exposed/i);
  }
});
