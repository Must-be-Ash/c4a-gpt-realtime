// Place an outbound pitch call through Vapi.
// https://docs.vapi.ai/calls/outbound-calling

import { fetchJson } from "../lib/http.js";
import { checkElevenLabsQuota, fallbackVoiceOverride } from "./elevenlabs-quota.js";

export function createPitchDialer({ settings, request = fetchJson, quotaCheck = checkElevenLabsQuota }) {
  /**
   * @param {object} vapi  { firstMessage, voicemailMessage, variableValues }
   * @returns {Promise<{ callId: string, voice: string, quota: object }>}
   */
  return async function placePitchCall(vapi, { to = settings.callTo } = {}) {
    for (const [name, value] of Object.entries({ VAPI_PRIVATE_KEY: settings.vapiApiKey, VAPI_PITCH_ASSISTANT_ID: settings.assistantId, VAPI_PITCH_PHONE_NUMBER_ID: settings.phoneNumberId, PITCH_CALL_TO: to })) {
      if (!value) throw new Error(`${name} is not configured.`);
    }
    const quota = await quotaCheck({ apiKey: settings.elevenLabsApiKey });
    const assistantOverrides = {
      firstMessage: vapi.firstMessage,
      voicemailMessage: vapi.voicemailMessage,
      variableValues: { ...vapi.variableValues, firstMessage: vapi.firstMessage, voicemailMessage: vapi.voicemailMessage },
      ...(quota.useElevenLabs ? {} : { voice: fallbackVoiceOverride(settings.fallbackVoice) }),
    };
    const call = await request("https://api.vapi.ai/call", {
      method: "POST",
      headers: { authorization: `Bearer ${settings.vapiApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        assistantId: settings.assistantId,
        phoneNumberId: settings.phoneNumberId,
        customer: { number: to },
        assistantOverrides,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!call?.id) throw new Error("Vapi did not return a call id.");
    return { callId: call.id, voice: quota.useElevenLabs ? "elevenlabs" : `vapi:${settings.fallbackVoice}`, quota };
  };
}
