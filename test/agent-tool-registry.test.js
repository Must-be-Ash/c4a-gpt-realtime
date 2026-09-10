import assert from "node:assert/strict";
import test from "node:test";

import { buildToolRegistry, STATIC_TOOLS } from "../src/agent/tools.js";

function makeFakeFetch() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const payload = {
      report: "R", reportUrl: "/reports/x.md", balances: [], symbol: "BTC",
      type: "candles", previewId: "p1", order: { productId: "BTC-USD" }, preview: {},
    };
    return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
  };
  return { fetchImpl, calls };
}

test("every static tool definition is well-formed", () => {
  const seen = new Set();
  for (const tool of STATIC_TOOLS) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.name.length > 0, "tool has a name");
    assert.ok(!seen.has(tool.name), `tool name ${tool.name} is unique`);
    seen.add(tool.name);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0, `${tool.name} has a description`);
    assert.ok(tool.parameters && typeof tool.parameters === "object", `${tool.name} has parameters`);
    assert.equal(tool.parameters.type, "object", `${tool.name} parameters is a JSON object schema`);
    assert.equal(typeof tool.run, "function", `${tool.name} has a run()`);
  }
});

test("registry executes happy-path tools, returns serializable strings, and hits the mapped endpoint", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const registry = buildToolRegistry({ baseUrl: "http://127.0.0.1:4173", fetchImpl });
  const events = [];
  const ctx = { emit: (event) => events.push(event) };

  const cases = [
    ["research_crypto", { productId: "BTC-USD", focusQuery: "halving news", timeframe: "today" }, "/api/research"],
    ["search_crypto_news", { productId: "BTC-USD", focusQuery: "news", timeframe: "today" }, "/api/news"],
    ["show_polymarket", { productId: "BTC-USD" }, "/api/artifacts/polymarket"],
    ["show_candle_chart", { productId: "BTC-USD" }, "/api/artifacts/candles"],
    ["show_order_book_depth", { productId: "BTC-USD" }, "/api/artifacts/order-book"],
    ["check_balance", {}, "/api/balance"],
    ["check_smart_money", { symbol: "BTC" }, "/api/smart-money"],
    ["show_derivatives_positioning", { productId: "BTC-USD" }, "/api/artifacts/derivatives-positioning"],
    ["show_position_risk", {}, "/api/artifacts/position-risk"],
    ["show_trade_impact", { productId: "BTC-USD", quoteSize: 1000 }, "/api/artifacts/trade-impact"],
    ["show_onchain_flows", { productId: "BTC-USD" }, "/api/artifacts/onchain-flows"],
    ["show_catalyst_calendar", { productId: "BTC-USD", horizonDays: 90 }, "/api/artifacts/catalysts"],
    ["preview_order", { productId: "BTC-USD", side: "BUY", type: "market", amount: 10, amountType: "quote" }, "/api/orders/preview"],
    ["execute_order", { previewId: "p1" }, "/api/orders/execute"],
    ["use_agentcash", { toolName: "fetch", arguments: {}, intent: "x" }, "/api/agentcash/call"],
    ["use_orthogonal_catalog", { action: "search", arguments: {} }, "/api/orthogonal/discover"],
  ];

  for (const [name, args, endpoint] of cases) {
    const result = await registry.execute(name, args, ctx);
    assert.equal(typeof result, "string", `${name} returns a string`);
    assert.doesNotThrow(() => JSON.stringify({ result }), `${name} result is serializable`);
    assert.ok(calls.some((c) => c.url.endsWith(endpoint)), `${name} hit ${endpoint}`);
  }
  // Artifact/report tools emit to the dashboard bus.
  assert.ok(events.some((e) => e.kind === "report"), "research emitted a report");
  assert.ok(events.some((e) => e.kind === "artifact"), "chart emitted an artifact");
  assert.ok(events.some((e) => e.kind === "preview"), "preview_order emitted a preview");
});

test("preview_order maps amountType=quote to quoteSize (never both)", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const registry = buildToolRegistry({ baseUrl: "http://x", fetchImpl });
  await registry.execute("preview_order", { productId: "BTC-USD", side: "BUY", type: "market", amount: 25, amountType: "quote" }, {});
  const body = calls.find((c) => c.url.endsWith("/api/orders/preview")).body;
  assert.equal(body.quoteSize, "25");
  assert.equal(body.baseSize, undefined);
});

test("present_artifact validates the spec and emits it; rejects invalid specs", async () => {
  const { fetchImpl } = makeFakeFetch();
  const registry = buildToolRegistry({ baseUrl: "http://x", fetchImpl });
  const events = [];
  const spec = { title: "T", subtitle: null, source: null, blocks: [{ type: "text", title: null, body: "hi", tone: "neutral" }] };
  const result = await registry.execute("present_artifact", spec, { emit: (e) => events.push(e) });
  assert.equal(typeof result, "string");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "artifact");
  await assert.rejects(() => registry.execute("present_artifact", { title: "" }, {}));
});

test("coinbase_* tools proxy dynamically and unknown tools throw", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const registry = buildToolRegistry({ baseUrl: "http://x", fetchImpl });
  const result = await registry.execute("coinbase_products_list", { limit: 5 }, {});
  assert.equal(typeof result, "string");
  const call = calls.find((c) => c.url.endsWith("/api/coinbase/call"));
  assert.equal(call.body.toolName, "coinbase_products_list");
  await assert.rejects(() => registry.execute("does_not_exist", {}, {}));
});

test("non-ok responses surface the endpoint error", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, async text() { return JSON.stringify({ error: "bad productId" }); } });
  const registry = buildToolRegistry({ baseUrl: "http://x", fetchImpl });
  await assert.rejects(() => registry.execute("show_candle_chart", { productId: "BAD" }, {}), /bad productId/);
});
