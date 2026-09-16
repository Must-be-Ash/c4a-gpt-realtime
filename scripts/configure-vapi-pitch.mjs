#!/usr/bin/env node
// Create or update the outbound pitch assistant ("Jordan") on Vapi and route
// the pitch phone number through our webhook.
//
// Pipeline mode (not speech-to-speech) so the voice can be ElevenLabs:
//   Deepgram STT -> OpenAI (PITCH_LLM_MODEL) -> ElevenLabs (ELEVENLABS_VOICE_ID),
//   with a built-in Vapi voice as fallback if ElevenLabs fails or runs out.
// Per-call content (first message, voicemail, the brief) arrives through
// assistantOverrides when the server places the call.
//
//   node scripts/configure-vapi-pitch.mjs            # apply
//   node scripts/configure-vapi-pitch.mjs --dry-run  # print payloads only
//
// Required env: VAPI_PRIVATE_KEY, PUBLIC_BASE_URL, VAPI_WEBHOOK_SECRET, VAPI_PITCH_PHONE_NUMBER_ID
// Optional env: VAPI_PITCH_ASSISTANT_ID (update instead of create), ELEVENLABS_VOICE_ID,
//               PITCH_FALLBACK_VOICE, PITCH_LLM_MODEL

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

import { buildToolRegistry } from "../src/agent/tools.js";
import { PITCH_TOOL_DEFINITIONS, PITCH_TOOL_NAMES } from "../src/pitch/tools.js";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const DRY_RUN = process.argv.includes("--dry-run");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VAPI_API = "https://api.vapi.ai";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

async function vapi(path, { method = "GET", body } = {}) {
  const response = await fetch(`${VAPI_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.VAPI_PRIVATE_KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Vapi ${method} ${path} failed (${response.status}): ${JSON.stringify(data).slice(0, 600)}`);
  return data;
}

// Vapi rejects non-standard JSON-Schema keywords; keep only the basics.
const DENY = new Set(["example", "examples", "default", "$schema", "$id", "$ref", "title", "format", "const", "definitions", "patternProperties", "nullable"]);
const deepClean = (node) => {
  if (Array.isArray(node)) return node.map(deepClean);
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).filter(([key]) => !DENY.has(key)).map(([key, value]) => [key, deepClean(value)]));
  }
  return node;
};

export function buildPitchAssistant({ systemPrompt, definitions, webhookUrl, webhookSecret, env = process.env }) {
  const tools = definitions.map((definition) => {
    const clean = deepClean(definition.parameters);
    return {
      type: "function",
      function: {
        name: definition.name,
        description: definition.description,
        parameters: { type: "object", properties: clean.properties || {}, ...(clean.required ? { required: clean.required } : {}) },
      },
      server: { url: webhookUrl, secret: webhookSecret },
    };
  });
  return {
    name: "Jordan (pitch)",
    firstMessage: "{{firstMessage}}",
    firstMessageMode: "assistant-speaks-first",
    firstMessageInterruptionsEnabled: true,
    model: {
      provider: "openai",
      model: env.PITCH_LLM_MODEL || "gpt-4.1",
      temperature: 0.6,
      maxTokens: 300,
      messages: [{ role: "system", content: systemPrompt }],
      tools: [...tools, { type: "endCall" }],
    },
    voice: {
      provider: "11labs",
      voiceId: env.ELEVENLABS_VOICE_ID || "Ifu36BnEjjIY932etsqk",
      model: "eleven_flash_v2_5",
      // Lower stability + some style = more drive and inflection for a closer.
      stability: 0.38,
      similarityBoost: 0.8,
      style: 0.3,
      useSpeakerBoost: true,
      speed: 1.05,
      fallbackPlan: { voices: [{ provider: "vapi", voiceId: env.PITCH_FALLBACK_VOICE || "Godfrey" }] },
    },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    // The default "office" bed made the smoke call sound like a call centre.
    backgroundSound: "off",
    backgroundSpeechDenoisingPlan: { smartDenoisingPlan: { enabled: true } },
    // Let the client cut in quickly, but not on a single "uh-huh".
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.2, backoffSeconds: 1 },
    startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingPlan: { provider: "vapi" } },
    voicemailDetection: { provider: "vapi", type: "audio", beepMaxAwaitSeconds: 20 },
    voicemailMessage: "{{voicemailMessage}}",
    endCallMessage: "Talk soon.",
    maxDurationSeconds: 300,
    server: { url: webhookUrl, secret: webhookSecret },
    serverMessages: ["tool-calls", "end-of-call-report", "status-update", "transcript", "hang", "speech-update", "conversation-update"],
    metadata: { app: "coinbase-for-agents", role: "pitch" },
  };
}

async function main() {
  required("VAPI_PRIVATE_KEY");
  const baseUrl = required("PUBLIC_BASE_URL").replace(/\/$/, "");
  const webhookSecret = required("VAPI_WEBHOOK_SECRET");
  const phoneNumberId = required("VAPI_PITCH_PHONE_NUMBER_ID");
  const existingId = process.env.VAPI_PITCH_ASSISTANT_ID || "";
  const webhookUrl = `${baseUrl}/vapi/webhook`;

  const systemPrompt = await readFile(join(root, "src/pitch/PITCH_AGENT.md"), "utf8");
  const shared = buildToolRegistry({ baseUrl }).staticDefinitions;
  const definitions = [...shared, ...PITCH_TOOL_DEFINITIONS].filter((d) => PITCH_TOOL_NAMES.includes(d.name));
  const missing = PITCH_TOOL_NAMES.filter((name) => !definitions.some((d) => d.name === name));
  if (missing.length) throw new Error(`Missing tool definitions: ${missing.join(", ")}`);

  const payload = buildPitchAssistant({ systemPrompt, definitions, webhookUrl, webhookSecret });

  if (DRY_RUN) {
    console.log(JSON.stringify({ ...payload, model: { ...payload.model, messages: `[system prompt ${systemPrompt.length} chars]`, tools: payload.model.tools.map((t) => t.function?.name || t.type) }, server: { url: webhookUrl, secret: "***" } }, null, 2));
    console.log(`\nWould ${existingId ? `PATCH /assistant/${existingId}` : "POST /assistant"} and route phone ${phoneNumberId} through ${webhookUrl}`);
    return;
  }

  let assistant;
  if (existingId) {
    const before = await vapi(`/assistant/${existingId}`);
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(join(root, "runtime", `vapi-pitch-assistant-backup-${Date.now()}.json`), JSON.stringify(before, null, 2));
    assistant = await vapi(`/assistant/${existingId}`, { method: "PATCH", body: payload });
    console.log(`✔ Updated assistant ${assistant.id}`);
  } else {
    assistant = await vapi("/assistant", { method: "POST", body: payload });
    console.log(`✔ Created assistant ${assistant.id}`);
    console.log(`  Set VAPI_PITCH_ASSISTANT_ID=${assistant.id} in .env and Fly secrets.`);
  }

  // Inbound on the pitch number goes through assistant-request so the server
  // can enforce the allowlist and load the latest unresolved pitch.
  await vapi(`/phone-number/${phoneNumberId}`, {
    method: "PATCH",
    body: { assistantId: null, server: { url: webhookUrl, secret: webhookSecret } },
  });
  console.log(`✔ Pitch number ${phoneNumberId} routes inbound through ${webhookUrl}`);
  console.log(`ASSISTANT_ID=${assistant.id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
