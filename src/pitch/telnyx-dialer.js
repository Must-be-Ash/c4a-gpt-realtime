// Outbound dialing for the gpt-realtime-2.1 engine. Telnyx Call Control calls
// the owner; once answered, the call is transferred to OpenAI's SIP endpoint
// with an X-Pitch-Id header, and OpenAI's webhook takes it from there.
//
// Telnyx echoes our `client_state` on every webhook. It carries the pitch id
// plus an HMAC, so unsigned or foreign events are ignored.

import { createHmac, timingSafeEqual } from "node:crypto";

import { fetchJson } from "../lib/http.js";
import { PITCH_HEADER } from "./realtime-pitch.js";

const TELNYX_API = "https://api.telnyx.com/v2";

export function encodeClientState(pitchId, secret) {
  const sig = createHmac("sha256", secret).update(`pitch:${pitchId}`).digest("base64url");
  return Buffer.from(JSON.stringify({ p: pitchId, s: sig })).toString("base64");
}

export function decodeClientState(value, secret) {
  try {
    const { p, s } = JSON.parse(Buffer.from(String(value ?? ""), "base64").toString("utf8"));
    const expected = createHmac("sha256", secret).update(`pitch:${p}`).digest("base64url");
    const a = Buffer.from(String(s));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) ? String(p) : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.settings   { telnyxApiKey, telnyxConnectionId, phoneNumber, callTo, openAiProjectId, stateSecret, realtimeVoice }
 * @param {object} opts.store      pitch store
 */
export function createTelnyxPitchDialer({ settings, store, emit = () => {}, log = () => {}, request = fetchJson }) {
  const headers = { authorization: `Bearer ${settings.telnyxApiKey}`, "content-type": "application/json" };
  const telnyx = (path, body) => request(`${TELNYX_API}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });

  async function dial(_vapi, pitch, { to = settings.callTo } = {}) {
    for (const [name, value] of Object.entries({ TELNYX_API_KEY: settings.telnyxApiKey, TELNYX_PITCH_CONNECTION_ID: settings.telnyxConnectionId, PITCH_PHONE_NUMBER: settings.phoneNumber, OPENAI_PROJECT_ID: settings.openAiProjectId, PITCH_CALL_TO: to, SESSION_SECRET: settings.stateSecret })) {
      if (!value) throw new Error(`${name} is not configured.`);
    }
    const response = await telnyx("/calls", {
      connection_id: settings.telnyxConnectionId,
      to,
      from: settings.phoneNumber,
      client_state: encodeClientState(pitch.id, settings.stateSecret),
      timeout_secs: 30,
      time_limit_secs: 330,
    });
    const callId = response?.data?.call_control_id;
    if (!callId) throw new Error("Telnyx did not return a call_control_id.");
    return { callId, voice: `openai:${settings.realtimeVoice}`, quota: null };
  }

  async function onAnswered(pitch, payload) {
    await store.update(pitch.id, { answeredAt: new Date().toISOString() });
    await telnyx(`/calls/${encodeURIComponent(payload.call_control_id)}/actions/transfer`, {
      to: `sip:${settings.openAiProjectId}@sip.api.openai.com;transport=tls`,
      sip_transport_protocol: "TLS",
      from: settings.phoneNumber,
      custom_headers: [{ name: PITCH_HEADER, value: pitch.id }],
      client_state: payload.client_state,
      timeout_secs: 20,
    });
    log("pitch.realtime.transferred", { pitchId: pitch.id, callId: payload.call_control_id });
  }

  async function onHangup(pitch, payload) {
    const callId = payload.call_control_id;
    const latest = await store.get(pitch.id);
    if (latest && !latest.answeredAt && ["dialing", "in_call"].includes(latest.status)) {
      await store.update(pitch.id, { status: "no_answer", endedReason: payload.hangup_cause ?? null, endedAt: new Date().toISOString() });
      emit({ kind: "pitch", type: "ended", callId, pitchId: pitch.id, status: "no_answer", at: Date.now() });
    }
    emit({ kind: "end-of-call-report", callId, endedReason: payload.hangup_cause ?? "hangup", at: Date.now() });
    log("pitch.realtime.hangup", { pitchId: pitch.id, callId, cause: payload.hangup_cause ?? null, answered: Boolean(latest?.answeredAt) });
  }

  // Express handler for /telnyx/pitch-events.
  async function handleEvent(req, res) {
    res.sendStatus(200); // ack fast; Telnyx retries slow webhooks
    const data = req.body?.data;
    const payload = data?.payload ?? {};
    const pitchId = decodeClientState(payload.client_state, settings.stateSecret);
    if (!pitchId) {
      log("pitch.realtime.event_ignored", { type: data?.event_type ?? null });
      return;
    }
    const pitch = await store.get(pitchId);
    if (!pitch) return;
    try {
      if (data.event_type === "call.answered") await onAnswered(pitch, payload);
      else if (data.event_type === "call.hangup") await onHangup(pitch, payload);
      else log("pitch.realtime.event", { type: data.event_type, pitchId });
    } catch (error) {
      log("pitch.realtime.event_failed", { type: data.event_type, pitchId, error: error.message });
      if (data.event_type === "call.answered") {
        await store.update(pitch.id, { status: "failed", error: error.message });
        await telnyx(`/calls/${encodeURIComponent(payload.call_control_id)}/actions/hangup`, {}).catch(() => {});
      }
    }
  }

  return { dial, handleEvent };
}
