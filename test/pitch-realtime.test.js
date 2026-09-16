import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenAiSip } from "../src/agent/openai-sip.js";
import { createOpenAiWebhookRouter } from "../src/agent/openai-webhook-router.js";
import { createPitchStore } from "../src/pitch/pitch-store.js";
import { createRealtimePitch, renderPrompt } from "../src/pitch/realtime-pitch.js";
import { createTelnyxPitchDialer, decodeClientState, encodeClientState } from "../src/pitch/telnyx-dialer.js";
import { createPitchToolRunners } from "../src/pitch/tools.js";

const PITCH_NUMBER = "+12360000000";
const OWNER = "+15550001111";
const SETTINGS = {
  maxOrderUsd: 500, realtimeVoice: "cedar", realtimeModel: "gpt-realtime-2.1", phoneNumber: PITCH_NUMBER,
  telnyxApiKey: "tk", telnyxConnectionId: "conn", callTo: OWNER, openAiProjectId: "proj_1", stateSecret: "secret",
};
const shared = [
  { name: "check_balance", description: "d", parameters: { type: "object", properties: {} } },
  { name: "preview_order", description: "d", parameters: { type: "object", properties: {} } },
  { name: "execute_order", description: "d", parameters: { type: "object", properties: {} } },
  { name: "use_agentcash", description: "d", parameters: { type: "object", properties: {} } },
];

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "rtpitch-"));
  const store = createPitchStore({ dir });
  const calls = [];
  const registry = { async execute(name, args, ctx) { calls.push({ name, ctx }); return name === "execute_order" ? JSON.stringify({ result: { order_id: "o1" } }) : `ran ${name}`; } };
  const events = [];
  const rt = createRealtimePitch({
    store, registry, runners: createPitchToolRunners({ store }), promptTemplate: "Pitch {{asset}} at {{price}}.", sharedDefinitions: shared, settings: SETTINGS,
    emit: (e) => events.push(e),
  });
  const pitch = await store.create({
    symbol: "NKE", productId: "NKE-USD", engine: "realtime", status: "in_call",
    vapi: { firstMessage: "Jordan here.", voicemailMessage: "Call me back.", variableValues: { asset: "Nike", price: "36.3" } },
  });
  const event = (headers) => ({ type: "realtime.call.incoming", data: { call_id: "rtc_1", sip_headers: headers } });
  return { store, calls, events, rt, pitch, event, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const headers = (pitchId, from = PITCH_NUMBER) => [
  { name: "From", value: `<sip:${from.slice(1)}@sip.telnyx.com>` },
  ...(pitchId ? [{ name: "X-Pitch-Id", value: pitchId }] : []),
];

test("renderPrompt fills variables and blanks unknown ones", () => {
  assert.equal(renderPrompt("{{a}} and {{b}}", { a: "x" }), "x and ");
});

test("recognizes pitch calls by header, or by the pitch number as a backstop", async () => {
  const s = await setup();
  try {
    assert.equal(s.rt.isPitchCall(s.event(headers("abc"))), true);
    assert.equal(s.rt.isPitchCall(s.event(headers(null))), true);
    assert.equal(s.rt.isPitchCall(s.event(headers(null, OWNER))), false);
  } finally { await s.cleanup(); }
});

test("resolves a live realtime pitch into Jordan's session", async () => {
  const s = await setup();
  try {
    const custom = await s.rt.resolveCall(s.event(headers(s.pitch.id)));
    assert.equal(custom.model, "gpt-realtime-2.1");
    assert.equal(custom.voice, "cedar");
    assert.equal(custom.firstMessage, "Jordan here.");
    assert.match(custom.instructions, /^Pitch Nike at 36\.3\./);
    assert.match(custom.instructions, /leave this message once: "Call me back\."/);
    assert.deepEqual(custom.toolDefinitions.map((d) => d.name).sort(), ["check_balance", "end_call", "execute_order", "get_active_pitch", "preview_order", "record_pitch_outcome"]);
    assert.deepEqual(custom.ctx.pitchGuard, { maxUsd: 500, productId: "NKE-USD" });
    assert.equal((await s.store.get(s.pitch.id)).openaiCallId, "rtc_1");
  } finally { await s.cleanup(); }
});

test("unknown, stale, finished, or non-realtime pitches don't resolve", async () => {
  const s = await setup();
  try {
    assert.equal(await s.rt.resolveCall(s.event(headers("nope"))), null);
    assert.equal(await s.rt.resolveCall(s.event(headers(null))), null);
    const done = await s.store.create({ engine: "realtime", status: "declined", productId: "X-USD" });
    assert.equal(await s.rt.resolveCall(s.event(headers(done.id))), null);
    const vapi = await s.store.create({ engine: "elevenlabs", status: "in_call", productId: "X-USD" });
    assert.equal(await s.rt.resolveCall(s.event(headers(vapi.id))), null);
  } finally { await s.cleanup(); }
});

test("tools run with the pitch guard; others are refused; end_call ends after the tool", async () => {
  const s = await setup();
  try {
    const custom = await s.rt.resolveCall(s.event(headers(s.pitch.id)));
    let ended = false;
    const controls = { endAfterThis: () => { ended = true; } };
    await custom.execute("preview_order", {}, { ...custom.ctx }, controls);
    assert.deepEqual(s.calls[0].ctx.pitchGuard, { maxUsd: 500, productId: "NKE-USD" });
    await assert.rejects(custom.execute("use_agentcash", {}, { ...custom.ctx }, controls), /isn't available/);
    await custom.execute("execute_order", { previewId: "p" }, { ...custom.ctx }, controls);
    assert.equal((await s.store.get(s.pitch.id)).status, "bought");
    await custom.execute("end_call", {}, { ...custom.ctx }, controls);
    assert.equal(ended, true);
  } finally { await s.cleanup(); }
});

test("call end marks an undecided pitch no_decision, keeps a recorded one", async () => {
  const s = await setup();
  try {
    const custom = await s.rt.resolveCall(s.event(headers(s.pitch.id)));
    await custom.execute("record_pitch_outcome", { outcome: "voicemail" }, { ...custom.ctx }, { endAfterThis() {} });
    await custom.onEnd("call-ended");
    assert.equal((await s.store.get(s.pitch.id)).status, "voicemail");

    const p2 = await s.store.create({ symbol: "OXY", productId: "OXY-USD", engine: "realtime", status: "dialing", vapi: {} });
    const c2 = await s.rt.resolveCall(s.event(headers(p2.id)));
    await c2.onEnd("call-ended");
    assert.equal((await s.store.get(p2.id)).status, "no_decision");
    assert.ok(s.events.some((e) => e.kind === "pitch" && e.type === "ended" && e.status === "no_decision"));
  } finally { await s.cleanup(); }
});

test("router sends pitch calls to realtime even when gpt-live-1 is armed", () => {
  const sip = { handled: [], handleEvent(e) { this.handled.push(e.type); } };
  const live = { handled: [], handleEvent(e) { this.handled.push(e.type); } };
  const handle = createOpenAiWebhookRouter({ secret: "", getArmedAgent: () => "gpt-live-1", sip, live, isPitchCall: (e) => e.data.pitch === true });
  const res = () => ({ sendStatus() {}, status() { return this; }, json() {} });
  const req = (event) => ({ headers: {}, body: Buffer.from(JSON.stringify(event)) });
  handle(req({ type: "realtime.call.incoming", data: { pitch: true } }), res());
  handle(req({ type: "live.transport.incoming", data: { pitch: true } }), res());
  handle(req({ type: "live.transport.incoming", data: { pitch: false } }), res());
  assert.deepEqual(sip.handled, ["realtime.call.incoming"]);
  assert.deepEqual(live.handled, ["live.transport.incoming"]);
});

test("SIP handler uses the resolved session and skips the allowlist for it", async () => {
  const s = await setup();
  try {
    const fetched = [];
    const sent = [];
    let ws;
    const sip = createOpenAiSip({
      apiKey: "sk", model: "gpt-realtime-2.1", voice: "marin", instructions: "main agent",
      getToolDefinitions: () => [{ name: "use_agentcash", description: "d", parameters: { type: "object", properties: {} } }],
      registry: { execute: async () => "main" }, allowedCallers: [OWNER], webhookSecret: "",
      resolveCall: s.rt.resolveCall,
      fetchImpl: async (url, opts) => { fetched.push({ url, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, async text() { return "{}"; } }; },
      wsFactory: () => { ws = { send: (m) => sent.push(JSON.parse(m)) }; return ws; },
    });
    sip.handleEvent(s.event(headers(s.pitch.id)));
    await new Promise((r) => setTimeout(r, 30));
    const accept = fetched.find((c) => c.url.endsWith("/accept"));
    assert.ok(accept, "accepted despite the From not being allowlisted");
    assert.match(accept.body.instructions, /Pitch Nike/);
    ws.onopen();
    const update = sent.find((m) => m.type === "session.update");
    assert.equal(update.session.audio.output.voice, "cedar");
    assert.ok(update.session.tools.some((t) => t.name === "end_call"));
    assert.ok(!update.session.tools.some((t) => t.name === "use_agentcash"));
    assert.match(sent.find((m) => m.type === "response.create").response.instructions, /Jordan here\./);

    // A non-pitch call from a stranger is still rejected.
    sip.handleEvent({ type: "realtime.call.incoming", data: { call_id: "rtc_2", sip_headers: headers(null, "+19990000000") } });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(fetched.some((c) => c.url.endsWith("/rtc_2/reject")));
  } finally { await s.cleanup(); }
});

test("client_state round-trips and rejects tampering", () => {
  const state = encodeClientState("p-1", "secret");
  assert.equal(decodeClientState(state, "secret"), "p-1");
  assert.equal(decodeClientState(state, "other"), null);
  const forged = Buffer.from(JSON.stringify({ p: "p-2", s: "x" })).toString("base64");
  assert.equal(decodeClientState(forged, "secret"), null);
  assert.equal(decodeClientState("garbage", "secret"), null);
});

test("Telnyx dialer dials, transfers on answer with the pitch header, and marks unanswered calls", async () => {
  const s = await setup();
  try {
    const requests = [];
    const request = async (url, opts) => { requests.push({ url, body: JSON.parse(opts.body) }); return url.endsWith("/calls") ? { data: { call_control_id: "cc_1" } } : {}; };
    const events = [];
    const dialer = createTelnyxPitchDialer({ settings: SETTINGS, store: s.store, emit: (e) => events.push(e), request });
    const out = await dialer.dial({}, s.pitch);
    assert.deepEqual(out, { callId: "cc_1", voice: "openai:cedar", quota: null });
    const dialBody = requests[0].body;
    assert.deepEqual([dialBody.connection_id, dialBody.to, dialBody.from], ["conn", OWNER, PITCH_NUMBER]);
    assert.equal(decodeClientState(dialBody.client_state, "secret"), s.pitch.id);

    const res = { sendStatus() {} };
    const hook = (type, extra = {}) => dialer.handleEvent({ body: { data: { event_type: type, payload: { call_control_id: "cc_1", client_state: dialBody.client_state, ...extra } } } }, res);
    await hook("call.answered");
    const transfer = requests.find((r) => r.url.endsWith("/calls/cc_1/actions/transfer")).body;
    assert.equal(transfer.to, "sip:proj_1@sip.api.openai.com;transport=tls");
    assert.deepEqual(transfer.custom_headers, [{ name: "X-Pitch-Id", value: s.pitch.id }]);
    assert.ok((await s.store.get(s.pitch.id)).answeredAt);

    // An answered call that hangs up doesn't become no_answer.
    await hook("call.hangup", { hangup_cause: "normal_clearing" });
    assert.equal((await s.store.get(s.pitch.id)).status, "in_call");
    assert.ok(events.some((e) => e.kind === "end-of-call-report" && e.callId === "cc_1"));

    const p2 = await s.store.create({ symbol: "OXY", engine: "realtime", status: "in_call" });
    await dialer.handleEvent({ body: { data: { event_type: "call.hangup", payload: { call_control_id: "cc_2", hangup_cause: "timeout", client_state: encodeClientState(p2.id, "secret") } } } }, res);
    assert.equal((await s.store.get(p2.id)).status, "no_answer");

    // Unsigned events are ignored.
    const before = requests.length;
    await dialer.handleEvent({ body: { data: { event_type: "call.answered", payload: { call_control_id: "cc_x", client_state: encodeClientState(p2.id, "wrong") } } } }, res);
    assert.equal(requests.length, before);
  } finally { await s.cleanup(); }
});

test("Telnyx dialer refuses to dial without configuration", async () => {
  const s = await setup();
  try {
    const dialer = createTelnyxPitchDialer({ settings: { ...SETTINGS, openAiProjectId: "" }, store: s.store, request: async () => ({}) });
    await assert.rejects(dialer.dial({}, s.pitch), /OPENAI_PROJECT_ID/);
  } finally { await s.cleanup(); }
});
