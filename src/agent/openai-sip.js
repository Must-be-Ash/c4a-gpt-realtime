// Direct OpenAI Realtime (SIP) phone handler — no Vapi in the path.
//
// Flow: a SIP trunk (e.g. Telnyx) points the phone number at OpenAI's SIP
// endpoint. On an inbound call OpenAI POSTs `realtime.call.incoming` to our
// webhook; we verify the signature, enforce the caller allowlist, then ACCEPT
// the call with a session config (model — gpt-realtime today, gpt-live-1 when
// available — instructions, tools, and native semantic-VAD barge-in). We then
// open the realtime WebSocket to run the tool loop (reusing the shared registry)
// and stream transcripts/tool activity to the dashboard.
//
// fetchImpl and wsFactory are injectable so the logic is unit-testable.

import { createHmac, timingSafeEqual } from "node:crypto";

import { WebSocket } from "ws";

const OPENAI_API = "https://api.openai.com/v1";
const REALTIME_WS = "wss://api.openai.com/v1/realtime";

// Native barge-in tuned like the local app (this is the control Vapi didn't give us).
const TURN_DETECTION = { type: "semantic_vad", eagerness: "medium", create_response: true, interrupt_response: true };

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// Standard-Webhooks verification (OpenAI signs webhooks this way).
// Headers: webhook-id, webhook-timestamp, webhook-signature ("v1,<base64>[ v1,...]").
export function verifyWebhook(headers, rawBody, secret) {
  if (!secret) return true; // not configured (dev) -> allow
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const sigHeader = headers["webhook-signature"];
  if (!id || !timestamp || !sigHeader) return false;
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
  const signed = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", key).update(signed).digest("base64");
  return sigHeader.split(" ").some((part) => safeEqual(part.split(",")[1] || part, expected));
}

function callerFromSipHeaders(sipHeaders) {
  const from = (sipHeaders || []).find((h) => String(h.name).toLowerCase() === "from");
  if (!from) return null;
  const match = String(from.value).match(/<sip:\+?([0-9]+)@|<tel:\+?([0-9]+)|sip:\+?([0-9]+)@/i);
  const digits = match ? (match[1] || match[2] || match[3]) : null;
  return digits ? `+${digits}` : null;
}

const toOpenAiTool = (definition) => ({
  type: "function",
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
});

/**
 * @param {object} opts
 * @param {string} opts.apiKey            OpenAI API key (BYOK).
 * @param {string} opts.model             Realtime model (e.g. "gpt-realtime-2025-08-28" or "gpt-live-1").
 * @param {string} opts.voice             Realtime voice.
 * @param {string} opts.instructions      System prompt (AGENT.md + phone addendum).
 * @param {() => Array} opts.getToolDefinitions  Returns [{name,description,parameters}].
 * @param {{execute:Function}} opts.registry     Shared tool registry.
 * @param {string[]} [opts.allowedCallers]       Inbound allowlist (empty = allow all).
 * @param {string} [opts.webhookSecret]          OpenAI webhook signing secret (whsec_...).
 * @param {(e:object)=>void} [opts.emit]         Dashboard event bus.
 * @param {(report:object)=>void} [opts.onCallEnd] Persistence hook.
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(url:string, opts:object)=>object} [opts.wsFactory]  Returns a ws-like object.
 */
export function createOpenAiSip({
  apiKey, model, voice, instructions, getToolDefinitions,
  registry, allowedCallers = [], webhookSecret,
  emit = () => {}, onCallEnd,
  fetchImpl = fetch, wsFactory,
}) {
  if (!registry?.execute) throw new Error("createOpenAiSip requires a registry with execute().");

  const authHeaders = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  async function accept(callId) {
    const session = {
      type: "realtime",
      model,
      instructions,
      audio: { output: { voice } },
      tools: (getToolDefinitions?.() || []).map(toOpenAiTool),
      turn_detection: TURN_DETECTION,
    };
    return fetchImpl(`${OPENAI_API}/realtime/calls/${callId}/accept`, {
      method: "POST", headers: authHeaders, body: JSON.stringify(session),
    });
  }

  const reject = (callId) =>
    fetchImpl(`${OPENAI_API}/realtime/calls/${callId}/reject`, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ status_code: 486 }),
    });

  const hangup = (callId) =>
    fetchImpl(`${OPENAI_API}/realtime/calls/${callId}/hangup`, { method: "POST", headers: authHeaders }).catch(() => {});

  // Express handler for OpenAI's inbound-call webhook. Expects the RAW body buffer.
  async function handleIncomingCall(request, response) {
    const raw = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : (typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {}));
    if (!verifyWebhook(request.headers, raw, webhookSecret)) {
      response.status(401).json({ error: "invalid signature" });
      return;
    }
    let event;
    try { event = JSON.parse(raw); } catch { response.status(400).json({ error: "bad json" }); return; }
    if (event.type !== "realtime.call.incoming") { response.sendStatus(200); return; }

    const callId = event.data?.call_id;
    const caller = callerFromSipHeaders(event.data?.sip_headers);
    if (allowedCallers.length && !allowedCallers.includes(caller)) {
      emit({ kind: "call", type: "rejected", callId, caller, at: Date.now() });
      await reject(callId).catch(() => {});
      response.sendStatus(200);
      return;
    }
    try {
      await accept(callId);
      response.sendStatus(200);
      connect(callId, caller); // manage the session (tools + transcripts) in the background
    } catch (error) {
      emit({ kind: "error", callId, error: error.message, at: Date.now() });
      response.status(502).json({ error: error.message });
    }
  }

  // Open the realtime control WebSocket and run the tool loop.
  function connect(callId, caller) {
    const url = `${REALTIME_WS}?call_id=${encodeURIComponent(callId)}`;
    const headers = { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "realtime=v1" };
    // Must use the `ws` package (not Node's global WebSocket) — OpenAI needs the
    // Authorization header, which the browser-spec WebSocket constructor can't set.
    const ws = wsFactory ? wsFactory(url, { headers }) : new WebSocket(url, { headers });
    const ctx = { callId, channel: "phone", emit: (e) => emit({ callId, ...e }) };
    const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ } };

    emit({ kind: "call", type: "incoming", callId, caller, at: Date.now() });

    ws.onopen = () => {
      send({
        type: "session.update",
        session: {
          instructions,
          tools: (getToolDefinitions?.() || []).map(toOpenAiTool),
          turn_detection: TURN_DETECTION,
        },
      });
      emit({ kind: "status-update", callId, status: "in-progress", at: Date.now() });
    };

    ws.onmessage = async (raw) => {
      let msg;
      try { msg = JSON.parse(typeof raw === "string" ? raw : raw.data); } catch { return; }
      switch (msg.type) {
        case "response.function_call_arguments.done": {
          let args = {};
          try { args = JSON.parse(msg.arguments || "{}"); } catch { args = {}; }
          emit({ kind: "tool", type: "start", callId, name: msg.name, at: Date.now() });
          let output;
          try {
            const result = await registry.execute(msg.name, args, ctx);
            output = typeof result === "string" ? result : JSON.stringify(result);
            emit({ kind: "tool", type: "done", callId, name: msg.name, at: Date.now() });
          } catch (error) {
            output = `Error: ${error.message}`;
            emit({ kind: "tool", type: "error", callId, name: msg.name, error: error.message, at: Date.now() });
          }
          send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: msg.call_id, output } });
          send({ type: "response.create" });
          break;
        }
        case "conversation.item.input_audio_transcription.completed":
          emit({ kind: "transcript", callId, role: "user", transcriptType: "final", text: msg.transcript || "", at: Date.now() });
          break;
        case "response.output_audio_transcript.done":
          emit({ kind: "transcript", callId, role: "assistant", transcriptType: "final", text: msg.transcript || "", at: Date.now() });
          break;
        case "error":
          emit({ kind: "error", callId, error: msg.error?.message || "realtime error", at: Date.now() });
          break;
        default:
          break;
      }
    };

    const finish = async (reason) => {
      emit({ kind: "end-of-call-report", callId, endedReason: reason, at: Date.now() });
      if (onCallEnd) await onCallEnd({ call: { id: callId }, endedReason: reason });
    };
    ws.onclose = () => finish("call-ended");
    ws.onerror = (event) => emit({ kind: "error", callId, error: event?.message || "ws error", at: Date.now() });

    return { ws, hangup: () => hangup(callId) };
  }

  return { handleIncomingCall, accept, reject, hangup, connect, verifyWebhook: (h, b) => verifyWebhook(h, b, webhookSecret) };
}
