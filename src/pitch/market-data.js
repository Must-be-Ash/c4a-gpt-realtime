// Market data for pitch calls.
//
// - Tradability comes from Coinbase: the authenticated CLI knows equities/ETFs
//   (the public market API 404s on them), the public API lists futures.
// - Prices and trend come from Yahoo's chart endpoint (the same source the desk
//   marks its book with), so the desk's entry/stop/target and our live price
//   share one reference. Crypto uses Coinbase's public price.
//
// Everything is cached briefly and fails soft (null).

import { getCandles, getProduct } from "../services/coinbase-market.js";
import { runCoinbase } from "../services/coinbase-cli.js";
import { fetchJson } from "../lib/http.js";

const FUTURES_LIST_URL = "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&contract_expiry_type=EXPIRING&limit=500";

function cached(ttlMs, load) {
  const store = new Map();
  return async (key) => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await load(key);
    store.set(key, { at: Date.now(), value });
    return value;
  };
}

// Percent change over `days` trading sessions from a close series (oldest first).
export function trendFromCloses(closes) {
  const valid = closes.filter((value) => Number.isFinite(value));
  if (valid.length < 2) return null;
  const last = valid.at(-1);
  const pct = (days) => {
    const base = valid[Math.max(0, valid.length - 1 - days)];
    return base ? Math.round(((last - base) / base) * 1000) / 10 : null;
  };
  const window = valid.slice(-63);
  const high = Math.max(...window);
  return {
    change5dPct: pct(5),
    change30dPct: pct(21),
    change90dPct: pct(63),
    high90d: Math.round(high * 100) / 100,
    offHigh90dPct: Math.round(((last - high) / high) * 1000) / 10,
  };
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.runner]      Coinbase CLI runner (args) => JSON.
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createMarketData({ runner = runCoinbase, fetchImpl = fetch, env = process.env } = {}) {
  // Coinbase product via the authenticated CLI (covers equities, spot, futures).
  const coinbaseProduct = cached(10 * 60_000, async (productId) => {
    try {
      return await runner(["products", "get", productId], { env });
    } catch {
      return null; // "not supported for trading" and transport errors alike
    }
  });

  const futuresList = cached(10 * 60_000, async () => {
    try {
      const payload = await fetchJson(FUTURES_LIST_URL);
      return payload?.products ?? [];
    } catch {
      return [];
    }
  });

  const yahooChart = cached(60_000, async (symbol) => {
    try {
      const response = await fetchImpl(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`,
        { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return null;
      const result = (await response.json())?.chart?.result?.[0];
      const price = result?.meta?.regularMarketPrice;
      if (!Number.isFinite(price)) return null;
      const closes = result?.indicators?.quote?.[0]?.close ?? [];
      return { price, closes: [...closes.slice(0, -1), price] };
    } catch {
      return null;
    }
  });

  const cryptoQuote = cached(60_000, async (productId) => {
    try {
      const [product, candles] = await Promise.all([
        getProduct(productId),
        getCandles(productId, { granularity: "ONE_DAY", limit: 100 }),
      ]);
      const price = Number(product?.price);
      if (!Number.isFinite(price)) return null;
      const closes = candles.map((c) => Number(c.close)).reverse();
      return { price, closes: [...closes, price] };
    } catch {
      return null;
    }
  });

  return {
    coinbaseProduct,
    futuresList: () => futuresList("all"),

    /**
     * Live quote + trend for a pricing reference.
     * @param {{ source: "yahoo"|"coinbase", symbol: string }} ref
     */
    async quote(ref) {
      const raw = ref.source === "coinbase" ? await cryptoQuote(ref.symbol) : await yahooChart(ref.symbol);
      if (!raw) return null;
      return { price: raw.price, trend: trendFromCloses(raw.closes) };
    },
  };
}
