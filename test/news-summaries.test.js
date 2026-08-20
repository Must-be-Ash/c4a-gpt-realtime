import assert from "node:assert/strict";
import test from "node:test";

import { summarizeNews } from "../src/services/news-summaries.js";

test("replaces source snippets with grounded two-sentence summaries and direction", async () => {
  const items = [{
    title: "HIP-3 open interest reaches a record",
    url: "https://example.com/hip3",
    source: "example.com",
    excerpt: "HIP-3 open interest reached $4.3 billion after new markets launched.",
  }];
  const request = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, "test-model");
    assert.match(body.input, /HIP-3 open interest/);
    return {
      output: [{
        content: [{
          type: "output_text",
          text: JSON.stringify({
            summaries: [{
              index: 0,
              summary: "HIP-3 open interest reached a record $4.3 billion as new markets launched. That signals stronger adoption and fee potential for HYPE.",
              direction: "bullish",
            }],
          }),
        }],
      }],
    };
  };

  const result = await summarizeNews(items, {
    apiKey: "test-key",
    model: "test-model",
    request,
    symbol: "HYPE",
  });

  assert.equal(result[0].direction, "bullish");
  assert.equal(result[0].summary.split(". ").length, 2);
  assert.equal(result[0].excerpt, items[0].excerpt);
});

test("rejects malformed model output instead of presenting it as research", async () => {
  await assert.rejects(
    summarizeNews([{ title: "A", url: "https://example.com", excerpt: "B" }], {
      apiKey: "test-key",
      request: async () => ({ output: [] }),
      symbol: "BTC",
    }),
    /summary output/i,
  );
});
