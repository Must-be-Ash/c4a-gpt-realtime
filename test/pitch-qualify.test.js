import assert from "node:assert/strict";
import test from "node:test";

import { callGateReasons } from "../src/pitch/gates.js";
import { etDateKey, isMarketOpen } from "../src/pitch/market-hours.js";
import { evaluateIdea, priceChecks, rankCandidates } from "../src/pitch/qualify.js";

// Wed 2026-09-16 13:15 ET (EDT, UTC-4)
const NOW = Date.parse("2026-09-16T17:15:00Z");
const SETTINGS = { minConviction: 7, maxIdeaAgeHours: 6, minRewardRisk: 1.5, maxOrderUsd: 500, maxCallsPerDay: 3, minSpacingMin: 60 };

const idea = (over = {}) => ({
  ledgerId: "34",
  agentId: "nadia",
  symbol: "NKE",
  name: "Nike",
  entry: 36.96,
  stop: 34.9,
  target: 40.5,
  openedAt: "2026-09-16T14:00:00Z",
  thesis: { title: "NKE flush", stance: "bullish", conviction: 7, summary: "s", interpretation: "i", sources: [] },
  ...over,
});

function deps({ price = 36.3, verdict = "supports", equity = true, stillOpen = true, pitched = false, lastSymbol = null, newsError = null } = {}) {
  return {
    settings: SETTINGS,
    market: {
      futuresList: async () => [],
      coinbaseProduct: async (id) => (equity ? { product_id: id, product_type: "EQUITY" } : null),
      quote: async () => (price == null ? null : { price, trend: null }),
    },
    checkNews: async () => {
      if (newsError) throw new Error(newsError);
      return { verdict, reason: "r", facts: [] };
    },
    store: { hasPitched: async () => pitched, lastPitchOfSymbol: async () => lastSymbol },
    desk: { isStillOpen: async () => stillOpen },
  };
}

const run = (ideaOver, depOver, now = NOW) => evaluateIdea(idea(ideaOver), deps(depOver), { now });

test("a fresh, intact, tradable, news-backed idea passes", async () => {
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.candidate.product.productId, "NKE-USD");
  assert.equal(r.candidate.metrics.rewardRisk, 3.0);
  assert.equal(r.candidate.metrics.upsidePct, 11.6);
});

const skips = [
  ["no_thesis", { thesis: null }, {}],
  ["not_bullish", { thesis: { ...idea().thesis, stance: "neutral" } }, {}],
  ["low_conviction", { thesis: { ...idea().thesis, conviction: 6 } }, {}],
  ["stale", { openedAt: "2026-09-16T10:00:00Z" }, {}],
  ["already_pitched", {}, { pitched: true }],
  ["symbol_pitched_recently", {}, { lastSymbol: NOW - 3_600_000 }],
  ["not_tradable", {}, { equity: false }],
  ["no_price", {}, { price: null }],
  ["below_stop", {}, { price: 34.5 }],
  ["target_hit", {}, { price: 40.6 }],
  ["move_mostly_done", {}, { price: 39 }],
  ["desk_closed_position", {}, { stillOpen: false }],
  ["news_contradicts", {}, { verdict: "contradicts" }],
  ["news_check_failed", {}, { newsError: "exa down" }],
];

for (const [reason, ideaOver, depOver] of skips) {
  test(`skips with ${reason}`, async () => {
    const r = await run(ideaOver, depOver);
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes(reason), `expected ${reason}, got ${r.reasons}`);
  });
}

test("manual runs may re-pitch an idea that was already pitched", async () => {
  const r = await evaluateIdea(idea(), deps({ pitched: true, lastSymbol: NOW - 60_000 }), { now: NOW, manual: true });
  assert.equal(r.ok, true);
});

test("equities are skipped while the market is closed", async () => {
  const saturday = Date.parse("2026-09-19T15:00:00Z");
  const r = await run({ openedAt: "2026-09-19T14:00:00Z" }, {}, saturday);
  assert.deepEqual(r.reasons, ["market_closed"]);
});

test("crypto is not blocked by market hours", async () => {
  const saturday = Date.parse("2026-09-19T15:00:00Z");
  const r = await run({ symbol: "BTC", openedAt: "2026-09-19T14:00:00Z", entry: 75000, stop: 72000, target: 84000 }, { price: 75500 }, saturday);
  assert.equal(r.ok, true);
  assert.equal(r.candidate.product.kind, "spot");
});

test("priceChecks flags thin reward/risk and bad levels", () => {
  assert.ok(priceChecks({ price: 38, entry: 37, stop: 34, target: 40 }, SETTINGS).reasons.includes("reward_risk_too_low"));
  assert.ok(priceChecks({ price: 37, entry: 37, stop: 38, target: 40 }, SETTINGS).reasons.includes("bad_levels"));
  assert.deepEqual(priceChecks({ price: null, entry: 1, stop: 0, target: 2 }, SETTINGS).reasons, ["missing_levels"]);
});

test("rankCandidates orders by conviction, then reward/risk, then news", () => {
  const c = (symbol, conviction, rewardRisk, verdict) => ({
    idea: { symbol, openedAt: "2026-09-16T14:00:00Z", thesis: { conviction } },
    metrics: { rewardRisk },
    news: { verdict },
  });
  const ranked = rankCandidates([c("A", 7, 2, "neutral"), c("B", 8, 1.6, "neutral"), c("C", 7, 2, "supports"), c("D", 7, 3, "neutral")]);
  assert.deepEqual(ranked.map((x) => x.idea.symbol), ["B", "D", "C", "A"]);
});

// ── Market hours (DST + holidays) ──
test("market hours respect DST, weekends, holidays and half-days", () => {
  assert.equal(isMarketOpen(Date.parse("2026-09-16T13:30:00Z")), true); // 9:30 EDT
  assert.equal(isMarketOpen(Date.parse("2026-09-16T13:29:00Z")), false);
  assert.equal(isMarketOpen(Date.parse("2026-09-16T20:00:00Z")), false); // 16:00 EDT
  assert.equal(isMarketOpen(Date.parse("2026-12-01T14:30:00Z")), true); // 9:30 EST
  assert.equal(isMarketOpen(Date.parse("2026-12-01T14:29:00Z")), false);
  assert.equal(isMarketOpen(Date.parse("2026-09-07T15:00:00Z")), false); // Labor Day
  assert.equal(isMarketOpen(Date.parse("2026-09-19T15:00:00Z")), false); // Saturday
  assert.equal(isMarketOpen(Date.parse("2026-11-27T17:59:00Z")), true); // half-day 12:59 EST
  assert.equal(isMarketOpen(Date.parse("2026-11-27T18:00:00Z")), false); // 13:00 EST
  assert.equal(etDateKey(Date.parse("2026-09-17T02:00:00Z")), "2026-09-16"); // 22:00 ET
});

// ── Call gates ──
const open = { paused: false, callsToday: 0, lastDialAt: null, callInProgress: false };

test("gates allow a call in market hours with nothing blocking", () => {
  assert.deepEqual(callGateReasons(open, SETTINGS, { now: NOW }), []);
});

test("gates block on pause, live call, daily cap, spacing and hours", () => {
  assert.deepEqual(callGateReasons({ ...open, paused: true }, SETTINGS, { now: NOW }), ["paused"]);
  assert.deepEqual(callGateReasons({ ...open, callInProgress: true }, SETTINGS, { now: NOW }), ["call_in_progress"]);
  assert.deepEqual(callGateReasons({ ...open, callsToday: 3 }, SETTINGS, { now: NOW }), ["daily_cap_reached"]);
  assert.deepEqual(callGateReasons({ ...open, lastDialAt: NOW - 59 * 60_000 }, SETTINGS, { now: NOW }), ["too_soon_since_last_call"]);
  assert.deepEqual(callGateReasons({ ...open, lastDialAt: NOW - 60 * 60_000 }, SETTINGS, { now: NOW }), []);
  assert.deepEqual(callGateReasons(open, SETTINGS, { now: Date.parse("2026-09-16T21:00:00Z") }), ["outside_call_hours"]);
});

test("manual pitch skips spacing, and hours only for crypto; pause and cap still apply", () => {
  const evening = Date.parse("2026-09-16T23:00:00Z");
  const recent = { ...open, lastDialAt: NOW - 60_000 };
  assert.deepEqual(callGateReasons(recent, SETTINGS, { manual: true, now: NOW }), []);
  assert.deepEqual(callGateReasons(open, SETTINGS, { manual: true, kind: "spot", now: evening }), []);
  assert.deepEqual(callGateReasons(open, SETTINGS, { manual: true, kind: "equity", now: evening }), ["outside_call_hours"]);
  assert.deepEqual(callGateReasons({ ...open, paused: true, callsToday: 3 }, SETTINGS, { manual: true, kind: "spot", now: evening }), ["paused", "daily_cap_reached"]);
});
