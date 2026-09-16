// Persisted runtime settings for the hosted phone agents (lives on the Fly volume
// next to the call history). Today it holds the "armed" SIP agent — which OpenAI
// path answers the shared Telnyx number — and the dashboard's selected agent.
//
// activeSipAgent : what answers the Telnyx number ("gpt-realtime-2.1" | "gpt-live-1").
// selectedAgent  : what the dashboard dropdown shows (the above, or "vapi").
// pitchPaused    : true stops all outbound pitch calls (dashboard toggle).
// pitchEngine    : which Jordan places pitch calls ("elevenlabs" via Vapi | "realtime" gpt-realtime-2.1).
// Selecting an OpenAI agent arms it; selecting Vapi leaves the armed agent alone.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SIP_AGENTS = ["gpt-realtime-2.1", "gpt-live-1"];
export const AGENT_IDS = [...SIP_AGENTS, "vapi"];
export const PITCH_ENGINES = ["elevenlabs", "realtime"];
const DEFAULT_SIP_AGENT = "gpt-realtime-2.1";

export function agentCatalog({ telnyxNumber = "", vapiNumber = "" } = {}) {
  return [
    { id: "gpt-realtime-2.1", label: "gpt-realtime-2.1", transport: "openai-realtime-sip", number: telnyxNumber, armable: true },
    { id: "gpt-live-1", label: "gpt-live-1", transport: "openai-live-sip", number: telnyxNumber, armable: true },
    { id: "vapi", label: "Vapi (gpt-realtime)", transport: "vapi", number: vapiNumber, armable: false },
  ];
}

/**
 * @param {object} opts
 * @param {string} opts.dir                 Directory holding settings.json.
 * @param {string} [opts.defaultSipAgent]   Fallback armed agent when no file exists (env-driven).
 */
export function createSettingsStore({ dir, defaultSipAgent = DEFAULT_SIP_AGENT, defaultPitchEngine = "elevenlabs" }) {
  const filePath = join(dir, "settings.json");
  const fallbackSip = SIP_AGENTS.includes(defaultSipAgent) ? defaultSipAgent : DEFAULT_SIP_AGENT;
  const fallbackEngine = PITCH_ENGINES.includes(defaultPitchEngine) ? defaultPitchEngine : "elevenlabs";
  let state = { activeSipAgent: fallbackSip, selectedAgent: fallbackSip, pitchPaused: false, pitchEngine: fallbackEngine };

  const ready = (async () => {
    await mkdir(dir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(filePath, "utf8"));
      if (SIP_AGENTS.includes(saved.activeSipAgent)) state.activeSipAgent = saved.activeSipAgent;
      state.selectedAgent = AGENT_IDS.includes(saved.selectedAgent) ? saved.selectedAgent : state.activeSipAgent;
      state.pitchPaused = saved.pitchPaused === true;
      if (PITCH_ENGINES.includes(saved.pitchEngine)) state.pitchEngine = saved.pitchEngine;
    } catch {
      /* first boot or unreadable file -> defaults */
    }
  })();

  async function persist() {
    // Atomic: write a sibling temp file, then rename over the target.
    const tmp = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, filePath);
  }

  return {
    ready,
    async get() { await ready; return { ...state }; },
    /** Synchronous read for hot paths (webhooks); safe after `ready`. */
    activeSipAgent() { return state.activeSipAgent; },
    async select(agentId) {
      await ready;
      if (!AGENT_IDS.includes(agentId)) throw Object.assign(new Error(`Unknown agent: ${agentId}`), { status: 400 });
      state = {
        ...state,
        activeSipAgent: SIP_AGENTS.includes(agentId) ? agentId : state.activeSipAgent,
        selectedAgent: agentId,
      };
      await persist();
      return { ...state };
    },
    pitchPaused() { return state.pitchPaused; },
    pitchEngine() { return state.pitchEngine; },
    async setPitchEngine(engine) {
      await ready;
      if (!PITCH_ENGINES.includes(engine)) throw Object.assign(new Error(`Unknown pitch engine: ${engine}`), { status: 400 });
      state = { ...state, pitchEngine: engine };
      await persist();
      return { ...state };
    },
    async setPitchPaused(paused) {
      await ready;
      state = { ...state, pitchPaused: paused === true };
      await persist();
      return { ...state };
    },
  };
}
