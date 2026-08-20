import { fetchJson } from "../lib/http.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const RESPONSES_URL = "https://api.openai.com/v1/responses";

const responseText = (response) => {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("");
};

export function buildCatalystQueries(symbol, horizonDays) {
  return [
    `${symbol} crypto upcoming token unlock governance vote protocol upgrade roadmap launch listing scheduled date next ${horizonDays} days`,
    `${symbol} ecosystem upcoming mainnet testnet product release conference partnership deadline next ${horizonDays} days`,
    `upcoming CPI FOMC crypto regulation legislation court deadline macro catalyst next ${horizonDays} days affecting ${symbol}`,
  ];
}

export async function searchCatalystSources({ apiKey, symbol, horizonDays = 90, request = fetchJson, now = Date.now() }) {
  if (!apiKey) throw new Error("EXA_API_KEY is not configured.");
  const startPublishedDate = new Date(now - 45 * 86_400_000).toISOString();
  const settled = await Promise.allSettled(buildCatalystQueries(symbol, horizonDays).map((query) => request(EXA_SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query,
      type: "fast",
      numResults: 6,
      startPublishedDate,
      contents: { highlights: { maxCharacters: 900 } },
    }),
    signal: AbortSignal.timeout(15_000),
  })));
  const warnings = settled.flatMap((result) => result.status === "rejected" ? [result.reason.message] : []);
  const seen = new Set();
  const sources = settled.flatMap((result) => result.status === "fulfilled" ? result.value.results ?? [] : [])
    .flatMap((item) => {
      if (!item?.url || seen.has(item.url)) return [];
      seen.add(item.url);
      return [{
        title: item.title || "Untitled source",
        url: item.url,
        publishedDate: item.publishedDate ?? null,
        excerpt: (item.highlights ?? []).join(" ").trim() || item.text?.slice(0, 900) || "",
      }];
    })
    .slice(0, 18);
  if (!sources.length && warnings.length) throw new Error(`Catalyst searches failed: ${warnings.join("; ")}`);
  return { sources, warnings };
}

export async function summarizeCatalysts(
  sources,
  { apiKey, model = "gpt-5.6-luna", symbol, horizonDays = 90, request = fetchJson, now = Date.now() } = {},
) {
  if (!sources.length) return [];
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for catalyst summaries.");
  const today = new Date(now).toISOString().slice(0, 10);
  const response = await request(RESPONSES_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      reasoning: { effort: "low" },
      store: false,
      input: `Today is ${today}. Build an upcoming catalyst calendar for ${symbol} covering the next ${horizonDays} days. Use only the supplied source text. Include an event only when the source gives an explicit future date, date range, month, quarter, or scheduled deadline. Never infer a date from publication time. Deduplicate the same event. Preserve uncertainty: use confidence low for rumors or vague windows, medium for announced windows, and high for exact dates from authoritative sources. Return at most eight events ordered by expected date. Each whyItMatters must be one concise factual sentence.\n\n${JSON.stringify(sources.map((source, index) => ({ index, title: source.title, publishedDate: source.publishedDate, excerpt: source.excerpt })))}`,
      text: {
        format: {
          type: "json_schema",
          name: "crypto_catalyst_calendar",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["events"],
            properties: {
              events: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["sourceIndex", "dateLabel", "title", "whyItMatters", "impact", "confidence"],
                  properties: {
                    sourceIndex: { type: "integer", minimum: 0, maximum: sources.length - 1 },
                    dateLabel: { type: "string" },
                    title: { type: "string" },
                    whyItMatters: { type: "string" },
                    impact: { type: "string", enum: ["bullish", "bearish", "neutral"] },
                    confidence: { type: "string", enum: ["high", "medium", "low"] },
                  },
                },
              },
            },
          },
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  let parsed;
  try {
    parsed = JSON.parse(responseText(response));
  } catch {
    throw new Error("OpenAI returned malformed catalyst summary output.");
  }
  if (!Array.isArray(parsed?.events)) throw new Error("OpenAI catalyst summary output was incomplete.");
  return parsed.events.flatMap((event) => {
    const source = sources[event.sourceIndex];
    if (!source || !event.dateLabel?.trim() || !event.title?.trim() || !event.whyItMatters?.trim()) return [];
    let sourceName = source.url;
    try { sourceName = new URL(source.url).hostname.replace(/^www\./, ""); } catch { /* Preserve the source URL. */ }
    return [{ ...event, url: source.url, source: sourceName }];
  });
}

export async function getCatalystCalendar(
  { productId, horizonDays = 90 },
  { exaApiKey, openAiApiKey, summaryModel, search = searchCatalystSources, summarize = summarizeCatalysts, now = Date.now() } = {},
) {
  const symbol = String(productId).split("-")[0].toUpperCase();
  const sourceResult = await search({ apiKey: exaApiKey, symbol, horizonDays, now });
  const catalysts = await summarize(sourceResult.sources, {
    apiKey: openAiApiKey,
    model: summaryModel,
    symbol,
    horizonDays,
    now,
  });
  return { symbol, generatedAt: new Date(now).toISOString(), catalysts, warnings: sourceResult.warnings ?? [] };
}
