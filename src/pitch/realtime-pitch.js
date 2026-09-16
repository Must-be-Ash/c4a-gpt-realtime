// "Jordan" on gpt-realtime-2.1 (OpenAI direct over SIP). Telnyx dials the owner
// and transfers the answered call to OpenAI with an X-Pitch-Id header; this
// module recognizes that call and supplies the per-call session: Jordan's
// prompt filled with this pitch, the cedar voice, and the pitch tools.

import { callerFromSipHeaders } from "../agent/openai-live.js";
import { sipHeader } from "../agent/openai-sip.js";
import { executePitchTool, pitchCallContext } from "./tool-exec.js";
import { PITCH_TOOL_DEFINITIONS, PITCH_TOOL_NAMES } from "./tools.js";

export const PITCH_HEADER = "X-Pitch-Id";
const MAX_SETUP_MS = 10 * 60_000;
const LIVE_STATUSES = new Set(["dialing", "in_call"]);

export const END_CALL_TOOL = {
  name: "end_call",
  description: "Hang up. Say your one-line goodbye first, then call this.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const REALTIME_ADDENDUM = `

## Live phone call (speech to speech)
- You speak first: your opening line is sent to you as the first instruction. Then go straight into the pitch.
- Keep each turn to two or three short sentences, then stop and listen. If he talks over you, stop and answer him.
- Voicemail: if you hear a recorded greeting, "leave a message", or a beep instead of a person, leave this message once: "{{voicemailMessage}}". Then call record_pitch_outcome with "voicemail" and call end_call. Don't pitch a machine.
- When the call is done (bought, declined, thinking, or voicemail), say one short goodbye and call end_call.`;

export function renderPrompt(template, variables) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(variables?.[key] ?? ""));
}

/**
 * @param {object} deps
 * @param {object} deps.store            pitch store
 * @param {object} deps.registry         shared tool registry
 * @param {object} deps.runners          pitch tool runners
 * @param {string} deps.promptTemplate   PITCH_AGENT.md
 * @param {Array}  deps.sharedDefinitions static tool definitions (check_balance, preview_order, execute_order)
 * @param {object} deps.settings         { maxOrderUsd, realtimeVoice, realtimeModel, phoneNumber }
 * @param {(e:object)=>void} [deps.emit]
 * @param {(n:string,d:object)=>void} [deps.log]
 */
export function createRealtimePitch({ store, registry, runners, promptTemplate, sharedDefinitions, settings, emit = () => {}, log = () => {}, now = () => Date.now() }) {
  const toolNames = [...PITCH_TOOL_NAMES, END_CALL_TOOL.name];
  const toolDefinitions = [
    ...sharedDefinitions.filter((d) => PITCH_TOOL_NAMES.includes(d.name)),
    ...PITCH_TOOL_DEFINITIONS,
    END_CALL_TOOL,
  ];

  // A pitch call carries our header; as a backstop, anything from the pitch
  // number is treated as one so GPT-Live never picks it up.
  function isPitchCall(event) {
    const headers = event?.data?.sip_headers;
    if (sipHeader(headers, PITCH_HEADER)) return true;
    return Boolean(settings.phoneNumber) && callerFromSipHeaders(headers) === settings.phoneNumber;
  }

  async function resolveCall(event) {
    const pitchId = sipHeader(event?.data?.sip_headers, PITCH_HEADER);
    if (!pitchId) return null;
    const pitch = await store.get(pitchId.trim());
    const fresh = pitch && now() - Date.parse(pitch.createdAt) < MAX_SETUP_MS;
    if (!pitch || pitch.engine !== "realtime" || !LIVE_STATUSES.has(pitch.status) || !fresh) {
      log("pitch.realtime.unknown_call", { pitchId, status: pitch?.status ?? null, engine: pitch?.engine ?? null });
      return null;
    }
    const callId = event.data?.call_id;
    await store.update(pitch.id, { status: "in_call", openaiCallId: callId, connectedAt: new Date(now()).toISOString() });
    const variables = pitch.vapi?.variableValues ?? {};
    const instructions = renderPrompt(promptTemplate + REALTIME_ADDENDUM, { ...variables, voicemailMessage: pitch.vapi?.voicemailMessage ?? "" });
    const ctx = pitchCallContext(pitch, settings.maxOrderUsd);
    return {
      model: settings.realtimeModel,
      voice: settings.realtimeVoice,
      instructions,
      firstMessage: pitch.vapi?.firstMessage,
      toolDefinitions,
      title: `Jordan · ${pitch.symbol} (realtime)`,
      ctx,
      async execute(name, args, callCtx, controls) {
        if (name === END_CALL_TOOL.name) {
          controls.endAfterThis();
          return JSON.stringify({ ok: true });
        }
        // Re-read so outcomes recorded earlier in the call are respected.
        const current = (await store.get(pitch.id)) ?? pitch;
        return executePitchTool({ name, args, ctx: { ...callCtx, pitch: current }, registry, runners, toolNames, store });
      },
      async onEnd(reason) {
        const latest = await store.get(pitch.id);
        if (latest && LIVE_STATUSES.has(latest.status)) {
          await store.update(pitch.id, { status: "no_decision", endedReason: reason, endedAt: new Date(now()).toISOString() });
          emit({ kind: "pitch", type: "ended", callId, pitchId: pitch.id, status: "no_decision", at: now() });
        } else if (latest) {
          emit({ kind: "pitch", type: "ended", callId, pitchId: pitch.id, status: latest.status, at: now() });
        }
      },
    };
  }

  return { isPitchCall, resolveCall, toolDefinitions };
}
