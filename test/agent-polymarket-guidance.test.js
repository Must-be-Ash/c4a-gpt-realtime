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
  const [page, renderer] = await Promise.all([
    readFile(new URL("../public/app/index.html", import.meta.url), "utf8"),
    // The renderer now lives in the shared module used by both the local app and dashboard.
    readFile(new URL("../public/artifact-render.js", import.meta.url), "utf8"),
  ]);

  assert.match(renderer, /(?:\$|document\.querySelector)\(["']#polyCardTemplate["']\)\.content/);
  assert.match(page, /<template\s+id=["']polyCardTemplate["']/);
});
