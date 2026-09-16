import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVapiWebhook, pitchStatusForEndedReason } from "../src/agent/vapi-webhook.js";
import { createPitchStore } from "../src/pitch/pitch-store.js";
import { createPitchToolRunners, PITCH_TOOL_NAMES } from "../src/pitch/tools.js";

const SECRET = "s";
const OWNER = "+15550001111";
const PITCH_NUMBER_ID = "pn-pitch";
const PITCH_ASSISTANT = "asst-jordan";

const req = (message) => ({ headers: { "x-vapi-secret": SECRET }, get(name) { return this.headers[name.toLowerCase()]; }, body: { message } });
const res = () => ({ statusCode: 200, payload: undefined, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pitchhook-"));
  const store = createPitchStore({ dir });
  const calls = [];
  const events = [];
  const registry = {
    async execute(name, args, ctx) {
      calls.push({ name, args, ctx });
      if (name === "execute_order") return JSON.stringify({ result: { order_id: "ord-1" } });
      return `ran ${name}`;
    },
  };
  const handler = createVapiWebhook({
    registry,
    secret: SECRET,
    allowedCallers: [OWNER],
    assistantId: "asst-main",
    emit: (e) => events.push(e),
    pitch: { phoneNumberId: PITCH_NUMBER_ID, assistantId: PITCH_ASSISTANT, store, runners: createPitchToolRunners({ store }), toolNames: PITCH_TOOL_NAMES, maxOrderUsd: 500 },
  });
  const pitch = await store.create({
    symbol: "NKE", productId: "NKE-USD", status: "in_call", vapiCallId: "call-out", calledAt: new Date().toISOString(),
    vapi: { firstMessage: "Jordan here.", variableValues: { asset: "Nike", hook: "h" } },
  });
  const run = async (message) => { const r = res(); await handler(req(message), r); return r; };
  const toolCall = (callId, name, args = {}, extra = {}) => run({
    type: "tool-calls",
    call: { id: callId, assistantId: PITCH_ASSISTANT, phoneNumberId: PITCH_NUMBER_ID, ...extra },
    toolCallList: [{ id: "t1", function: { name, arguments: args } }],
  });
  return { store, calls, events, run, toolCall, pitch, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("pitch calls get the order guard from call context", async () => {
  const s = await setup();
  try {
    const r = await s.toolCall("call-out", "preview_order", { productId: "NKE-USD", side: "BUY", type: "market", amount: 100000, amountType: "quote" });
    assert.equal(r.payload.results[0].result, "ran preview_order");
    assert.deepEqual(s.calls[0].ctx.pitchGuard, { maxUsd: 500, productId: "NKE-USD" });
    assert.equal(s.calls[0].ctx.pitch.id, s.pitch.id);
  } finally { await s.cleanup(); }
});

test("tools outside the pitch set are refused on the pitch line", async () => {
  const s = await setup();
  try {
    const r = await s.toolCall("call-out", "use_agentcash", {});
    assert.match(r.payload.results[0].result, /isn't available on the pitch line/);
    assert.equal(s.calls.length, 0);
  } finally { await s.cleanup(); }
});

test("non-pitch calls are untouched", async () => {
  const s = await setup();
  try {
    await s.run({ type: "tool-calls", call: { id: "other", assistantId: "asst-main", phoneNumberId: "pn-main" }, toolCallList: [{ id: "t", function: { name: "use_agentcash", arguments: {} } }] });
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].ctx.pitchGuard, undefined);
  } finally { await s.cleanup(); }
});

test("get_active_pitch and record_pitch_outcome run against the pitch store", async () => {
  const s = await setup();
  try {
    const got = JSON.parse((await s.toolCall("call-out", "get_active_pitch")).payload.results[0].result);
    assert.equal(got.pitch.asset, "Nike");
    await s.toolCall("call-out", "record_pitch_outcome", { outcome: "declined", note: "too risky" });
    const saved = await s.store.get(s.pitch.id);
    assert.equal(saved.status, "declined");
    assert.equal(saved.outcomeNote, "too risky");
  } finally { await s.cleanup(); }
});

test("a successful execute marks the pitch bought with the order id", async () => {
  const s = await setup();
  try {
    await s.toolCall("call-out", "execute_order", { previewId: "p1" });
    const saved = await s.store.get(s.pitch.id);
    assert.deepEqual([saved.status, saved.orderId], ["bought", "ord-1"]);
  } finally { await s.cleanup(); }
});

test("end-of-call infers voicemail / no answer, but keeps a recorded decision", async () => {
  const s = await setup();
  try {
    await s.run({ type: "end-of-call-report", endedReason: "voicemail", call: { id: "call-out", assistantId: PITCH_ASSISTANT } });
    assert.equal((await s.store.get(s.pitch.id)).status, "voicemail");

    const p2 = await s.store.create({ symbol: "OXY", productId: "OXY-USD", status: "declined", vapiCallId: "call-2" });
    await s.run({ type: "end-of-call-report", endedReason: "customer-ended-call", call: { id: "call-2", assistantId: PITCH_ASSISTANT } });
    assert.equal((await s.store.get(p2.id)).status, "declined");
  } finally { await s.cleanup(); }
});

test("callback on the pitch number resumes the latest unresolved pitch", async () => {
  const s = await setup();
  try {
    await s.store.update(s.pitch.id, { status: "voicemail" });
    const r = await s.run({ type: "assistant-request", phoneNumber: { id: PITCH_NUMBER_ID }, call: { id: "call-back", customer: { number: OWNER } } });
    assert.equal(r.payload.assistantId, PITCH_ASSISTANT);
    assert.match(r.payload.assistantOverrides.firstMessage, /called back about Nike/);
    assert.equal(r.payload.assistantOverrides.variableValues.hook, "h");
    assert.deepEqual((await s.store.get(s.pitch.id)).callbackCallIds, ["call-back"]);

    // Tools on the callback resolve to that pitch.
    await s.toolCall("call-back", "preview_order", { productId: "NKE-USD" });
    assert.equal(s.calls.at(-1).ctx.pitch.id, s.pitch.id);
  } finally { await s.cleanup(); }
});

test("callback with nothing pending gets the no-pitch opener and no orders", async () => {
  const s = await setup();
  try {
    await s.store.update(s.pitch.id, { status: "declined" });
    const r = await s.run({ type: "assistant-request", phoneNumber: { id: PITCH_NUMBER_ID }, call: { id: "cb2", customer: { number: OWNER } } });
    assert.match(r.payload.assistantOverrides.firstMessage, /Nothing on my desk/);
    const t = await s.toolCall("cb2", "preview_order", { productId: "NKE-USD" });
    assert.match(t.payload.results[0].result, /No pitched trade on this call/);
    const g = JSON.parse((await s.toolCall("cb2", "get_active_pitch")).payload.results[0].result);
    assert.equal(g.pitch, null);
  } finally { await s.cleanup(); }
});

test("strangers calling the pitch number are rejected", async () => {
  const s = await setup();
  try {
    const r = await s.run({ type: "assistant-request", phoneNumber: { id: PITCH_NUMBER_ID }, call: { id: "x", customer: { number: "+19990000000" } } });
    assert.ok(r.payload.error);
  } finally { await s.cleanup(); }
});

test("endedReason mapping", () => {
  assert.equal(pitchStatusForEndedReason("voicemail"), "voicemail");
  assert.equal(pitchStatusForEndedReason("customer-did-not-answer"), "no_answer");
  assert.equal(pitchStatusForEndedReason("customer-busy"), "no_answer");
  assert.equal(pitchStatusForEndedReason("pipeline-error-eleven-labs-voice-failed"), "failed");
  assert.equal(pitchStatusForEndedReason("customer-ended-call"), "no_decision");
});
