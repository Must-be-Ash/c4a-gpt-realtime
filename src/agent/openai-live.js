// gpt-live-1 phone handler — OpenAI **GPT-Live API** over SIP (not the Realtime API).
//
// GPT-Live is a full-duplex voice layer that delegates reasoning + tool calls to a
// backend model ("Responses delegation"). Our tool registry still executes the
// tools; the backend decides when to call them. Contract (verified 2026-09-10,
// see AGENT_SWITCHER_SPEC.md §3):
//   webhook  live.transport.incoming  -> data.session_id
//   accept   POST /v1/live/sessions/{id}/accept  { session: {...} }
//   attach   wss://api.openai.com/v1/live/sessions/{id}/attach  (no session.start)
//   tools    response.event{ event: response.output_item.done, item: function_call }
//            -> response.item.create(function_call_output) + response.create
//
// fetchImpl / wsFactory are injectable for unit tests (same pattern as openai-sip.js).

import { WebSocket } from "ws";

import { createLatencyTracker } from "./latency.js";

const OPENAI_API = "https://api.openai.com/v1";
const LIVE_WS = "wss://api.openai.com/v1/live/sessions";

export const LIVE_INCOMING_EVENTS = new Set(["live.transport.incoming", "live.call.incoming"]);

export function callerFromSipHeaders(sipHeaders) {
  const from = (sipHeaders || []).find((h) => String(h.name).toLowerCase() === "from");
  if (!from) return null;
  const match = String(from.value).match(/<sip:\+?([0-9]+)@|<tel:\+?([0-9]+)|sip:\+?([0-9]+)@/i);
  const digits = match ? (match[1] || match[2] || match[3]) : null;
  return digits ? `+${digits}` : null;
}

// Responses-API function tool shape (flat). If accept ever 400s on tools, the
// nested { type:"function", function:{...} } form is the fallback — see spec §3.
const toResponsesTool = (definition) => ({
  type: "function",
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
});

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]               "gpt-live-1"
 * @param {string} opts.backendModel          Delegation backend, e.g. "gpt-5.6-luna".
 * @param {string} opts.voice
 * @param {string} opts.voiceInstructions     Short voice-layer prompt (tone, interruptions, when to delegate).
 * @param {string} opts.backendInstructions   Full agent prompt + phone addendum (tools live here).
 * @param {() => Array} opts.getToolDefinitions
 * @param {{execute:Function}} opts.registry
 * @param {string[]} [opts.allowedCallers]
 */
export function createOpenAiLive({
  apiKey, model = "gpt-live-1", backendModel, reasoningEffort = "low", voice, voiceInstructions, backendInstructions,
  getToolDefinitions, registry, allowedCallers = [],
  greeting = "Hey — your trading agent here. What do you want to look at?",
  emit = () => {}, onCallEnd, log = () => {},
  fetchImpl = fetch, wsFactory,
}) {
  if (!registry?.execute) throw new Error("createOpenAiLive requires a registry with execute().");
  if (!backendModel) throw new Error("createOpenAiLive requires a backendModel.");

  const authHeaders = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  function sessionConfig() {
    return {
      type: "live",
      model,
      instructions: voiceInstructions,
      audio: { output: { voice } },
      delegation: {
        type: "responses",
        responses: {
          model: backendModel,
          instructions: backendInstructions,
          tools: (getToolDefinitions?.() || []).map(toResponsesTool),
          tool_choice: "auto",
          parallel_tool_calls: true,
          // Latency lever: low effort on the delegation backend (owner decision 2026-09-10).
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        },
      },
    };
  }

  const accept = (sessionId) =>
    fetchImpl(`${OPENAI_API}/live/sessions/${sessionId}/accept`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ session: sessionConfig() }),
    });

  const reject = (sessionId) =>
    fetchImpl(`${OPENAI_API}/live/sessions/${sessionId}/reject`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ status_code: 486 }),
    });

  const hangup = (sessionId) =>
    fetchImpl(`${OPENAI_API}/live/sessions/${sessionId}/hangup`, { method: "POST", headers: authHeaders }).catch(() => {});

  /** Handle an already-verified, parsed `live.transport.incoming` webhook event. */
  function handleEvent(event) {
    if (!LIVE_INCOMING_EVENTS.has(event?.type)) return false;
    const sessionId = event.data?.session_id;
    const caller = callerFromSipHeaders(event.data?.sip_headers);
    log("openai.live.incoming", { sessionId, caller, transport: event.data?.type });
    if (!sessionId) return false;
    if (allowedCallers.length && !allowedCallers.includes(caller)) {
      log("openai.live.rejected_allowlist", { sessionId, caller });
      emit({ kind: "call", type: "rejected", callId: sessionId, caller, at: Date.now() });
      reject(sessionId).catch(() => {});
      return true;
    }
    (async () => {
      try {
        const acc = await accept(sessionId);
        const body = await acc.text().catch(() => "");
        if (!acc.ok) {
          log("openai.live.accept_failed", { sessionId, status: acc.status, body: body.slice(0, 500) });
          emit({ kind: "error", callId: sessionId, error: `live accept failed (${acc.status})`, at: Date.now() });
          return;
        }
        log("openai.live.accepted", { sessionId, caller, model, backendModel });
        connect(sessionId, caller);
      } catch (error) {
        log("openai.live.accept_error", { sessionId, error: error.message });
        emit({ kind: "error", callId: sessionId, error: error.message, at: Date.now() });
      }
    })();
    return true;
  }

  // Attach a sideband socket to the running live session and run the tool loop.
  function connect(sessionId, caller) {
    const callId = sessionId;
    const url = `${LIVE_WS}/${encodeURIComponent(sessionId)}/attach`;
    const headers = { Authorization: `Bearer ${apiKey}` };
    const ctx = { callId, channel: "phone", emit: (event) => emit({ callId, ...event }) };
    const latency = createLatencyTracker({ callId, emit });
    const MAX_ATTEMPTS = 4;
    const RETRY_MS = 600;
    let finished = false;
    let userBuffer = "";
    let assistantBuffer = "";

    emit({ kind: "call", type: "incoming", callId, caller, agent: "gpt-live-1", at: Date.now() });

    const finish = async (reason) => {
      if (finished) return;
      finished = true;
      latency.finish();
      emit({ kind: "end-of-call-report", callId, endedReason: reason, at: Date.now() });
      if (onCallEnd) await onCallEnd({ call: { id: callId }, endedReason: reason });
    };

    const attempt = (n) => {
      const ws = wsFactory ? wsFactory(url, { headers }) : new WebSocket(url, { headers });
      const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ } };
      let opened = false;

      ws.onopen = () => {
        opened = true;
        log("openai.live.ws_open", { callId, attempt: n });
        // Session is already running (accepted) — never re-send session.start.
        if (greeting) {
          send({
            type: "session.instructions.append",
            event_id: "greeting",
            delegation_id: null,
            content: `Greet the caller immediately without waiting for them to speak, in one short sentence: "${greeting}". Then pause and listen.`,
          });
        }
        emit({ kind: "status-update", callId, status: "in-progress", at: Date.now() });
      };

      const flushUser = () => {
        const text = userBuffer.trim();
        userBuffer = "";
        if (text) emit({ kind: "transcript", callId, role: "user", transcriptType: "final", text, at: Date.now() });
      };
      const flushAssistant = () => {
        const text = assistantBuffer.trim();
        assistantBuffer = "";
        if (text) emit({ kind: "transcript", callId, role: "assistant", transcriptType: "final", text, at: Date.now() });
      };

      async function runTool(item, delegationId) {
        let args = {};
        try { args = JSON.parse(item.arguments || "{}"); } catch { args = {}; }
        emit({ kind: "tool", type: "start", callId, name: item.name, at: Date.now() });
        latency.toolStart(item.name);
        let output;
        try {
          const result = await registry.execute(item.name, args, ctx);
          output = typeof result === "string" ? result : JSON.stringify(result);
          emit({ kind: "tool", type: "done", callId, name: item.name, at: Date.now() });
        } catch (error) {
          output = `Error: ${error.message}`;
          emit({ kind: "tool", type: "error", callId, name: item.name, error: error.message, at: Date.now() });
        }
        latency.toolDone(item.name);
        log("openai.live.tool_output", { callId, name: item.name, delegationId });
        send({ type: "response.item.create", item: { type: "function_call_output", call_id: item.call_id, output } });
      }

      // Backend may issue several parallel calls; submit every output before continuing.
      const pending = new Map(); // delegationId -> Promise[]
      const scheduleContinue = (delegationId) => {
        const batch = pending.get(delegationId) || [];
        pending.delete(delegationId);
        Promise.all(batch).then(() => send({ type: "response.create" }));
      };

      ws.onmessage = async (raw) => {
        let msg;
        try { msg = JSON.parse(typeof raw === "string" ? raw : raw.data); } catch { return; }
        const type = msg.type || "";
        if (type === "response.event") {
          const inner = msg.event || {};
          const delegationId = msg.delegation_id || null;
          if (inner.type === "response.output_item.done" && inner.item?.type === "function_call") {
            const list = pending.get(delegationId) || [];
            list.push(runTool(inner.item, delegationId));
            pending.set(delegationId, list);
            // Continue once this tick's calls are collected (parallel calls arrive back-to-back).
            queueMicrotask(() => { if (pending.has(delegationId)) scheduleContinue(delegationId); });
          }
          return;
        }
        if (type.startsWith("session.input_transcript")) {
          if (type.endsWith(".delta")) { userBuffer += msg.delta || ""; return; }
          if (msg.transcript) userBuffer = msg.transcript; else userBuffer += msg.delta || "";
          flushUser();
          latency.speechEnd();
          return;
        }
        if (type.startsWith("session.output_transcript")) {
          if (type.endsWith(".delta")) {
            if (!assistantBuffer) latency.firstOutput();
            assistantBuffer += msg.delta || "";
            return;
          }
          if (msg.transcript) assistantBuffer = msg.transcript; else assistantBuffer += msg.delta || "";
          flushAssistant();
          return;
        }
        switch (type) {
          case "session.output_audio.delta":
            latency.firstOutput();
            break;
          case "session.usage.updated":
            emit({ kind: "usage", callId, usage: msg.usage ?? msg, at: Date.now() });
            break;
          case "session.closed":
            log("openai.live.session_closed", { callId, reason: msg.reason, usage: msg.usage });
            flushUser(); flushAssistant();
            finish(msg.reason || "session-closed");
            break;
          case "error":
            log("openai.live.error", { callId, error: msg.error });
            emit({ kind: "error", callId, error: msg.error?.message || "live error", at: Date.now() });
            break;
          default:
            break;
        }
      };

      ws.onerror = (event) => { log("openai.live.ws_error", { callId, attempt: n, error: event?.message || "ws error" }); };

      ws.onclose = () => {
        if (!opened && n < MAX_ATTEMPTS && !finished) {
          log("openai.live.ws_retry", { callId, next: n + 1 });
          setTimeout(() => attempt(n + 1), RETRY_MS);
          return;
        }
        if (opened) { log("openai.live.ws_close", { callId }); flushUser(); flushAssistant(); finish("call-ended"); }
        else { log("openai.live.ws_giveup", { callId, attempts: n }); finish("ws-connect-failed"); }
      };
    };

    attempt(1);
    return { hangup: () => hangup(sessionId) };
  }

  return { handleEvent, accept, reject, hangup, connect, sessionConfig };
}
