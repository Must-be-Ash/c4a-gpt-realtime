import assert from "node:assert/strict";
import test from "node:test";

import { pickFrontContract, resolveProduct } from "../src/pitch/symbol-map.js";
import { trendFromCloses } from "../src/pitch/market-data.js";

const NOW = Date.parse("2026-09-16T17:00:00Z");

const future = (id, root, expiry, size, price) => ({
  product_id: id,
  price: String(price),
  future_product_details: { contract_root_unit: root, contract_expiry: expiry, contract_size: String(size) },
});

const FUTURES = [
  future("NOL-21SEP26-CDE", "CDEOIL", "2026-09-21T18:30:00Z", 10, 102.5), // expires too soon
  future("NOL-20OCT26-CDE", "CDEOIL", "2026-10-20T18:30:00Z", 10, 101.9),
  future("GOL-25NOV26-CDE", "CDEGLD", "2026-11-25T18:30:00Z", 1, 4385),
  future("MGC-25NOV26-CDE", "CDEMINI", "2026-11-25T18:30:00Z", 0.1, 438),
  future("SLR-25NOV26-CDE", "CDESIL", "2026-11-25T18:25:00Z", 50, 64.87),
  future("NGS-25NOV26-CDE", "CDENGS", "2026-11-25T18:30:00Z", 100, 2.9),
];

const EQUITIES = new Set(["NKE-USD", "USO-USD", "GLD-USD"]);

function fakeMarket() {
  return {
    futuresList: async () => FUTURES,
    coinbaseProduct: async (id) => (EQUITIES.has(id) ? { product_id: id, product_type: "EQUITY" } : null),
  };
}

const resolve = (symbol, maxOrderUsd = 500) => resolveProduct({ symbol }, fakeMarket(), { maxOrderUsd, now: NOW });

test("front contract skips contracts expiring within 7 days", () => {
  assert.equal(pickFrontContract(FUTURES, "CDEOIL", NOW).product_id, "NOL-20OCT26-CDE");
  assert.equal(pickFrontContract(FUTURES, "CDECU", NOW), null);
});

test("equities resolve through Coinbase and price on Yahoo", async () => {
  const r = await resolve("NKE");
  assert.equal(r.ok, true);
  assert.equal(r.productId, "NKE-USD");
  assert.equal(r.kind, "equity");
  assert.deepEqual(r.underlyingRef, { source: "yahoo", symbol: "NKE" });
});

test("unknown equities are not tradable", async () => {
  assert.deepEqual(await resolve("ZZZZ"), { ok: false, reason: "not_tradable" });
});

test("crypto maps to spot and prices on Coinbase", async () => {
  const r = await resolve("BTC");
  assert.equal(r.productId, "BTC-USD");
  assert.equal(r.kind, "spot");
  assert.equal(r.underlyingRef.source, "coinbase");
});

test("oil futures over the cap fall back to USO, priced off CL=F", async () => {
  const r = await resolve("WTI");
  assert.equal(r.productId, "USO-USD");
  assert.equal(r.proxyOf, "WTI");
  assert.equal(r.underlyingName, "crude oil");
  assert.deepEqual(r.underlyingRef, { source: "yahoo", symbol: "CL=F" });
  assert.deepEqual(r.productRef, { source: "yahoo", symbol: "USO" });
});

test("oil futures under a larger cap use the contract", async () => {
  const r = await resolve("WTI", 2000);
  assert.equal(r.productId, "NOL-20OCT26-CDE");
  assert.equal(r.kind, "future");
  assert.equal(r.contractSize, 10);
});

test("gold over the cap uses GLD", async () => {
  assert.equal((await resolve("GOLD")).productId, "GLD-USD");
});

test("silver over the cap with no proxy is skipped", async () => {
  assert.deepEqual(await resolve("SILVER"), { ok: false, reason: "over_cap" });
});

test("natural gas within the cap uses the contract", async () => {
  const r = await resolve("NATGAS");
  assert.equal(r.productId, "NGS-25NOV26-CDE");
});

test("commodities without a contract or proxy are skipped", async () => {
  assert.deepEqual(await resolve("COPPER"), { ok: false, reason: "no_contract" });
});

test("agricultural futures are not on Coinbase", async () => {
  for (const symbol of ["CORN", "WHEAT", "SOY", "COFFEE", "SUGAR"]) {
    assert.deepEqual(await resolve(symbol), { ok: false, reason: "not_on_coinbase" });
  }
});

test("trendFromCloses computes changes and distance from the high", () => {
  const closes = Array.from({ length: 70 }, (_, i) => 100 - i * 0.5); // steady decline
  const t = trendFromCloses(closes);
  assert.equal(t.high90d, 96.5); // max of the last 63 closes
  assert.ok(t.change30dPct < 0);
  assert.ok(t.change90dPct < t.change30dPct);
  assert.ok(t.offHigh90dPct < 0);
  assert.equal(trendFromCloses([1]), null);
});
