import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("landing page offers the agent-guided setup prompt", async () => {
  const [page, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/landing.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="setupPrompt"/);
  assert.match(page, /id="copyPrompt"/);
  assert.match(page, /Paste this into Codex, Claude Code, Cursor/);
  assert.match(script, /new URL\("\/skill", window\.location\.origin\)/);
  assert.match(script, /navigator\.clipboard\.writeText\(prompt\)/);
});

test("setup skill is published from the repository source", async () => {
  const [source, published] = await Promise.all([
    readFile(new URL("../skills/launch-coinbase-for-agents/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../public/skill", import.meta.url), "utf8"),
  ]);

  assert.equal(published, source);
  assert.match(source, /gh repo fork Must-be-Ash\/c4a-gpt-realtime/);
  assert.match(source, /Never ask the user to paste an API key/);
  assert.match(source, /npm run check/);
  assert.match(source, /http:\/\/localhost:4173\/app\//);
});
