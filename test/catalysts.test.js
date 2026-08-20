import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalystQueries, getCatalystCalendar, summarizeCatalysts } from "../src/services/catalysts.js";

test("catalyst queries include asset-specific and macro scheduled events", () => {
  const queries = buildCatalystQueries("HYPE", 90);
  assert.equal(queries.length, 3);
  assert.match(queries.join(" "), /unlock/i);
  assert.match(queries.join(" "), /FOMC/i);
});

test("catalyst calendar keeps source links attached to structured events", async () => {
  const result = await getCatalystCalendar({ productId: "HYPE-USD", horizonDays: 30 }, {
    now: Date.parse("2026-08-20T00:00:00Z"),
    exaApiKey: "test",
    openAiApiKey: "test",
    search: async () => ({ sources: [{ title: "Upgrade", url: "https://example.com/upgrade", excerpt: "Upgrade scheduled September 1." }], warnings: [] }),
    summarize: async (sources) => [{
      sourceIndex: 0,
      dateLabel: "Sep 1, 2026",
      title: "Protocol upgrade",
      whyItMatters: "The upgrade changes execution capacity.",
      impact: "neutral",
      confidence: "high",
      url: sources[0].url,
      source: "example.com",
    }],
  });
  assert.equal(result.catalysts[0].url, "https://example.com/upgrade");
});

test("catalyst summarizer rejects malformed model output", async () => {
  await assert.rejects(() => summarizeCatalysts([
    { title: "Source", url: "https://example.com", excerpt: "Scheduled September 1." },
  ], {
    apiKey: "test",
    symbol: "BTC",
    request: async () => ({ output_text: "not json" }),
  }), /malformed catalyst/i);
});
