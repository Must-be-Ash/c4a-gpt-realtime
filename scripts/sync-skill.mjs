import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "skills/launch-coinbase-for-agents/SKILL.md");
const target = resolve(root, "public/skill");

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
