import { fetchJson } from "../lib/http.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const DIRECTIONS = new Set(["bullish", "bearish", "neutral"]);

const responseText = (response) => {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("");
};

export async function summarizeNews(
  items,
  { apiKey, model = "gpt-5.6-luna", request = fetchJson, symbol } = {},
) {
  if (!items.length) return [];
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for news summaries.");

  const sources = items.map((item, index) => ({
    index,
    title: item.title,
    source: item.source,
    publishedDate: item.publishedDate,
    sourceText: item.excerpt,
  }));
  const response = await request(RESPONSES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "low" },
      store: false,
      input: `Create a compact crypto decision brief about ${symbol}. Select up to six of the most decision-relevant items and omit duplicate coverage of the same development. For each selected item, return exactly two short factual sentences: first what happened, then why it matters for ${symbol}. Ground every claim in that item's source text, preserve uncertainty, and omit generic commentary or disclaimers. Classify impact as bullish, bearish, or neutral.\n\n${JSON.stringify(sources)}`,
      text: {
        format: {
          type: "json_schema",
          name: "crypto_news_summaries",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["summaries"],
            properties: {
              summaries: {
                type: "array",
                minItems: 1,
                maxItems: Math.min(6, items.length),
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["index", "summary", "direction"],
                  properties: {
                    index: { type: "integer", minimum: 0, maximum: items.length - 1 },
                    summary: { type: "string" },
                    direction: { type: "string", enum: ["bullish", "bearish", "neutral"] },
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
    throw new Error("OpenAI returned malformed news summary output.");
  }
  if (!Array.isArray(parsed?.summaries) || !parsed.summaries.length || parsed.summaries.length > Math.min(6, items.length)) {
    throw new Error("OpenAI news summary output was incomplete.");
  }
  const indexes = new Set();
  return parsed.summaries.map((summary) => {
    if (indexes.has(summary.index) || !items[summary.index]) {
      throw new Error("OpenAI news summary output contained an invalid item.");
    }
    indexes.add(summary.index);
    if (!summary?.summary?.trim() || !DIRECTIONS.has(summary.direction)) {
      throw new Error("OpenAI news summary output contained an invalid item.");
    }
    return { ...items[summary.index], summary: summary.summary.trim(), direction: summary.direction };
  });
}
