// One OpenAI webhook endpoint, two APIs. A single inbound SIP call emits BOTH
// `realtime.call.incoming` (Realtime API) and `live.transport.incoming` (GPT-Live
// API); whichever API we accept through wins. So: verify + ack once, then act on
// exactly one event — chosen by the armed agent at call time — and ignore the other.

import { REALTIME_INCOMING_EVENT, verifyWebhook } from "./openai-sip.js";
import { LIVE_INCOMING_EVENTS } from "./openai-live.js";

// `isPitchCall(event)`: outbound pitch calls always run on the Realtime API,
// whichever agent is armed for inbound calls.
export function createOpenAiWebhookRouter({ secret, getArmedAgent, sip, live, isPitchCall = () => false, log = () => {} }) {
  return function handle(request, response) {
    const raw = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : String(request.body ?? "");
    log("openai.webhook.hit", { bytes: raw.length });
    if (!verifyWebhook(request.headers, raw, secret)) { response.status(401).json({ error: "invalid signature" }); return; }
    let event;
    try { event = JSON.parse(raw); } catch { response.status(400).json({ error: "bad json" }); return; }
    response.sendStatus(200); // ack first: OpenAI retries spawn duplicate call ids
    const armed = getArmedAgent();
    const isRealtime = event.type === REALTIME_INCOMING_EVENT;
    const isLive = LIVE_INCOMING_EVENTS.has(event.type);
    if (!isRealtime && !isLive) return;
    const pitch = isPitchCall(event);
    const acted = pitch ? isRealtime : (isRealtime && armed === "gpt-realtime-2.1") || (isLive && armed === "gpt-live-1");
    log("openai.webhook.routed", { type: event.type, armed, acted, pitch, id: event.data?.call_id || event.data?.session_id });
    if (!acted) return;
    if (isRealtime) sip.handleEvent(event); else live.handleEvent(event);
  };
}
