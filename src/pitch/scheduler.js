// The pitch loop: every few minutes during market hours, look at the desk's
// fresh longs, keep only the ones that are real (qualify), pick the best, write
// a grounded brief, and phone the owner, within the call gates.

import { buildFacts, renderVapiVariables, writeBrief } from "./brief.js";
import { callGateReasons } from "./gates.js";
import { isMarketOpen } from "./market-hours.js";
import { evaluateIdea, rankCandidates } from "./qualify.js";

const MINUTE = 60_000;
// Skip reasons that can't change for the same desk position.
const PERMANENT = new Set(["no_thesis", "not_bullish", "low_conviction", "not_on_coinbase", "not_tradable", "already_pitched", "bad_levels", "missing_levels", "desk_closed_position"]);
const RECHECK_MS = 60 * MINUTE; // price/news-dependent skips are retried hourly
// A targeted test run ("call me about Nike") looks back this far for the desk's position.
const TARGETED_LOOKBACK_MS = 30 * 24 * 3_600_000;

/**
 * @param {object} deps
 * @param {object} deps.desk, deps.market, deps.store
 * @param {Function} deps.checkNews
 * @param {Function} deps.dial            createPitchDialer()
 * @param {Function} deps.getBalances     () => Coinbase balance payload
 * @param {object} deps.settings          config.pitch
 * @param {object} deps.openAi            { apiKey, model } for brief writing
 * @param {() => boolean} deps.isPaused
 * @param {() => boolean} deps.isCallActive
 * @param {(event:object) => void} [deps.emit]
 * @param {(name:string, data:object) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {Function} [deps.writer]        writeBrief override (tests)
 * @param {() => string} [deps.getEngine]  "elevenlabs" | "realtime" for new pitches
 */
export function createPitchScheduler(deps) {
  const { desk, market, store, checkNews, dial, getBalances, settings, openAi, isPaused, isCallActive, emit = () => {}, log = () => {}, now = () => Date.now(), writer = writeBrief, getEngine = () => "elevenlabs" } = deps;
  const skipped = new Map(); // ledgerId -> { at, reasons }
  let running = null;
  let timer = null;
  let lastRun = null;

  function remember(ledgerId, reasons) {
    skipped.set(ledgerId, { at: now(), reasons });
  }

  function recentlySkipped(ledgerId) {
    const hit = skipped.get(ledgerId);
    if (!hit) return false;
    if (hit.reasons.some((r) => PERMANENT.has(r))) return true;
    return now() - hit.at < RECHECK_MS;
  }

  async function gateState() {
    const dials = await store.dialState();
    return { paused: isPaused(), callInProgress: isCallActive(), ...dials };
  }

  async function scan({ manual, symbol = null }) {
    const t = now();
    // A targeted manual run may use an older desk position; every other check still applies.
    const targeted = manual && symbol ? String(symbol).toUpperCase() : null;
    const ideaSettings = targeted ? { ...settings, maxIdeaAgeHours: TARGETED_LOOKBACK_MS / 3_600_000 } : settings;
    // Cheap exits before touching any paid API.
    const pre = callGateReasons(await gateState(), settings, { manual, kind: manual ? "spot" : null, now: t });
    if (pre.length) return { action: "none", reasons: pre };
    if (!desk.configured) return { action: "none", reasons: ["desk_not_configured"] };

    const opened = await desk.listNewLongOpens({ since: t - ideaSettings.maxIdeaAgeHours * 3_600_000, limit: targeted ? 200 : 50 });
    const ideas = targeted ? opened.filter((idea) => idea.symbol === targeted) : opened;
    if (targeted && !ideas.length) return { action: "none", reasons: [`no_open_desk_long_for_${targeted}`] };
    const candidates = [];
    const skips = [];
    for (const idea of ideas) {
      if (!manual && recentlySkipped(idea.ledgerId)) continue;
      const result = await evaluateIdea(idea, { market, checkNews, store, desk, settings: ideaSettings }, { now: now(), manual });
      if (result.ok) candidates.push(result.candidate);
      else {
        remember(idea.ledgerId, result.reasons);
        skips.push({ ledgerId: idea.ledgerId, symbol: idea.symbol, reasons: result.reasons, ...(result.news ? { news: result.news.reason } : {}), ...(result.error ? { error: result.error } : {}) });
        log("pitch.idea.skipped", { ledgerId: idea.ledgerId, symbol: idea.symbol, reasons: result.reasons, error: result.error ?? null });
      }
    }
    // One call per symbol per scan even if the desk holds it twice.
    const ranked = rankCandidates(candidates).filter((c, i, all) => all.findIndex((x) => x.idea.symbol === c.idea.symbol) === i);
    if (!ranked.length) return { action: "none", reasons: ["no_qualified_idea"], considered: ideas.length, skips };

    for (const candidate of ranked) {
      const gates = callGateReasons(await gateState(), settings, { manual, kind: candidate.product.kind, now: now() });
      if (gates.length) return { action: "none", reasons: gates, considered: ideas.length, skips };

      const [record, balances] = await Promise.all([
        desk.traderRecord(candidate.idea.agentId),
        getBalances().catch(() => null),
      ]);
      const facts = buildFacts(candidate, { record, balances, maxOrderUsd: settings.maxOrderUsd });
      const written = await writer(facts, openAi).catch((error) => ({ ok: false, reason: "brief_failed", detail: error.message }));
      if (!written.ok) {
        remember(candidate.idea.ledgerId, [written.reason]);
        skips.push({ ledgerId: candidate.idea.ledgerId, symbol: candidate.idea.symbol, reasons: [written.reason] });
        log("pitch.brief.rejected", { ledgerId: candidate.idea.ledgerId, reason: written.reason, detail: written.detail });
        continue; // try the next-best idea
      }
      return placeCall(candidate, written.brief, { manual, considered: ideas.length, skips });
    }
    return { action: "none", reasons: ["no_groundable_brief"], considered: ideas.length, skips };
  }

  async function placeCall(candidate, brief, { manual, considered, skips }) {
    const vapi = renderVapiVariables(brief);
    const { idea } = candidate;
    const pitch = await store.create({
      deskLedgerId: idea.ledgerId,
      symbol: idea.symbol,
      productId: brief.facts.productId,
      asset: vapi.variableValues.asset,
      conviction: idea.thesis.conviction,
      manual,
      engine: getEngine(),
      facts: brief.facts,
      words: brief.words,
      vapi,
      status: settings.dryRun ? "dry_run" : "dialing",
    });
    if (settings.dryRun) {
      log("pitch.dry_run", { pitchId: pitch.id, symbol: idea.symbol, firstMessage: vapi.firstMessage });
      emit({ kind: "pitch", type: "dialed", dryRun: true, pitchId: pitch.id, symbol: idea.symbol, asset: vapi.variableValues.asset, facts: brief.facts, at: now() });
      return { action: "dry_run", pitchId: pitch.id, symbol: idea.symbol, asset: vapi.variableValues.asset, vapi, considered, skips };
    }
    try {
      const { callId, voice, quota } = await dial(vapi, pitch);
      await store.recordDial();
      const calledAt = new Date(now()).toISOString();
      await store.update(pitch.id, { status: "in_call", vapiCallId: callId, calledAt, voice, elevenLabsRemaining: quota?.remaining ?? null });
      // Shows on the dashboard like an inbound call and marks the line busy.
      emit({ kind: "call", type: "incoming", direction: "outbound", callId, caller: settings.callTo, pitchId: pitch.id, title: `Jordan · ${idea.symbol}${pitch.engine === "realtime" ? " (realtime)" : ""}`, at: now() });
      emit({ kind: "pitch", type: "dialed", callId, pitchId: pitch.id, symbol: idea.symbol, asset: vapi.variableValues.asset, facts: brief.facts, at: now() });
      log("pitch.call.placed", { pitchId: pitch.id, callId, symbol: idea.symbol, engine: pitch.engine, voice, manual });
      return { action: "called", pitchId: pitch.id, callId, symbol: idea.symbol, asset: vapi.variableValues.asset, engine: pitch.engine, voice, considered, skips };
    } catch (error) {
      await store.update(pitch.id, { status: "failed", error: error.message });
      log("pitch.call.failed", { pitchId: pitch.id, symbol: idea.symbol, error: error.message });
      return { action: "failed", pitchId: pitch.id, symbol: idea.symbol, error: error.message, considered, skips };
    }
  }

  async function runOnce({ manual = false, symbol = null } = {}) {
    if (running) return { action: "none", reasons: ["scan_in_progress"] };
    running = scan({ manual, symbol })
      .catch((error) => {
        log("pitch.scan.failed", { error: error.message });
        return { action: "failed", error: error.message };
      })
      .finally(() => { running = null; });
    const result = await running;
    lastRun = { at: new Date(now()).toISOString(), manual, action: result.action, reasons: result.reasons ?? [], symbol: result.symbol ?? null };
    return result;
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      const tick = () => {
        if (!isMarketOpen(now())) return;
        runOnce().then((result) => {
          if (result.action !== "none") log("pitch.scan.result", { action: result.action, symbol: result.symbol ?? null });
        });
      };
      timer = setInterval(tick, settings.scanIntervalMin * MINUTE);
      timer.unref?.();
      setTimeout(tick, 30_000).unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    get lastRun() { return lastRun; },
    nextScanAt() {
      return timer ? new Date(Math.ceil(now() / (settings.scanIntervalMin * MINUTE)) * settings.scanIntervalMin * MINUTE).toISOString() : null;
    },
  };
}
