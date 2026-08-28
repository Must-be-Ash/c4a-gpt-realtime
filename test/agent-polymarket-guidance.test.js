import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Polymarket-only requests use the targeted tool without news research", async () => {
  const [instructions, browserTools] = await Promise.all([
    readFile(new URL("../AGENT.md", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  for (const content of [instructions, browserTools]) {
    assert.match(content, /show_polymarket/);
    assert.match(content, /Polymarket-only/i);
    assert.match(content, /do not (?:call|fetch).*research_crypto/i);
  }
});

test("Polymarket artifact renderer has its card template", async () => {
  const [page, browserTools] = await Promise.all([
    readFile(new URL("../public/app/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(browserTools, /\$\(["']#polyCardTemplate["']\)\.content/);
  assert.match(page, /<template\s+id=["']polyCardTemplate["']/);
});
