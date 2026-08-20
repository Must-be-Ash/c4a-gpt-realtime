import { fetchJson } from "../lib/http.js";

const SEARCH_URL = "https://gamma-api.polymarket.com/public-search";

const searchTerms = {
  HYPE: "Hyperliquid",
  BTC: "Bitcoin",
};

export async function searchPolymarket(symbol) {
  const params = new URLSearchParams({ q: searchTerms[symbol] ?? symbol });
  return fetchJson(`${SEARCH_URL}?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
}
