// Publish the setup skills as static markdown so a coding agent can fetch them:
//   /skill             local voice app (original)
//   /skill-web-vapi    hosted web + phone via Vapi
//   /skill-web-openai  hosted web + phone via OpenAI SIP (gpt-live-1 / gpt-realtime-2.1)
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILLS = {
  "skill": "skills/launch-coinbase-for-agents/SKILL.md",
  "skill-web-vapi": "skills/launch-web-vapi/SKILL.md",
  "skill-web-openai": "skills/launch-web-openai/SKILL.md",
};

await mkdir(resolve(root, "public"), { recursive: true });
for (const [target, source] of Object.entries(SKILLS)) {
  await copyFile(resolve(root, source), resolve(root, "public", target));
}
