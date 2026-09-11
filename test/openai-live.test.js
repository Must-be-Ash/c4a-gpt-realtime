import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiLive } from "../src/agent/openai-live.js";

const incoming = (sessionId, from = "+15550001111") => ({
  type: "live.transport.incoming",
  data: { type: "sip", session_id: sessionId, sip_headers: [{ name: "From", value: `<sip:${from}@sip.example>` }] },
});

function harness({ allowedCallers = [], registry } = {}) {
  const calls = [];
  const sent = [];
  const emitted = [];
  let ws;
  const live = createOpenAiLive({
    apiKey: "sk", backendModel: "gpt-5.6-luna", voice: "marin",
    voiceInstructions: "voice", backendInstructions: "backend",
    getToolDefinitions: () => [{ name: "show_candle_chart", description: "chart", parameters: { type: "object", properties: {} } }],
    registry: registry || { execute: async (name, args) => `ran ${name} for ${args.productId || "-"}` },
    allowedCallers, greeting: "Hi there",
    emit: (e) => emitted.push(e),
    fetchImpl: async (url, opts) => { calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, async text() { return ""; } }; },
    wsFactory: () => { ws = { onopen: null, onmessage: null, onclose: null, onerror: null, send: (s) => sent.push(JSON.parse(s)) }; return ws; },
  });
  return { live, calls, sent, emitted, ws: () => ws };
}

test("accepts a live SIP session with a delegation config (tools on the backend, no realtime fields)", async () => {
  const h = harness();
  assert.equal(h.live.handleEvent(incoming("live_1")), true);
  await new Promise((r) => setTimeout(r, 20));
  const accept = h.calls.find((c) => c.url.endsWith("/live/sessions/live_1/accept"));
  assert.ok(accept, "POSTed the live accept");
  const session = accept.body.session;
  assert.equal(session.type, "live");
  assert.equal(session.model, "gpt-live-1");
  assert.equal(session.delegation.type, "responses");
  assert.equal(session.delegation.responses.model, "gpt-5.6-luna");
  assert.deepEqual(session.delegation.responses.reasoning, { effort: "low" });
  assert.equal(session.delegation.responses.tools[0].name, "show_candle_chart");
  assert.equal(session.tools, undefined);
  assert.equal(session.audio.input, undefined, "no turn_detection on GPT-Live");
  assert.equal(session.audio.output.voice, "marin");
});

test("rejects disallowed callers via the live reject endpoint", async () => {
  const h = harness({ allowedCallers: ["+15550001111"] });
  h.live.handleEvent(incoming("live_2", "+19998887777"));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(h.calls.some((c) => c.url.endsWith("/live/sessions/live_2/reject")));
  assert.ok(h.emitted.some((e) => e.kind === "call" && e.type === "rejected"));
});

test("ignores non-live events", () => {
  const h = harness();
  assert.equal(h.live.handleEvent({ type: "realtime.call.incoming", data: { call_id: "rtc_1" } }), false);
});

test("greets on attach without re-sending session.start, and runs the delegated tool loop", async () => {
  const h = harness();
  h.live.connect("live_3", "+15550001111");
  const ws = h.ws();
  ws.onopen();
  assert.ok(!h.sent.some((m) => m.type === "session.start"), "never sends session.start on attach");
  assert.equal(h.sent[0].type, "session.instructions.append");
  assert.equal(h.sent[0].delegation_id, null);

  await ws.onmessage(JSON.stringify({
    type: "response.event", delegation_id: "dlg_1",
    event: { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "show_candle_chart", arguments: '{"productId":"BTC-USD"}' } },
  }));
  await new Promise((r) => setTimeout(r, 10));
  const output = h.sent.find((m) => m.type === "response.item.create");
  assert.equal(output.item.type, "function_call_output");
  assert.equal(output.item.call_id, "call_1");
  assert.match(output.item.output, /ran show_candle_chart for BTC-USD/);
  const idx = h.sent.indexOf(output);
  assert.ok(h.sent.slice(idx + 1).some((m) => m.type === "response.create"), "response.create follows the output");
  assert.ok(h.emitted.some((e) => e.kind === "tool" && e.type === "done"));
  assert.ok(h.emitted.some((e) => e.kind === "latency" && e.type === "tool"));
});

test("buffers transcript deltas into final captions and finalizes on session.closed", async () => {
  const h = harness();
  let ended = null;
  const live = createOpenAiLive({
    apiKey: "sk", backendModel: "b", voice: "v", voiceInstructions: "v", backendInstructions: "b",
    getToolDefinitions: () => [], registry: { execute: async () => "" }, greeting: "",
    emit: (e) => h.emitted.push(e), onCallEnd: (r) => { ended = r; },
    wsFactory: h.ws ? () => { const ws = { send() {} }; h._ws = ws; return ws; } : undefined,
  });
  live.connect("live_4", "+1");
  const ws = h._ws;
  ws.onopen();
  await ws.onmessage(JSON.stringify({ type: "session.input_transcript.delta", delta: "show me " }));
  await ws.onmessage(JSON.stringify({ type: "session.input_transcript.done", delta: "bitcoin" }));
  await ws.onmessage(JSON.stringify({ type: "session.output_transcript.delta", delta: "Pulling " }));
  await ws.onmessage(JSON.stringify({ type: "session.output_transcript.done", delta: "it up." }));
  const user = h.emitted.find((e) => e.kind === "transcript" && e.role === "user");
  const bot = h.emitted.find((e) => e.kind === "transcript" && e.role === "assistant");
  assert.equal(user.text, "show me bitcoin");
  assert.equal(bot.text, "Pulling it up.");
  assert.ok(h.emitted.some((e) => e.kind === "latency" && e.type === "turn"), "measured the reply gap");
  await ws.onmessage(JSON.stringify({ type: "session.closed", reason: "remote_hangup" }));
  assert.equal(ended.endedReason, "remote_hangup");
  assert.ok(h.emitted.some((e) => e.kind === "latency" && e.type === "summary"));
});
