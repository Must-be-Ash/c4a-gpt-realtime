import assert from "node:assert/strict";
import test from "node:test";

import { buildPitchAssistant } from "../scripts/configure-vapi-pitch.mjs";
import { buildToolRegistry } from "../src/agent/tools.js";
import { PITCH_TOOL_DEFINITIONS, PITCH_TOOL_NAMES } from "../src/pitch/tools.js";

const definitions = [...buildToolRegistry({ baseUrl: "http://x" }).staticDefinitions, ...PITCH_TOOL_DEFINITIONS]
  .filter((d) => PITCH_TOOL_NAMES.includes(d.name));

const build = (env = {}) => buildPitchAssistant({ systemPrompt: "p", definitions, webhookUrl: "https://app/vapi/webhook", webhookSecret: "s", env });

test("pitch assistant has only the pitch tools plus endCall, all pointed at our webhook", () => {
  const a = build();
  const names = a.model.tools.map((t) => t.function?.name ?? t.type).sort();
  assert.deepEqual(names, [...PITCH_TOOL_NAMES, "endCall"].sort());
  for (const tool of a.model.tools.filter((t) => t.function)) {
    assert.equal(tool.server.url, "https://app/vapi/webhook");
    assert.equal(tool.function.parameters.type, "object");
  }
});

test("no call-centre background, ElevenLabs voice with a Vapi fallback", () => {
  const a = build({ ELEVENLABS_VOICE_ID: "Ifu36BnEjjIY932etsqk", PITCH_FALLBACK_VOICE: "Godfrey" });
  assert.equal(a.backgroundSound, "off");
  assert.equal(a.voice.provider, "11labs");
  assert.equal(a.voice.voiceId, "Ifu36BnEjjIY932etsqk");
  assert.deepEqual(a.voice.fallbackPlan.voices, [{ provider: "vapi", voiceId: "Godfrey" }]);
});

test("per-call content comes from variables; voicemail detection is on", () => {
  const a = build();
  assert.equal(a.firstMessage, "{{firstMessage}}");
  assert.equal(a.firstMessageMode, "assistant-speaks-first");
  assert.equal(a.voicemailMessage, "{{voicemailMessage}}");
  assert.equal(a.voicemailDetection.provider, "vapi");
  assert.equal(a.model.model, "gpt-4.1");
});
