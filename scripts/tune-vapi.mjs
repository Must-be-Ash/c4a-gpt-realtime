#!/usr/bin/env node
// Tune the existing Vapi assistant for a snappier, interruptible realtime call
// WITHOUT re-registering tools (keeps the 36 tools already on the assistant).
// Per Vapi docs (speech-configuration + openai-realtime):
//   - stopSpeakingPlan: numWords 0 / voiceSeconds 0.2 / short backoff -> immediate barge-in
//   - startSpeakingPlan: shorter waitSeconds, keep LiveKit smart endpointing (English)
//   - realtime prompting: bullets, short replies, no narration of tool calls
//   - temperature 0.6, maxTokens ~250 for conversational answers
// Usage: node scripts/tune-vapi.mjs [--dry-run]     (env: VAPI_PRIVATE_KEY, VAPI_AGENT_ID)

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

const DRY_RUN = process.argv.includes("--dry-run");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VAPI_API = "https://api.vapi.ai";
const key = process.env.VAPI_PRIVATE_KEY;
const id = process.env.VAPI_AGENT_ID;
if (!key || !id) { console.error("Need VAPI_PRIVATE_KEY and VAPI_AGENT_ID"); process.exit(1); }

const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

const PHONE_ADDENDUM = `

## Phone-call style (voice, no screen)
- You are on a live phone call. One or two short spoken sentences per turn.
- Never read raw JSON, IDs, or long lists aloud; summarize.
- Call tools silently. Do NOT announce that you are about to look something up or that you are "pulling it up" — just call the tool, then report the result in one sentence.
- Charts and reports appear on the caller's dashboard as soon as a show_/present tool returns. After such a tool, say at most a few words (e.g. "Chart's up.") and stop. Do not describe what you did.
- When the caller starts speaking, stop immediately. Never recap or continue a previous answer after an interruption.
- Tool results are final the moment you receive them: never say you are still waiting on something you already have.
- Before executing any trade you MUST call preview_order, read the exact preview back, and get an explicit spoken confirmation in the caller's next utterance; only then call execute_order. If unsure, ask a brief clarifying question.`;

const current = await fetch(`${VAPI_API}/assistant/${id}`, { headers }).then((r) => r.json());
if (!current.model) { console.error("Could not load assistant:", JSON.stringify(current).slice(0, 300)); process.exit(1); }
const backupPath = join(root, "runtime", `vapi-assistant-backup-${Date.now()}.json`);
await writeFile(backupPath, JSON.stringify(current, null, 2)).catch(() => {});

const instructions = (await readFile(join(root, "AGENT.md"), "utf8")) + PHONE_ADDENDUM;
const patch = {
  model: {
    ...current.model,
    messages: [{ role: "system", content: instructions }],
    temperature: 0.6,
    maxTokens: 250,
  },
  startSpeakingPlan: { ...(current.startSpeakingPlan || {}), waitSeconds: 0.3, smartEndpointingEnabled: "livekit" },
  stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 0.5 },
};

console.log(`Assistant ${id}: ${current.model.tools?.length ?? 0} tools kept; backup at ${backupPath}`);
console.log(JSON.stringify({ ...patch, model: { ...patch.model, tools: `[${patch.model.tools?.length ?? 0} tools]`, messages: "[system prompt]" } }, null, 2));
if (DRY_RUN) process.exit(0);

const res = await fetch(`${VAPI_API}/assistant/${id}`, { method: "PATCH", headers, body: JSON.stringify(patch) });
const text = await res.text();
if (!res.ok) { console.error(`PATCH failed (${res.status}): ${text.slice(0, 800)}`); process.exit(1); }
const updated = JSON.parse(text);
console.log("✔ updated:", JSON.stringify({ stopSpeakingPlan: updated.stopSpeakingPlan, startSpeakingPlan: updated.startSpeakingPlan, temperature: updated.model?.temperature, maxTokens: updated.model?.maxTokens, tools: updated.model?.tools?.length }));
