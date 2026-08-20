import { getDailyCandles, getProduct } from "./coinbase-market.js";
import { searchCryptoNews } from "./exa.js";
import { summarizeNews } from "./news-summaries.js";
import { searchPolymarket } from "./polymarket.js";

const round = (value, digits = 2) => Number(value.toFixed(digits));

const parseJsonArray = (value, fallback = []) => {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

export function computeVolumeComparison(candles) {
  const ordered = [...candles]
    .filter((candle) => Number.isFinite(Number(candle.start)))
    .sort((a, b) => Number(a.start) - Number(b.start))
    .slice(-60);
  const previous = ordered.slice(0, Math.max(0, ordered.length - 30));
  const latest = ordered.slice(-30);
  const sum = (items) => items.reduce((total, candle) => total + Number(candle.volume || 0), 0);
  const latest30 = sum(latest);
  const previous30 = sum(previous);
  const delta = latest30 - previous30;

  return {
    latest30: round(latest30),
    previous30: round(previous30),
    percentChange: previous30 === 0 ? null : round((delta / previous30) * 100),
    direction: delta > 0 ? "higher" : delta < 0 ? "lower" : "flat",
    sampleDays: ordered.length,
  };
}

export function normalizeNewsResults(results) {
  const seen = new Set();
  return results.flatMap((item) => {
    if (!item?.url || seen.has(item.url)) return [];
    seen.add(item.url);
    let source = item.url;
    try {
      source = new URL(item.url).hostname.replace(/^www\./, "");
    } catch {
      // Keep the raw URL as the source when it cannot be parsed.
    }
    const highlights = Array.isArray(item.highlights) ? item.highlights : [];
    const excerpt = highlights.join(" ").trim() || item.text?.slice(0, 700) || "";
    return [
      {
        title: item.title || "Untitled source",
        url: item.url,
        publishedDate: item.publishedDate ?? null,
        source,
        excerpt,
      },
    ];
  });
}

export function selectPolymarketSignals(payload, limit = 6) {
  const markets = (payload?.events ?? []).flatMap((event) =>
    (event.markets ?? []).map((market) => ({ event: event.title, ...market })),
  );

  return markets
    .filter((market) => market.active && !market.closed)
    .map((market) => {
      const labels = parseJsonArray(market.outcomes, ["Yes", "No"]);
      const prices = parseJsonArray(market.outcomePrices).map(Number);
      return {
        event: market.event,
        question: market.question,
        outcomes: labels.map((label, index) => ({
          label,
          probability: Number.isFinite(prices[index]) ? prices[index] : null,
        })),
        volume: Number(market.volume || 0),
      };
    })
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit);
}

export async function getPolymarketSnapshot(
  productId,
  { polymarket = searchPolymarket } = {},
) {
  const symbol = String(productId).split("-")[0].toUpperCase();
  const payload = await polymarket(symbol);
  return {
    type: "polymarket",
    productId,
    symbol,
    generatedAt: new Date().toISOString(),
    markets: selectPolymarketSignals(payload),
  };
}

const productSummary = (product) => ({
  productId: product.product_id,
  price: Number(product.price),
  volume24h: Number(product.volume_24h),
  change24hPercent: Number(product.price_percentage_change_24h),
  status: product.status,
  tradingDisabled: Boolean(product.trading_disabled),
});

export async function researchCrypto(
  {
    productId = "HYPE-USD",
    focusQuery = "",
    timeframe = "last_7_days",
    timezoneOffsetMinutes = 0,
  },
  {
    exaApiKey,
    openAiApiKey,
    summaryModel,
    market = { getProduct, getDailyCandles },
    exa = searchCryptoNews,
    summarizer = summarizeNews,
  } = {},
) {
  const symbol = productId.split("-")[0].toUpperCase();
  const jobs = {
    product: market.getProduct(productId),
    candles: market.getDailyCandles(productId, { days: 60 }),
    news: exa({ apiKey: exaApiKey, symbol, focusQuery, timeframe, timezoneOffsetMinutes }),
  };
  const entries = await Promise.all(
    Object.entries(jobs).map(async ([name, promise]) => {
      try {
        return [name, { ok: true, value: await promise }];
      } catch (error) {
        return [name, { ok: false, error: error.message }];
      }
    }),
  );
  const result = Object.fromEntries(entries);
  const warnings = Object.entries(result).flatMap(([name, item]) =>
    item.ok ? [] : [`${name}: ${item.error}`],
  );
  let news = result.news.ok ? normalizeNewsResults(result.news.value.results).slice(0, 10) : [];
  if (news.length) {
    try {
      news = await summarizer(news, {
        apiKey: openAiApiKey,
        model: summaryModel,
        symbol,
      });
    } catch (error) {
      warnings.push(`news summaries: ${error.message}`);
    }
  }

  return {
    asset: { symbol, productId },
    generatedAt: new Date().toISOString(),
    market: result.product.ok ? productSummary(result.product.value) : null,
    volumeComparison: result.candles.ok ? computeVolumeComparison(result.candles.value) : null,
    news,
    warnings: [
      ...warnings,
      ...(result.news.ok ? result.news.value.warnings ?? [] : []),
    ],
    search: result.news.ok ? {
      queries: result.news.value.queries ?? [],
      startPublishedDate: result.news.value.startPublishedDate ?? null,
      endPublishedDate: result.news.value.endPublishedDate ?? null,
    } : null,
  };
}

export async function researchCryptoNews(
  {
    productId = "HYPE-USD",
    focusQuery,
    timeframe = "last_7_days",
    timezoneOffsetMinutes = 0,
  },
  {
    exaApiKey,
    openAiApiKey,
    summaryModel,
    exa = searchCryptoNews,
    summarizer = summarizeNews,
  } = {},
) {
  const symbol = productId.split("-")[0].toUpperCase();
  const searchResult = await exa({
    apiKey: exaApiKey,
    symbol,
    focusQuery,
    timeframe,
    timezoneOffsetMinutes,
  });
  let news = normalizeNewsResults(searchResult.results).slice(0, 10);
  const warnings = [...(searchResult.warnings ?? [])];
  if (news.length) {
    try {
      news = await summarizer(news, {
        apiKey: openAiApiKey,
        model: summaryModel,
        symbol,
      });
    } catch (error) {
      warnings.push(`news summaries: ${error.message}`);
    }
  }

  return {
    mode: "news",
    asset: { symbol, productId },
    generatedAt: new Date().toISOString(),
    market: null,
    volumeComparison: null,
    news,
    warnings,
    focusQuery,
    search: {
      queries: searchResult.queries ?? [],
      startPublishedDate: searchResult.startPublishedDate ?? null,
      endPublishedDate: searchResult.endPublishedDate ?? null,
    },
  };
}
