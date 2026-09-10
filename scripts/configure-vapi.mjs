#!/usr/bin/env node
// Configure the Vapi assistant + phone number for the hosted phone agent.
//
// Speech-to-speech: the assistant uses OpenAI Realtime (BYOK OpenAI key added in
// Vapi → Integrations → Model Providers → OpenAI). Tools are registered on the
// assistant and executed via our server webhook; the phone number routes inbound
// calls through the same webhook so we can enforce the caller allowlist.
//
// Run AFTER the app is deployed (PUBLIC_BASE_URL must be reachable so the live
// Coinbase MCP tools can be discovered):
//   node scripts/configure-vapi.mjs            # applies config to Vapi
//   node scripts/configure-vapi.mjs --dry-run  # prints payloads, no API calls
//
// Required env: VAPI_PRIVATE_KEY, VAPI_AGENT_ID, VAPI_PHONE_NUMBER,
//               PUBLIC_BASE_URL, VAPI_WEBHOOK_SECRET
// Optional env: OPENAI_REALTIME_MODEL, OPENAI_REALTIME_VOICE

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

import { buildToolRegistry } from "../src/agent/tools.js";

loadEnv({ path: ".env.local" });
loadEnv();

const DRY_RUN = process.argv.includes("--dry-run");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VAPI_API = "https://api.vapi.ai";

// Realtime models require a compatible voice; default to marin (matches local).
const REALTIME_VOICES = new Set(["alloy", "echo", "shimmer", "marin", "cedar"]);

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

const PHONE_ADDENDUM = `

## Phone-call style (voice, no screen)
You are on a live phone call. Keep replies short and spoken — one or two sentences.
Never read raw JSON, IDs, or long lists aloud; summarize. Charts and reports appear
on the caller's dashboard, so say only a brief acknowledgement for show_/present tools.
Before executing any trade you MUST call preview_order, read the exact preview back,
and get an explicit spoken confirmation in the caller's next utterance; only then call
execute_order. If unsure, ask a brief clarifying question.`;

async function vapi(path, { method = "GET", body } = {}) {
  const response = await fetch(`${VAPI_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.VAPI_PRIVATE_KEY}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(`Vapi ${method} ${path} failed (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

async function main() {
  required("VAPI_PRIVATE_KEY");
  const assistantId = required("VAPI_AGENT_ID");
  const phoneNumber = required("VAPI_PHONE_NUMBER");
  const baseUrl = required("PUBLIC_BASE_URL").replace(/\/$/, "");
  const webhookSecret = required("VAPI_WEBHOOK_SECRET");

  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28";
  let voiceId = process.env.OPENAI_REALTIME_VOICE || "marin";
  if (!REALTIME_VOICES.has(voiceId)) {
    console.warn(`Voice "${voiceId}" is not realtime-compatible; falling back to marin.`);
    voiceId = "marin";
  }

  const webhookUrl = `${baseUrl}/vapi/webhook`;
  const instructions = (await readFile(join(root, "AGENT.md"), "utf8")) + PHONE_ADDENDUM;

  // Discover tools (static + live Coinbase MCP tools). Enumerate from TOOLS_BASE_URL
  // when set (e.g. a local unauthenticated server) since the prod app is auth-gated;
  // the tools' webhook still points at PUBLIC_BASE_URL.
  const registry = buildToolRegistry({ baseUrl: process.env.TOOLS_BASE_URL || baseUrl });
  const definitions = await registry.listDefinitions();
  // Vapi validates function parameters strictly and rejects non-standard JSON-Schema
  // keywords (example, default, $schema, title, format, …) anywhere in the tree, and
  // a top-level description on the parameters object. Deep-clean before sending.
  const DENY = new Set(["example", "examples", "default", "$schema", "$id", "$ref", "title", "format", "const", "definitions", "patternProperties", "nullable"]);
  const deepClean = (node) => {
    if (Array.isArray(node)) return node.map(deepClean);
    if (node && typeof node === "object") {
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        if (DENY.has(key)) continue;
        out[key] = deepClean(value);
      }
      return out;
    }
    return node;
  };
  const sanitizeParams = (p) => {
    const clean = deepClean(p && typeof p === "object" ? p : {});
    const out = { type: clean.type || "object", properties: clean.properties || {} };
    if (Array.isArray(clean.required)) out.required = clean.required;
    if (clean.additionalProperties !== undefined) out.additionalProperties = clean.additionalProperties;
    return out;
  };
  const tools = definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: sanitizeParams(definition.parameters),
    },
    server: { url: webhookUrl, secret: webhookSecret },
  }));
  console.log(`Prepared ${tools.length} tools for the assistant.`);

  const assistantPayload = {
    name: "Coinbase for Agents (phone)",
    firstMessage: "Hey, this is your Coinbase agent. What do you want to look at?",
    model: {
      provider: "openai",
      model,
      messages: [{ role: "system", content: instructions }],
      tools,
    },
    voice: { provider: "openai", voiceId },
    server: { url: webhookUrl, secret: webhookSecret },
  };

  if (DRY_RUN) {
    console.log("\n--- DRY RUN: assistant payload (tools truncated) ---");
    console.log(JSON.stringify({ ...assistantPayload, model: { ...assistantPayload.model, tools: `[${tools.length} tools]`, messages: "[system prompt]" } }, null, 2));
    console.log(`\nWould PATCH ${VAPI_API}/assistant/${assistantId}`);
    console.log(`Would route phone ${phoneNumber} through ${webhookUrl}`);
    return;
  }

  // 1) Update the assistant (fall back if Vapi rejects the realtime model name).
  try {
    await vapi(`/assistant/${assistantId}`, { method: "PATCH", body: assistantPayload });
    console.log(`✔ Assistant ${assistantId} updated (${model}, voice ${voiceId}).`);
  } catch (error) {
    if (/model/i.test(error.message) && model !== "gpt-realtime-2025-08-28") {
      console.warn(`Model "${model}" rejected; retrying with gpt-realtime-2025-08-28.`);
      assistantPayload.model.model = "gpt-realtime-2025-08-28";
      await vapi(`/assistant/${assistantId}`, { method: "PATCH", body: assistantPayload });
      console.log(`✔ Assistant ${assistantId} updated (gpt-realtime-2025-08-28, voice ${voiceId}).`);
    } else {
      throw error;
    }
  }

  // 2) Route the phone number through our webhook (enables caller allowlist via
  //    assistant-request) instead of binding a fixed assistant.
  const numbers = await vapi("/phone-number");
  const match = (Array.isArray(numbers) ? numbers : []).find((n) => n.number === phoneNumber);
  if (!match) {
    console.warn(`Phone number ${phoneNumber} not found in this Vapi account. Add it in the dashboard, then re-run.`);
  } else {
    await vapi(`/phone-number/${match.id}`, {
      method: "PATCH",
      body: { assistantId: null, server: { url: webhookUrl, secret: webhookSecret } },
    });
    console.log(`✔ Phone ${phoneNumber} routes inbound calls through ${webhookUrl}.`);
  }

  console.log("\nDone. Call your Vapi number to test (only PHONE_NUMBER is allowed inbound).");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
