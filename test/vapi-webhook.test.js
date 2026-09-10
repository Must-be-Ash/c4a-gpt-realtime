import assert from "node:assert/strict";
import test from "node:test";

import { createVapiWebhook, normalizeToolCalls } from "../src/agent/vapi-webhook.js";

function fakeReq({ secret, body }) {
  return {
    headers: secret === undefined ? {} : { "x-vapi-secret": secret },
    get(name) { return this.headers[name.toLowerCase()]; },
    body,
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

const SECRET = "top-secret";
const fakeRegistry = {
  calls: [],
  async execute(name, args, ctx) {
    this.calls.push({ name, args, ctx });
    if (name === "boom") throw new Error("kaboom");
    return `ran ${name}`;
  },
};

test("rejects a request with a wrong or missing secret", async () => {
  const handler = createVapiWebhook({ registry: fakeRegistry, secret: SECRET, assistantId: "a1" });
  const res = fakeRes();
  await handler(fakeReq({ secret: "nope", body: { message: { type: "status-update" } } }), res);
  assert.equal(res.statusCode, 401);

  const res2 = fakeRes();
  await handler(fakeReq({ body: { message: { type: "status-update" } } }), res2);
  assert.equal(res2.statusCode, 401);
});

test("assistant-request allows the allowlisted caller and rejects others", async () => {
  const handler = createVapiWebhook({ registry: fakeRegistry, secret: SECRET, allowedCallers: ["+15550001111"], assistantId: "a1" });

  const ok = fakeRes();
  await handler(fakeReq({ secret: SECRET, body: { message: { type: "assistant-request", call: { customer: { number: "+15550001111" } } } } }), ok);
  assert.deepEqual(ok.payload, { assistantId: "a1" });

  const denied = fakeRes();
  await handler(fakeReq({ secret: SECRET, body: { message: { type: "assistant-request", call: { customer: { number: "+19999999999" } } } } }), denied);
  assert.ok(denied.payload.error, "unauthorized caller gets an error");
  assert.equal(denied.payload.assistantId, undefined);
});

test("tool-calls runs the registry and returns results keyed by toolCallId", async () => {
  fakeRegistry.calls = [];
  const emitted = [];
  const handler = createVapiWebhook({ registry: fakeRegistry, secret: SECRET, assistantId: "a1", emit: (e) => emitted.push(e) });
  const res = fakeRes();
  const body = { message: { type: "tool-calls", call: { id: "c1" }, toolCallList: [
    { id: "tc1", function: { name: "check_balance", arguments: "{}" } },
    { id: "tc2", function: { name: "show_candle_chart", arguments: { productId: "BTC-USD" } } },
  ] } };
  await handler(fakeReq({ secret: SECRET, body }), res);
  assert.deepEqual(res.payload.results.map((r) => r.toolCallId), ["tc1", "tc2"]);
  assert.equal(res.payload.results[0].result, "ran check_balance");
  assert.equal(fakeRegistry.calls[1].args.productId, "BTC-USD");
  assert.equal(fakeRegistry.calls[0].ctx.channel, "phone");
  assert.ok(emitted.some((e) => e.kind === "tool" && e.type === "done"));
});

test("a failing tool returns an error result without throwing", async () => {
  const handler = createVapiWebhook({ registry: fakeRegistry, secret: SECRET, assistantId: "a1" });
  const res = fakeRes();
  await handler(fakeReq({ secret: SECRET, body: { message: { type: "tool-calls", toolCallList: [{ id: "x", function: { name: "boom", arguments: "{}" } }] } } }), res);
  assert.match(res.payload.results[0].result, /Error: kaboom/);
});

test("transcript and end-of-call events emit and persist", async () => {
  const emitted = [];
  const ended = [];
  const handler = createVapiWebhook({ registry: fakeRegistry, secret: SECRET, assistantId: "a1", emit: (e) => emitted.push(e), onCallEnd: (r) => ended.push(r) });

  const tRes = fakeRes();
  await handler(fakeReq({ secret: SECRET, body: { message: { type: "transcript", role: "user", transcript: "buy bitcoin", transcriptType: "final", call: { id: "c9" } } } }), tRes);
  assert.equal(tRes.statusCode, 200);
  const transcript = emitted.find((e) => e.kind === "transcript");
  assert.equal(transcript.text, "buy bitcoin");
  assert.equal(transcript.role, "user");

  const eRes = fakeRes();
  await handler(fakeReq({ secret: SECRET, body: { message: { type: "end-of-call-report", endedReason: "customer-ended-call", call: { id: "c9" } } } }), eRes);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].endedReason, "customer-ended-call");
});

test("normalizeToolCalls handles both toolCallList and toolCalls shapes", () => {
  assert.deepEqual(
    normalizeToolCalls({ toolCallList: [{ id: "a", function: { name: "f", arguments: '{"x":1}' } }] }),
    [{ id: "a", name: "f", args: { x: 1 } }],
  );
  assert.deepEqual(
    normalizeToolCalls({ toolCalls: [{ id: "b", type: "function", function: { name: "g", arguments: { y: 2 } } }] }),
    [{ id: "b", name: "g", args: { y: 2 } }],
  );
});
