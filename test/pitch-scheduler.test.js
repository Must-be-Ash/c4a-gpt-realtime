import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPitchScheduler } from "../src/pitch/scheduler.js";
import { createPitchStore } from "../src/pitch/pitch-store.js";

const OPEN = Date.parse("2026-09-16T17:15:00Z"); // Wed 13:15 ET
const EVENING = Date.parse("2026-09-16T23:00:00Z"); // 19:00 ET
const SETTINGS = { minConviction: 7, maxIdeaAgeHours: 6, minRewardRisk: 1.5, maxOrderUsd: 500, maxCallsPerDay: 3, minSpacingMin: 60, scanIntervalMin: 10, callTo: "+15550000000", dryRun: false };

const idea = (over = {}) => ({
  ledgerId: "34", agentId: "nadia", traderName: "Mara", symbol: "NKE", name: "Nike",
  entry: 36.96, stop: 34.9, target: 40.5, openedAt: "2026-09-16T15:00:00Z",
  thesis: { title: "t", stance: "bullish", conviction: 7, summary: "s", interpretation: "i", keyPoints: [], body: "b", sources: [] },
  ...over,
});

const goodWords = { spokenName: "Nike", opener: "Jordan here. Give me sixty seconds.", hook: "h", trendLine: "t", catalyst: "c", whyNow: "w", theTurn: "tt", keyRisk: "k", close: "cl", voicemail: "Call me back on this number.", sourceLine: "s" };

async function setup({ ideas = [idea()], clock = OPEN, paused = false, callActive = false, dialError = null, writerResult = null, settings = {}, prices = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sched-"));
  let now = clock;
  const store = createPitchStore({ dir, now: () => now });
  const dials = [];
  const events = [];
  const newsCalls = [];
  const scheduler = createPitchScheduler({
    desk: {
      configured: true,
      listNewLongOpens: async () => ideas,
      isStillOpen: async () => true,
      traderRecord: async () => ({ closedTrades: 0, wins: 0, hitRatePct: null, realizedPnlUsd: 0 }),
    },
    market: {
      futuresList: async () => [],
      coinbaseProduct: async (id) => ({ product_id: id, product_type: "EQUITY" }),
      quote: async (ref) => ({ price: prices[ref.symbol] ?? 36.3, trend: null }),
    },
    store,
    checkNews: async (i) => { newsCalls.push(i.symbol); return { verdict: "supports", reason: "r", facts: [] }; },
    dial: async (vapi) => {
      if (dialError) throw new Error(dialError);
      dials.push(vapi);
      return { callId: `call-${dials.length}`, voice: "elevenlabs", quota: { remaining: 9000 } };
    },
    getBalances: async () => ({ accounts: [{ currency: "USD", available_balance: { value: "4000" } }] }),
    settings: { ...SETTINGS, ...settings },
    openAi: { apiKey: "k", model: "m" },
    writer: async (facts) => writerResult ?? { ok: true, brief: { facts, words: goodWords } },
    isPaused: () => paused,
    isCallActive: () => callActive,
    emit: (e) => events.push(e),
    now: () => now,
  });
  return { scheduler, store, dials, events, newsCalls, tick: (ms) => { now += ms; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("calls the best qualified idea and records it", async () => {
  const s = await setup({ ideas: [idea(), idea({ ledgerId: "41", symbol: "OXY", name: "Occidental", entry: 60.16, stop: 57.5, target: 66, thesis: { ...idea().thesis, conviction: 8 } })], prices: { OXY: 60.3 } });
  try {
    const r = await s.scheduler.runOnce();
    assert.equal(r.action, "called");
    assert.equal(r.symbol, "OXY"); // higher conviction wins
    assert.equal(s.dials.length, 1);
    assert.equal(s.dials[0].firstMessage, "Jordan here. Give me sixty seconds.");
    const pitch = await s.store.get(r.pitchId);
    assert.equal(pitch.status, "in_call");
    assert.equal(pitch.vapiCallId, "call-1");
    assert.equal((await s.store.dialState()).callsToday, 1);
    assert.ok(s.events.some((e) => e.kind === "call" && e.type === "incoming" && e.direction === "outbound"));
  } finally { await s.cleanup(); }
});

test("never pitches the same desk position twice, and respects spacing", async () => {
  const s = await setup();
  try {
    assert.equal((await s.scheduler.runOnce()).action, "called");
    s.tick(5 * 60_000);
    const again = await s.scheduler.runOnce();
    assert.deepEqual(again.reasons, ["too_soon_since_last_call"]);
    s.tick(60 * 60_000);
    const later = await s.scheduler.runOnce();
    assert.equal(later.action, "none");
    assert.deepEqual(later.reasons, ["no_qualified_idea"]);
    assert.equal(s.dials.length, 1);
  } finally { await s.cleanup(); }
});

test("Pitch me now can re-pitch the same idea (spacing and dedupe are for automatic calls)", async () => {
  const s = await setup();
  try {
    assert.equal((await s.scheduler.runOnce()).action, "called");
    s.tick(60_000);
    const again = await s.scheduler.runOnce({ manual: true });
    assert.equal(again.action, "called");
    assert.equal(s.dials.length, 2);
  } finally { await s.cleanup(); }
});

test("a targeted manual run can call about an older desk position; untargeted runs can't", async () => {
  const old = idea({ openedAt: "2026-09-10T13:30:00Z" });
  const s = await setup({ ideas: [old, idea({ ledgerId: "41", symbol: "OXY", openedAt: "2026-09-16T15:00:00Z" })] });
  try {
    const none = await s.scheduler.runOnce({ manual: true, symbol: "TSLA" });
    assert.deepEqual(none.reasons, ["no_open_desk_long_for_TSLA"]);
    const r = await s.scheduler.runOnce({ manual: true, symbol: "nke" });
    assert.equal(r.action, "called");
    assert.equal(r.symbol, "NKE");
    const auto = await setup({ ideas: [old] });
    try { assert.equal((await auto.scheduler.runOnce()).skips[0].reasons[0], "stale"); } finally { await auto.cleanup(); }
  } finally { await s.cleanup(); }
});

test("no qualified idea means no call and no brief", async () => {
  const s = await setup({ ideas: [idea({ thesis: { ...idea().thesis, conviction: 5 } })] });
  try {
    const r = await s.scheduler.runOnce();
    assert.deepEqual(r.reasons, ["no_qualified_idea"]);
    assert.equal(r.skips[0].reasons[0], "low_conviction");
    assert.equal(s.dials.length, 0);
  } finally { await s.cleanup(); }
});

test("skipped ideas aren't re-checked (and news isn't re-bought) within the hour", async () => {
  const s = await setup({ prices: { NKE: 34.5 } }); // below stop
  try {
    await s.scheduler.runOnce();
    await s.scheduler.runOnce();
    const r = await s.scheduler.runOnce();
    assert.equal(r.considered, 1);
    assert.equal(s.newsCalls.length, 0);
    assert.deepEqual(r.skips, []); // cached skip, not re-evaluated
  } finally { await s.cleanup(); }
});

test("pause, live call, daily cap, and after-hours all block before any work", async () => {
  for (const [opts, reason] of [[{ paused: true }, "paused"], [{ callActive: true }, "call_in_progress"], [{ clock: EVENING }, "outside_call_hours"]]) {
    const s = await setup(opts);
    try {
      const r = await s.scheduler.runOnce();
      assert.ok(r.reasons.includes(reason), `${reason}: ${r.reasons}`);
      assert.equal(s.newsCalls.length, 0);
    } finally { await s.cleanup(); }
  }
  const s = await setup({ settings: { maxCallsPerDay: 0 } });
  try { assert.deepEqual((await s.scheduler.runOnce()).reasons, ["daily_cap_reached"]); } finally { await s.cleanup(); }
});

test("manual pitch after hours still won't call an equity", async () => {
  const s = await setup({ clock: EVENING, ideas: [idea({ openedAt: "2026-09-16T20:00:00Z" })] });
  try {
    const r = await s.scheduler.runOnce({ manual: true });
    assert.equal(r.action, "none");
    assert.equal(r.skips[0].reasons[0], "market_closed");
    assert.equal(s.dials.length, 0);
  } finally { await s.cleanup(); }
});

test("an ungrounded brief is skipped, not called", async () => {
  const s = await setup({ writerResult: { ok: false, reason: "ungrounded", detail: ["60,000"] } });
  try {
    const r = await s.scheduler.runOnce();
    assert.deepEqual(r.reasons, ["no_groundable_brief"]);
    assert.equal(s.dials.length, 0);
  } finally { await s.cleanup(); }
});

test("dry run writes the pitch but doesn't dial or use up the idea", async () => {
  const s = await setup({ settings: { dryRun: true } });
  try {
    const r = await s.scheduler.runOnce();
    assert.equal(r.action, "dry_run");
    assert.equal(s.dials.length, 0);
    assert.equal(await s.store.hasPitched("34"), false);
    assert.equal((await s.store.dialState()).callsToday, 0);
  } finally { await s.cleanup(); }
});

test("a failed dial is recorded, not counted, and retried later", async () => {
  const s = await setup({ dialError: "Vapi 402" });
  try {
    const r = await s.scheduler.runOnce();
    assert.equal(r.action, "failed");
    assert.equal((await s.store.get(r.pitchId)).status, "failed");
    assert.equal((await s.store.dialState()).callsToday, 0);
    assert.equal(await s.store.hasPitched("34"), false);
  } finally { await s.cleanup(); }
});

test("concurrent runs are single-flight", async () => {
  const s = await setup();
  try {
    const [a, b] = await Promise.all([s.scheduler.runOnce(), s.scheduler.runOnce()]);
    assert.deepEqual([a.action, b.reasons], ["called", ["scan_in_progress"]]);
    assert.equal(s.dials.length, 1);
  } finally { await s.cleanup(); }
});
