// Call gates: whether we may dial *right now*, independent of the idea.
// Returns the list of reasons blocking a call (empty = go).

import { isMarketOpen } from "./market-hours.js";

const MINUTE = 60_000;

/**
 * @param {object} state
 * @param {boolean} state.paused
 * @param {number}  state.callsToday      dials so far this ET day (voicemails count)
 * @param {number|null} state.lastDialAt  ms
 * @param {boolean} state.callInProgress  any live call on any agent
 * @param {object} settings                config.pitch
 * @param {object} [opts]
 * @param {boolean} [opts.manual]          "Pitch me now": skips spacing (and hours for spot)
 * @param {string}  [opts.kind]            product kind of the candidate, when known
 * @param {number}  [opts.now]
 */
export function callGateReasons(state, settings, { manual = false, kind = null, now = Date.now() } = {}) {
  const reasons = [];
  if (state.paused) reasons.push("paused");
  if (state.callInProgress) reasons.push("call_in_progress");
  if (state.callsToday >= settings.maxCallsPerDay) reasons.push("daily_cap_reached");
  const hoursExempt = manual && kind === "spot";
  if (!hoursExempt && !isMarketOpen(now)) reasons.push("outside_call_hours");
  if (!manual && state.lastDialAt && now - state.lastDialAt < settings.minSpacingMin * MINUTE) reasons.push("too_soon_since_last_call");
  return reasons;
}
