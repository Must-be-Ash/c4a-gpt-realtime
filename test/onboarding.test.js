import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("landing page offers the agent-guided setup prompt", async () => {
  const [page, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/landing.js", import.meta.url), "utf8"),
    readFile(new URL("../public/landing.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="setupPrompt"/);
  assert.match(page, /id="copyPrompt"/);
  assert.match(page, /Coinbase for Agents Demo/);
  assert.match(page, /Paste this into Codex, Claude Code, Cursor/);
  assert.match(page, /Markets move fast\./);
  assert.match(page, /live, source-backed research in seconds/i);
  assert.match(page, /stocks, crypto, and futures/i);
  assert.match(page, /x402/);
  assert.match(page, /custom reports/);
  assert.doesNotMatch(page, /Your market|voice-first crypto research/);
  assert.doesNotMatch(page, /MIT licensed|<footer/);
  assert.doesNotMatch(page, /class="(?:mark|status-dot|capabilities|how-it-works|hero-links)"/);
  assert.equal((page.match(/Must-be-Ash\/c4a-gpt-realtime/g) ?? []).length, 1);
  assert.match(script, /new URL\("\/skill", window\.location\.origin\)/);
  assert.match(script, /navigator\.clipboard\.writeText\(prompt\)/);
  assert.doesNotMatch(styles, /\.copy-button[\s\S]{0,500}border-radius:\s*50%/);
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
  assert.match(source, /local project dependency/i);
  assert.doesNotMatch(source, /npm install --global @coinbase\/coinbase-cli/);
});

test("the app pins the current Coinbase CLI instead of relying on a global install", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.dependencies["@coinbase/coinbase-cli"], "0.0.6");
});
