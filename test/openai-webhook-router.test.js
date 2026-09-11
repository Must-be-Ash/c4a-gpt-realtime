import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiWebhookRouter } from "../src/agent/openai-webhook-router.js";

const res = () => ({ sent: null, statusCode: 200, sendStatus(c) { this.sent = c; }, status(c) { this.statusCode = c; return this; }, json() {} });
const req = (event) => ({ headers: {}, body: Buffer.from(JSON.stringify(event)) });
const realtime = { type: "realtime.call.incoming", data: { call_id: "rtc_1" } };
const liveEvt = { type: "live.transport.incoming", data: { type: "sip", session_id: "live_1" } };

function setup(armed) {
  const sip = { handled: [], handleEvent(e) { this.handled.push(e.type); return true; } };
  const live = { handled: [], handleEvent(e) { this.handled.push(e.type); return true; } };
  const handle = createOpenAiWebhookRouter({ secret: "", getArmedAgent: () => armed, sip, live });
  return { handle, sip, live };
}

test("armed gpt-realtime-2.1: acts on the realtime event, ignores the live one", () => {
  const { handle, sip, live } = setup("gpt-realtime-2.1");
  const r1 = res(); handle(req(realtime), r1); assert.equal(r1.sent, 200);
  const r2 = res(); handle(req(liveEvt), r2); assert.equal(r2.sent, 200);
  assert.deepEqual(sip.handled, ["realtime.call.incoming"]);
  assert.deepEqual(live.handled, []);
});

test("armed gpt-live-1: acts on the live event, ignores the realtime one", () => {
  const { handle, sip, live } = setup("gpt-live-1");
  handle(req(realtime), res());
  handle(req(liveEvt), res());
  handle(req({ type: "live.call.incoming", data: { session_id: "live_legacy" } }), res());
  assert.deepEqual(sip.handled, []);
  assert.deepEqual(live.handled, ["live.transport.incoming", "live.call.incoming"]);
});

test("acks unrelated events and rejects bad json", () => {
  const { handle, sip, live } = setup("gpt-live-1");
  const r = res(); handle(req({ type: "response.completed" }), r); assert.equal(r.sent, 200);
  const bad = res(); handle({ headers: {}, body: Buffer.from("{nope") }, bad); assert.equal(bad.statusCode, 400);
  assert.equal(sip.handled.length + live.handled.length, 0);
});
