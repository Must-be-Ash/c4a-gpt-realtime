// Per-call latency tracker for the phone paths. Measures what the owner actually
// feels: the gap between finishing a command and hearing the agent, plus how long
// each tool took. Emits `latency` events to the dashboard/call store.

export function createLatencyTracker({ callId, emit = () => {}, now = Date.now }) {
  let speechEndedAt = null;
  const turns = [];
  const tools = [];
  const openTools = new Map();

  return {
    /** Caller finished speaking (VAD stop / final input transcript). */
    speechEnd() { speechEndedAt = now(); },
    /** First audible/visible agent output after the caller finished. */
    firstOutput() {
      if (speechEndedAt == null) return;
      const ms = now() - speechEndedAt;
      speechEndedAt = null;
      turns.push(ms);
      emit({ kind: "latency", type: "turn", callId, ms, at: now() });
    },
    toolStart(name) { openTools.set(name, now()); },
    toolDone(name) {
      const started = openTools.get(name);
      if (started == null) return;
      openTools.delete(name);
      const ms = now() - started;
      tools.push({ name, ms });
      emit({ kind: "latency", type: "tool", callId, name, ms, at: now() });
    },
    summary() {
      const sorted = [...turns].sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
      return { turns: turns.length, medianTurnMs: median, maxTurnMs: sorted.at(-1) ?? null, tools };
    },
    finish() {
      const summary = this.summary();
      emit({ kind: "latency", type: "summary", callId, ...summary, at: now() });
      return summary;
    },
  };
}
