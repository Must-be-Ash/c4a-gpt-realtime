import assert from "node:assert/strict";
import test from "node:test";

import { checkElevenLabsQuota, fallbackVoiceOverride } from "../src/pitch/elevenlabs-quota.js";

const sub = (count, limit) => async () => ({ character_count: count, character_limit: limit });

test("enough characters keeps ElevenLabs", async () => {
  assert.deepEqual(await checkElevenLabsQuota({ apiKey: "k", request: sub(1_000, 10_000) }), { useElevenLabs: true, remaining: 9000, reason: "ok" });
});

test("low quota switches to the fallback voice", async () => {
  const out = await checkElevenLabsQuota({ apiKey: "k", request: sub(8_000, 10_000) });
  assert.equal(out.useElevenLabs, false);
  assert.equal(out.reason, "low_quota");
});

test("missing key or a failed check falls back", async () => {
  assert.equal((await checkElevenLabsQuota({ apiKey: "" })).useElevenLabs, false);
  const failed = await checkElevenLabsQuota({ apiKey: "k", request: async () => { throw new Error("401"); } });
  assert.equal(failed.useElevenLabs, false);
  assert.match(failed.reason, /quota_check_failed/);
  assert.equal((await checkElevenLabsQuota({ apiKey: "k", request: async () => ({}) })).reason, "unreadable_quota");
});

test("fallback override is a Vapi voice", () => {
  assert.deepEqual(fallbackVoiceOverride("Elliot"), { provider: "vapi", voiceId: "Elliot" });
});
