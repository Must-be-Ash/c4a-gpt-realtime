import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResearchQueries,
  resolveNewsWindow,
  searchCryptoNews,
} from "../src/services/exa.js";

test("focused news search preserves the user's entities and topic as the Exa query", () => {
  const focusQuery = "Trump Brian Armstrong Robinhood Winklevoss CLARITY Act White House meeting";
  assert.deepEqual(buildResearchQueries("BTC", focusQuery), [focusQuery]);
});

test("yesterday resolves to an exact local-calendar publication window", () => {
  assert.deepEqual(resolveNewsWindow("yesterday", {
    now: Date.parse("2026-08-20T21:00:00.000Z"),
    timezoneOffsetMinutes: 0,
  }), {
    startPublishedDate: "2026-08-19T00:00:00.000Z",
    endPublishedDate: "2026-08-20T00:00:00.000Z",
  });
});

test("searchCryptoNews sends the focused query and exact date window to Exa", async () => {
  const requests = [];
  await searchCryptoNews({
    apiKey: "exa-key",
    symbol: "BTC",
    focusQuery: "Trump crypto CLARITY Act",
    timeframe: "yesterday",
    timezoneOffsetMinutes: 0,
    now: Date.parse("2026-08-20T21:00:00.000Z"),
    request: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { results: [] };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].query, "Trump crypto CLARITY Act");
  assert.equal(requests[0].startPublishedDate, "2026-08-19T00:00:00.000Z");
  assert.equal(requests[0].endPublishedDate, "2026-08-20T00:00:00.000Z");
  assert.equal(requests[0].numResults, 8);
});
