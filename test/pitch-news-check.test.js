import assert from "node:assert/strict";
import test from "node:test";

import { createNewsCheck } from "../src/pitch/news-check.js";

const idea = { symbol: "NKE", thesis: { title: "NKE flush", summary: "s", interpretation: "i" } };

function fakeRequest({ exa, verdict, exaFails = false }) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.includes("exa.ai")) {
      if (exaFails) throw new Error("exa down");
      return { results: exa };
    }
    return { output_text: JSON.stringify(verdict) };
  };
  request.calls = calls;
  return request;
}

const results = [
  { url: "https://www.reuters.com/a", title: "Nike leaves S&P 100", publishedDate: "2026-09-16T10:00:00Z", highlights: ["Nike will be removed"] },
  { url: "https://cnbc.com/b", title: "Nike recap", highlights: ["shares fell"] },
];

test("maps judged items back to their sources and dedupes URLs", async () => {
  const request = fakeRequest({
    exa: results,
    verdict: { verdict: "supports", reason: "confirmed", items: [{ index: 0, fact: "Nike exits the S&P 100 on Sep 21." }, { index: 9, fact: "bogus" }] },
  });
  const check = createNewsCheck({ exaApiKey: "k", openAiApiKey: "o", model: "m", request });
  const out = await check(idea, "Nike", { now: Date.parse("2026-09-16T17:00:00Z") });
  assert.equal(out.verdict, "supports");
  assert.equal(out.searched, 2); // two queries returned the same two URLs
  assert.deepEqual(out.facts, [{ title: "Nike leaves S&P 100", url: "https://www.reuters.com/a", source: "reuters.com", publishedDate: "2026-09-16T10:00:00Z", fact: "Nike exits the S&P 100 on Sep 21." }]);
  const exaCall = request.calls.find((c) => c.url.includes("exa.ai"));
  assert.equal(exaCall.body.startPublishedDate, "2026-09-14T17:00:00.000Z");
});

test("no news in the window is neutral without calling the model", async () => {
  const request = fakeRequest({ exa: [] });
  const check = createNewsCheck({ exaApiKey: "k", openAiApiKey: "o", model: "m", request });
  const out = await check(idea, "Nike");
  assert.equal(out.verdict, "neutral");
  assert.equal(request.calls.filter((c) => c.url.includes("openai")).length, 0);
});

test("a failed search throws so the idea is not called", async () => {
  const check = createNewsCheck({ exaApiKey: "k", openAiApiKey: "o", model: "m", request: fakeRequest({ exaFails: true }) });
  await assert.rejects(check(idea, "Nike"), /Exa news search failed/);
});

test("missing Exa key throws", async () => {
  const check = createNewsCheck({ exaApiKey: "", openAiApiKey: "o", model: "m", request: fakeRequest({}) });
  await assert.rejects(check(idea, "Nike"), /EXA_API_KEY/);
});
