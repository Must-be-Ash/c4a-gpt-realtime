// Pre-call ElevenLabs credit check. The plan is small (10k characters/month
// at setup), so when it can't cover a pitch we start the call in the built-in
// Vapi voice rather than switching voices mid-sentence.

import { fetchJson } from "../lib/http.js";

// Roughly one pitch plus a couple of back-and-forths.
export const MIN_CHARACTERS_FOR_A_CALL = 3_000;

/**
 * @returns {Promise<{ useElevenLabs: boolean, remaining: number|null, reason: string }>}
 */
export async function checkElevenLabsQuota({ apiKey, request = fetchJson, minCharacters = MIN_CHARACTERS_FOR_A_CALL }) {
  if (!apiKey) return { useElevenLabs: false, remaining: null, reason: "no_api_key" };
  try {
    const sub = await request("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(8_000),
    });
    const remaining = Number(sub?.character_limit) - Number(sub?.character_count);
    if (!Number.isFinite(remaining)) return { useElevenLabs: false, remaining: null, reason: "unreadable_quota" };
    if (remaining < minCharacters) return { useElevenLabs: false, remaining, reason: "low_quota" };
    return { useElevenLabs: true, remaining, reason: "ok" };
  } catch (error) {
    return { useElevenLabs: false, remaining: null, reason: `quota_check_failed: ${error.message}` };
  }
}

// assistantOverrides.voice for a call that must use the fallback voice.
export const fallbackVoiceOverride = (voiceId) => ({ provider: "vapi", voiceId });
