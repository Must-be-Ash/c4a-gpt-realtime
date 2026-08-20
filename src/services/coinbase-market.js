import { fetchJson } from "../lib/http.js";

const API_ROOT = "https://api.coinbase.com/api/v3/brokerage/market";

export async function getProduct(productId) {
  return fetchJson(`${API_ROOT}/products/${encodeURIComponent(productId)}`, {
    headers: { "cache-control": "no-cache" },
  });
}

const granularitySeconds = {
  ONE_MINUTE: 60,
  FIVE_MINUTE: 300,
  FIFTEEN_MINUTE: 900,
  THIRTY_MINUTE: 1_800,
  ONE_HOUR: 3_600,
  TWO_HOUR: 7_200,
  SIX_HOUR: 21_600,
  ONE_DAY: 86_400,
};

const normalizeLimit = (value, maximum) => {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error("Market data limit must be a positive integer.");
  return Math.min(parsed, maximum);
};

export async function getCandles(
  productId,
  { granularity = "ONE_HOUR", limit = 72, now = Date.now() } = {},
) {
  const seconds = granularitySeconds[granularity];
  if (!seconds) throw new Error("Unsupported candle granularity.");
  const candleLimit = normalizeLimit(limit, 300);
  const end = Math.floor(now / 1_000);
  const start = end - candleLimit * seconds;
  const params = new URLSearchParams({
    start: String(start),
    end: String(end),
    granularity,
    limit: String(candleLimit),
  });
  const payload = await fetchJson(
    `${API_ROOT}/products/${encodeURIComponent(productId)}/candles?${params}`,
    { headers: { "cache-control": "no-cache" } },
  );
  return payload.candles ?? [];
}

export async function getProductBook(productId, { limit = 50 } = {}) {
  const params = new URLSearchParams({
    product_id: productId,
    limit: String(normalizeLimit(limit, 100)),
  });
  return fetchJson(`${API_ROOT}/product_book?${params}`, {
    headers: { "cache-control": "no-cache" },
  });
}

export async function getDailyCandles(productId, { days = 60, now = Date.now() } = {}) {
  return getCandles(productId, { granularity: "ONE_DAY", limit: days, now });
}
