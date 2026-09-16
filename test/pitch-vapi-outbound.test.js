import assert from "node:assert/strict";
import test from "node:test";

import { createPitchDialer } from "../src/pitch/vapi-outbound.js";

const settings = { vapiApiKey: "vk", assistantId: "asst", phoneNumberId: "pn", callTo: "+15550000000", elevenLabsApiKey: "el", fallbackVoice: "Godfrey" };
const vapi = { firstMessage: "Jordan here.", voicemailMessage: "Call me back.", variableValues: { asset: "Nike" } };

function recorder(response = { id: "call-1" }) {
  const calls = [];
  const request = async (url, options) => { calls.push({ url, headers: options.headers, body: JSON.parse(options.body) }); return response; };
  request.calls = calls;
  return request;
}

test("places the call with the brief as overrides and keeps ElevenLabs when quota is fine", async () => {
  const request = recorder();
  const dial = createPitchDialer({ settings, request, quotaCheck: async () => ({ useElevenLabs: true, remaining: 9000, reason: "ok" }) });
  const out = await dial(vapi);
  assert.deepEqual(out, { callId: "call-1", voice: "elevenlabs", quota: { useElevenLabs: true, remaining: 9000, reason: "ok" } });
  const { url, headers, body } = request.calls[0];
  assert.equal(url, "https://api.vapi.ai/call");
  assert.equal(headers.authorization, "Bearer vk");
  assert.equal(body.assistantId, "asst");
  assert.equal(body.phoneNumberId, "pn");
  assert.deepEqual(body.customer, { number: "+15550000000" });
  assert.equal(body.assistantOverrides.firstMessage, "Jordan here.");
  assert.equal(body.assistantOverrides.voicemailMessage, "Call me back.");
  assert.equal(body.assistantOverrides.variableValues.asset, "Nike");
  assert.equal(body.assistantOverrides.variableValues.firstMessage, "Jordan here.");
  assert.equal(body.assistantOverrides.voice, undefined);
});

test("low ElevenLabs quota starts the call in the Vapi voice", async () => {
  const request = recorder();
  const dial = createPitchDialer({ settings, request, quotaCheck: async () => ({ useElevenLabs: false, remaining: 100, reason: "low_quota" }) });
  const out = await dial(vapi);
  assert.equal(out.voice, "vapi:Godfrey");
  assert.deepEqual(request.calls[0].body.assistantOverrides.voice, { provider: "vapi", voiceId: "Godfrey" });
});

test("refuses to dial without configuration or a call id", async () => {
  const ok = async () => ({ useElevenLabs: true });
  await assert.rejects(createPitchDialer({ settings: { ...settings, assistantId: "" }, request: recorder(), quotaCheck: ok })(vapi), /VAPI_PITCH_ASSISTANT_ID/);
  await assert.rejects(createPitchDialer({ settings: { ...settings, callTo: "" }, request: recorder(), quotaCheck: ok })(vapi), /PITCH_CALL_TO/);
  await assert.rejects(createPitchDialer({ settings, request: recorder({}), quotaCheck: ok })(vapi), /call id/);
});
