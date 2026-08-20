import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("news-only requests preserve the user's focus and avoid bundled Coinbase research", async () => {
  const [instructions, browser] = await Promise.all([
    readFile(new URL("../AGENT.md", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  for (const content of [instructions, browser]) {
    assert.match(content, /search_crypto_news/);
    assert.match(content, /news-only/i);
    assert.match(content, /(?:preserve|include).*user.*(?:entities|names|terms|topic)/i);
    assert.match(content, /do not.*research_crypto/i);
    assert.match(content, /crypto news[\s\S]{0,160}search_crypto_news/i);
  }
});
