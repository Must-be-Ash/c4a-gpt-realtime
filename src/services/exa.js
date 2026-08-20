import { fetchJson } from "../lib/http.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";

const assetContext = {
  HYPE: "Hyperliquid, the HYPE token, HyperCore, HyperEVM, HIP proposals, validators, listings, and ecosystem launches",
  BTC: "Bitcoin and BTC, miners, ETFs, custody, network activity, regulation, and institutional flows",
};

export function buildResearchQueries(symbol, focusQuery = "") {
  const focused = String(focusQuery).trim();
  if (focused) return [focused];
  const subject = assetContext[symbol] ?? `${symbol} cryptocurrency token and its ecosystem`;
  return [
    `${subject}: latest protocol, team, roadmap, product, adoption, listing, or ecosystem news with price relevance`,
    `${subject}: latest security incident, exploit, outage, validator, market structure, liquidity, or exchange risk news`,
    `${subject}: latest US regulation, legal action, enforcement, legislation, macro liquidity, rates, or risk-market news that could affect it`,
  ];
}

const startOfLocalDay = (now, timezoneOffsetMinutes, dayOffset = 0) => {
  const shifted = new Date(now - timezoneOffsetMinutes * 60_000);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + dayOffset,
  ) + timezoneOffsetMinutes * 60_000).toISOString();
};

export function resolveNewsWindow(
  timeframe = "last_7_days",
  { now = Date.now(), timezoneOffsetMinutes = 0 } = {},
) {
  const current = Number(now);
  const offset = Number.isFinite(Number(timezoneOffsetMinutes)) ? Number(timezoneOffsetMinutes) : 0;
  if (timeframe === "today") {
    return { startPublishedDate: startOfLocalDay(current, offset) };
  }
  if (timeframe === "yesterday") {
    return {
      startPublishedDate: startOfLocalDay(current, offset, -1),
      endPublishedDate: startOfLocalDay(current, offset),
    };
  }
  if (timeframe === "today_and_yesterday") {
    return { startPublishedDate: startOfLocalDay(current, offset, -1) };
  }
  const days = timeframe === "last_30_days" ? 30 : 7;
  return { startPublishedDate: new Date(current - days * 86_400_000).toISOString() };
}

export async function searchCryptoNews({
  apiKey,
  symbol,
  focusQuery = "",
  timeframe = "last_7_days",
  timezoneOffsetMinutes = 0,
  now = Date.now(),
  request = fetchJson,
}) {
  if (!apiKey) {
    throw new Error("EXA_API_KEY is not configured.");
  }

  const queries = buildResearchQueries(symbol, focusQuery);
  const publicationWindow = resolveNewsWindow(timeframe, { now, timezoneOffsetMinutes });
  const requests = queries.map((query) =>
    request(EXA_SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query,
        type: "fast",
        category: "news",
        numResults: focusQuery ? 8 : 4,
        ...publicationWindow,
        contents: {
          highlights: { maxCharacters: 700 },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    }),
  );

  const settled = await Promise.allSettled(requests);
  const results = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.results ?? [] : [],
  );
  const errors = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason.message] : [],
  );

  if (!results.length && errors.length) {
    throw new Error(`Exa searches failed: ${errors.join("; ")}`);
  }
  return { results, warnings: errors, queries, ...publicationWindow };
}
