// Tools only the pitch assistant ("Jordan") can call. The shared registry
// supplies check_balance / preview_order / execute_order; these two talk to
// the pitch store for the call's context and outcome.

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const PITCH_TOOL_NAMES = ["get_active_pitch", "check_balance", "preview_order", "execute_order", "record_pitch_outcome"];

export const PITCH_TOOL_DEFINITIONS = [
  {
    name: "get_active_pitch",
    description: "Return the full brief for the trade being pitched on this call (or the latest unresolved pitch on a callback). Use when the pitch details are missing or the client asks for something in the brief.",
    parameters: obj({}),
  },
  {
    name: "record_pitch_outcome",
    description: "Record the outcome of this pitch once it is clear: bought (after execute_order succeeds), declined, thinking (wants time / will call back), or voicemail (you reached voicemail and left the teaser).",
    parameters: obj({
      outcome: { type: "string", enum: ["bought", "declined", "thinking", "voicemail"] },
      note: { type: "string", description: "Short note, e.g. '2 shares' or 'too risky before earnings'." },
    }, ["outcome"]),
  },
];

/**
 * Runtime implementations, keyed by name. `ctx.pitch` is set by the webhook
 * when the call belongs to a pitch.
 * @param {object} deps
 * @param {object} deps.store   pitch store
 */
export function createPitchToolRunners({ store }) {
  return {
    async get_active_pitch(_args, ctx) {
      const pitch = ctx.pitch ?? (await store.latestUnresolved());
      if (!pitch) return JSON.stringify({ pitch: null, instruction: "Nothing is pending. Tell him nothing on the desk is worth his money right now and end the call." });
      return JSON.stringify({ pitch: store.briefForAgent(pitch), instruction: "Use only these facts." });
    },
    async record_pitch_outcome(args, ctx) {
      const pitch = ctx.pitch ?? (await store.latestUnresolved());
      if (!pitch) return JSON.stringify({ ok: false, error: "No pitch on this call." });
      const outcome = String(args?.outcome ?? "");
      if (!["bought", "declined", "thinking", "voicemail"].includes(outcome)) throw new Error("outcome must be bought, declined, thinking, or voicemail.");
      const status = { bought: "bought", declined: "declined", thinking: "no_decision", voicemail: "voicemail" }[outcome];
      await store.update(pitch.id, { status, outcome, outcomeNote: String(args?.note ?? "").slice(0, 200), decidedAt: new Date().toISOString() });
      ctx.emit?.({ kind: "pitch", type: "outcome", pitchId: pitch.id, outcome });
      return JSON.stringify({ ok: true, instruction: "Recorded. Wrap up in one line and end the call." });
    },
  };
}
