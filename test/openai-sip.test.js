import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import { createOpenAiSip, verifyWebhook } from "../src/agent/openai-sip.js";

const SECRET = "whsec_dGVzdHNlY3JldA=="; // base64("testsecret")

function signHeaders(rawBody, { id = "msg_1", timestamp = "1700000000" } = {}) {
  const key = Buffer.from(SECRET.slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${sig}` };
}

function fakeRes() {
  return {
    statusCode: 200, payload: undefined, sent: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
    sendStatus(c) { this.statusCode = c; this.sent = c; return this; },
  };
}

const incoming = (caller) => JSON.stringify({
  type: "realtime.call.incoming",
  data: { call_id: "call_123", sip_headers: [{ name: "From", value: `"x" <sip:${caller}@t.example>` }] },
});

test("verifyWebhook accepts a correct signature and rejects tampering", () => {
  const body = incoming("+15550001111");
  assert.equal(verifyWebhook(signHeaders(body), body, SECRET), true);
  assert.equal(verifyWebhook(signHeaders(body), body + "x", SECRET), false);
  assert.equal(verifyWebhook({}, body, SECRET), false);
  assert.equal(verifyWebhook({}, body, ""), true); // no secret configured -> allow (dev)
});

test("accepts an allowlisted caller and connects; rejects others", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, async text() { return "{}"; } }; };
  const emitted = [];
  let connected = null;
  const sip = createOpenAiSip({
    apiKey: "sk", model: "gpt-realtime-2025-08-28", voice: "marin", instructions: "hi",
    getToolDefinitions: () => [{ name: "check_balance", description: "d", parameters: { type: "object", properties: {} } }],
    registry: { execute: async () => "ok" },
    allowedCallers: ["+15550001111"], webhookSecret: SECRET,
    emit: (e) => emitted.push(e), fetchImpl,
    wsFactory: () => { connected = { onopen: null, onmessage: null, onclose: null, onerror: null, send() {} }; return connected; },
  });

  const okBody = incoming("+15550001111");
  const okRes = fakeRes();
  await sip.handleIncomingCall({ headers: signHeaders(okBody), body: Buffer.from(okBody) }, okRes);
  assert.equal(okRes.sent, 200);
  await new Promise((r) => setTimeout(r, 20)); // accept runs in the background after the 200 ack
  const acceptBody = calls.find((c) => c.url.endsWith("/accept"))?.body;
  assert.ok(acceptBody, "accepted the call");
  assert.equal(acceptBody.type, "realtime");
  assert.equal(acceptBody.model, "gpt-realtime-2025-08-28");
  assert.ok(acceptBody.instructions, "accept includes instructions");
  // tools/turn_detection are applied over the WS session.update, not the accept body.
  assert.equal(acceptBody.tools, undefined);

  const badBody = incoming("+19998887777");
  const badRes = fakeRes();
  await sip.handleIncomingCall({ headers: signHeaders(badBody), body: Buffer.from(badBody) }, badRes);
  assert.equal(badRes.sent, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.some((c) => c.url.endsWith("/reject")), "rejected the disallowed caller");
  assert.ok(emitted.some((e) => e.kind === "call" && e.type === "rejected"));
});

test("bad signature is refused with 401", async () => {
  const sip = createOpenAiSip({ apiKey: "sk", model: "m", voice: "marin", instructions: "x", getToolDefinitions: () => [], registry: { execute: async () => "" }, webhookSecret: SECRET, fetchImpl: async () => ({ ok: true, async text() { return "{}"; } }) });
  const body = incoming("+15550001111");
  const res = fakeRes();
  await sip.handleIncomingCall({ headers: { "webhook-id": "x", "webhook-timestamp": "1", "webhook-signature": "v1,wrong" }, body: Buffer.from(body) }, res);
  assert.equal(res.statusCode, 401);
});

test("runs the tool loop over the realtime socket and returns a function_call_output", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, async text() { return "{}"; } });
  const sent = [];
  const emitted = [];
  const registry = { execute: async (name, args) => `ran ${name} for ${args.productId || "-"}` };
  let ws;
  const sip = createOpenAiSip({
    apiKey: "sk", model: "gpt-live-1", voice: "marin", instructions: "hi",
    getToolDefinitions: () => [], registry, allowedCallers: [], webhookSecret: "",
    emit: (e) => emitted.push(e), fetchImpl,
    wsFactory: () => { ws = { onopen: null, onmessage: null, onclose: null, onerror: null, send: (s) => sent.push(JSON.parse(s)) }; return ws; },
  });
  sip.connect("call_9", "+15550001111");
  ws.onopen();
  assert.ok(sent.some((m) => m.type === "session.update"), "sends session.update on open");
  await ws.onmessage(JSON.stringify({ type: "response.function_call_arguments.done", name: "show_candle_chart", call_id: "fc_1", arguments: '{"productId":"BTC-USD"}' }));
  const output = sent.find((m) => m.type === "conversation.item.create");
  assert.equal(output.item.type, "function_call_output");
  assert.equal(output.item.call_id, "fc_1");
  assert.match(output.item.output, /ran show_candle_chart for BTC-USD/);
  assert.ok(sent.some((m) => m.type === "response.create"), "asks the model to continue");
  assert.ok(emitted.some((e) => e.kind === "tool" && e.type === "done"));
});
