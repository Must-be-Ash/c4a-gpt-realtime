// Fresh-news sanity check before a pitch call: does anything published in the
// last 48 hours contradict the desk's thesis? Exa finds the news, the summary
// model judges it against the thesis. Errors propagate: the caller treats an
// unverifiable idea as "don't call".

import { fetchJson } from "../lib/http.js";
import { openAiJson } from "./openai-json.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const WINDOW_MS = 48 * 3_600_000;

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason", "items"],
  properties: {
    verdict: { type: "string", enum: ["supports", "neutral", "contradicts"] },
    reason: { type: "string" },
    items: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "fact"],
        properties: {
          index: { type: "integer", minimum: 0 },
          fact: { type: "string" },
        },
      },
    },
  },
};

export function createNewsCheck({ exaApiKey, openAiApiKey, model, request = fetchJson }) {
  async function search(query, now) {
    const payload = await request(EXA_SEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": exaApiKey },
      body: JSON.stringify({
        query,
        type: "fast",
        category: "news",
        numResults: 5,
        startPublishedDate: new Date(now - WINDOW_MS).toISOString(),
        contents: { highlights: { maxCharacters: 600 } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return payload?.results ?? [];
  }

  /**
   * @param {object} idea      desk idea (symbol, thesis)
   * @param {string} subject   spoken/common name, e.g. "Nike" or "crude oil"
   * @returns {Promise<{verdict, reason, facts: {title,url,source,publishedDate,fact}[], searched: number}>}
   */
  return async function checkNews(idea, subject, { now = Date.now() } = {}) {
    if (!exaApiKey) throw new Error("EXA_API_KEY is not configured.");
    const queries = [
      `${subject} (${idea.symbol}) latest news moving the price`,
      `${subject}: ${idea.thesis?.title ?? ""}`.trim(),
    ];
    const settled = await Promise.allSettled(queries.map((q) => search(q, now)));
    const seen = new Set();
    const results = settled
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url))
      .slice(0, 8);
    if (!results.length) {
      if (settled.every((r) => r.status === "rejected")) throw new Error("Exa news search failed.");
      return { verdict: "neutral", reason: "No news in the last 48 hours.", facts: [], searched: 0 };
    }

    const sources = results.map((r, index) => ({
      index,
      title: r.title,
      publishedDate: r.publishedDate,
      text: (r.highlights ?? []).join(" ").slice(0, 900) || r.text?.slice(0, 900) || "",
    }));
    const judged = await openAiJson({
      apiKey: openAiApiKey,
      model,
      request,
      name: "pitch_news_check",
      schema: VERDICT_SCHEMA,
      input: `A trader is long ${subject} (${idea.symbol}) on this thesis:\n`
        + `Title: ${idea.thesis?.title}\nSummary: ${idea.thesis?.summary}\nInterpretation: ${idea.thesis?.interpretation ?? ""}\n\n`
        + "Judge the news below, published in the last 48 hours. verdict = \"contradicts\" only if a concrete, material development "
        + "undercuts the thesis or the long (e.g. the catalyst was cancelled, a guidance cut, a deal collapsed, the stated fact reversed). "
        + "\"supports\" if a concrete development backs it. Otherwise \"neutral\". Ignore opinion pieces and price recaps. "
        + "In items, list up to 4 of the most relevant articles with one short factual sentence each, grounded only in that article's text.\n\n"
        + JSON.stringify(sources),
    });
    const facts = (judged.items ?? [])
      .filter((item) => results[item.index])
      .map((item) => {
        const r = results[item.index];
        return { title: r.title, url: r.url, source: new URL(r.url).hostname.replace(/^www\./, ""), publishedDate: r.publishedDate ?? null, fact: item.fact };
      });
    return { verdict: judged.verdict, reason: judged.reason, facts, searched: results.length };
  };
}
