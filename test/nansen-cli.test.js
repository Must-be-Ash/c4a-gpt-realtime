import assert from "node:assert/strict";
import test from "node:test";

import { buildSmartMoneyArgs, createNansenClient, summarizeSmartMoney } from "../src/services/nansen-cli.js";

test("builds a bounded Nansen smart-money perp query", () => {
  assert.deepEqual(buildSmartMoneyArgs(), [
    "research",
    "smart-money",
    "perp-trades",
    "--limit",
    "100",
    "--fields",
    "token_symbol,side,action,token_amount,price_usd,value_usd,block_timestamp,trader_address_label",
  ]);
});

test("summarizes position-changing smart-money activity for one symbol", () => {
  const summary = summarizeSmartMoney({
    success: true,
    data: {
      data: [
        { token_symbol: "HYPE", side: "Long", action: "Add", value_usd: 100_000, block_timestamp: "2026-08-17T10:00:00Z" },
        { token_symbol: "HYPE", side: "Short", action: "Add", value_usd: 40_000, block_timestamp: "2026-08-17T11:00:00Z" },
        { token_symbol: "HYPE", side: "Long", action: "Reduce", value_usd: 10_000, block_timestamp: "2026-08-17T12:00:00Z" },
        { token_symbol: "BTC", side: "Long", action: "Add", value_usd: 1_000_000 },
      ],
    },
  }, "HYPE");

  assert.equal(summary.symbol, "HYPE");
  assert.equal(summary.tradeCount, 3);
  assert.equal(summary.bullishActivityUsd, 100_000);
  assert.equal(summary.bearishActivityUsd, 50_000);
  assert.equal(summary.netBiasUsd, 50_000);
  assert.equal(summary.lean, "bullish");
  assert.equal(summary.topTrades.length, 3);
});

test("runs the official Nansen CLI through the configured x402 or API-key environment", async () => {
  const calls = [];
  const client = createNansenClient({
    env: { NANSEN_API_KEY: "key" },
    runner: async (args, options) => {
      calls.push({ args, options });
      return { success: true, data: { data: [] } };
    },
  });

  const result = await client.smartMoney({ symbol: "hype" });

  assert.equal(result.symbol, "HYPE");
  assert.deepEqual(calls[0].args, buildSmartMoneyArgs());
  assert.deepEqual(calls[0].options.env, { NANSEN_API_KEY: "key" });
});
