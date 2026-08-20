import test from "node:test";
import assert from "node:assert/strict";

import {
  computeVolumeComparison,
  getPolymarketSnapshot,
  normalizeNewsResults,
  researchCrypto,
  researchCryptoNews,
  selectPolymarketSignals,
} from "../src/services/research.js";

test("getPolymarketSnapshot calls only Polymarket for a targeted request", async () => {
  const calls = [];
  const snapshot = await getPolymarketSnapshot("SOL-USD", {
    polymarket: async (symbol) => {
      calls.push(symbol);
      return {
        events: [{
          title: "Solana markets",
          markets: [{
            question: "Will SOL exceed $100?",
            active: true,
            closed: false,
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.35", "0.65"]',
            volume: "2500",
          }],
        }],
      };
    },
  });

  assert.deepEqual(calls, ["SOL"]);
  assert.equal(snapshot.productId, "SOL-USD");
  assert.equal(snapshot.markets.length, 1);
  assert.equal(snapshot.markets[0].question, "Will SOL exceed $100?");
});

test("computeVolumeComparison compares the latest 30 daily candles to the prior 30", () => {
  const candles = Array.from({ length: 60 }, (_, index) => ({
    start: String(index + 1),
    volume: index < 30 ? "10" : "20",
  }));

  assert.deepEqual(computeVolumeComparison(candles), {
    latest30: 600,
    previous30: 300,
    percentChange: 100,
    direction: "higher",
    sampleDays: 60,
  });
});

test("computeVolumeComparison is stable when the prior window has no volume", () => {
  const candles = Array.from({ length: 60 }, (_, index) => ({
    start: String(index + 1),
    volume: index < 30 ? "0" : "5",
  }));

  const result = computeVolumeComparison(candles);
  assert.equal(result.percentChange, null);
  assert.equal(result.direction, "higher");
});

test("normalizeNewsResults deduplicates URLs and keeps compact source material", () => {
  const results = normalizeNewsResults([
    {
      title: "Hyperliquid ships an upgrade",
      url: "https://example.com/story",
      publishedDate: "2026-08-17T10:00:00Z",
      highlights: ["A meaningful protocol upgrade shipped."],
    },
    {
      title: "Duplicate",
      url: "https://example.com/story",
      highlights: ["Duplicate content."],
    },
  ]);

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    title: "Hyperliquid ships an upgrade",
    url: "https://example.com/story",
    publishedDate: "2026-08-17T10:00:00Z",
    source: "example.com",
    excerpt: "A meaningful protocol upgrade shipped.",
  });
});

test("selectPolymarketSignals excludes closed markets and ranks by volume", () => {
  const payload = {
    events: [
      {
        title: "Hyperliquid price targets",
        markets: [
          {
            question: "Will HYPE reach $100?",
            active: true,
            closed: false,
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.25", "0.75"]',
            volume: "1000",
          },
          {
            question: "Closed market",
            active: true,
            closed: true,
            outcomes: '["Yes", "No"]',
            outcomePrices: '["1", "0"]',
            volume: "9999",
          },
          {
            question: "Will HYPE dip below $40?",
            active: true,
            closed: false,
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.10", "0.90"]',
            volume: "2500",
          },
        ],
      },
    ],
  };

  assert.deepEqual(selectPolymarketSignals(payload, 1), [
    {
      event: "Hyperliquid price targets",
      question: "Will HYPE dip below $40?",
      outcomes: [
        { label: "Yes", probability: 0.1 },
        { label: "No", probability: 0.9 },
      ],
      volume: 2500,
    },
  ]);
});

test("researchCrypto summarizes Exa news without fetching Polymarket", async () => {
  let polymarketCalls = 0;
  const result = await researchCrypto(
    { productId: "HYPE-USD" },
    {
      exaApiKey: "exa-key",
      openAiApiKey: "openai-key",
      summaryModel: "summary-model",
      market: {
        getProduct: async () => ({ product_id: "HYPE-USD", price: "50", volume_24h: "10", price_percentage_change_24h: "2", status: "online", trading_disabled: false }),
        getDailyCandles: async () => [],
      },
      exa: async () => ({ results: [{ title: "Upgrade", url: "https://example.com/upgrade", highlights: ["Raw source text"] }] }),
      polymarket: async () => {
        polymarketCalls += 1;
        return { events: [] };
      },
      summarizer: async (items, options) => {
        assert.equal(options.apiKey, "openai-key");
        assert.equal(options.model, "summary-model");
        return items.map((item) => ({ ...item, summary: "The upgrade shipped. It improves the token's utility.", direction: "bullish" }));
      },
    },
  );

  assert.equal(result.news[0].summary, "The upgrade shipped. It improves the token's utility.");
  assert.equal(result.news[0].direction, "bullish");
  assert.equal(polymarketCalls, 0, "general research must not fetch Polymarket");
  assert.equal("polymarket" in result, false);
});

test("researchCryptoNews forwards the focus and does not fetch Coinbase market data", async () => {
  let marketCalls = 0;
  let exaArguments;
  const result = await researchCryptoNews(
    {
      productId: "BTC-USD",
      focusQuery: "Trump crypto executives CLARITY Act",
      timeframe: "yesterday",
      timezoneOffsetMinutes: 420,
    },
    {
      exaApiKey: "exa-key",
      openAiApiKey: "openai-key",
      summaryModel: "summary-model",
      market: {
        getProduct: async () => { marketCalls += 1; },
        getDailyCandles: async () => { marketCalls += 1; },
      },
      exa: async (argumentsValue) => {
        exaArguments = argumentsValue;
        return {
          results: [{ title: "Trump urges action", url: "https://example.com/clarity", highlights: ["Trump urged Congress to pass the CLARITY Act."] }],
          warnings: [],
          queries: [argumentsValue.focusQuery],
          startPublishedDate: "2026-08-19T07:00:00.000Z",
          endPublishedDate: "2026-08-20T07:00:00.000Z",
        };
      },
      summarizer: async (items) => items.map((item) => ({ ...item, summary: "Trump urged Congress to pass the bill. The meeting put market-structure legislation back in focus.", direction: "bullish" })),
    },
  );

  assert.equal(marketCalls, 0);
  assert.equal(exaArguments.focusQuery, "Trump crypto executives CLARITY Act");
  assert.equal(exaArguments.timeframe, "yesterday");
  assert.equal(exaArguments.timezoneOffsetMinutes, 420);
  assert.equal(result.market, null);
  assert.equal(result.volumeComparison, null);
  assert.equal(result.mode, "news");
  assert.equal(result.news[0].title, "Trump urges action");
});
