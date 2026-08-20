import assert from "node:assert/strict";
import test from "node:test";

import { buildDepthSeries, normalizeCandles } from "../src/services/market-artifacts.js";

test("normalizes Coinbase candles in chronological order", () => {
  assert.deepEqual(normalizeCandles([
    { start: "2", open: "102", high: "106", low: "101", close: "105", volume: "4" },
    { start: "1", open: "100", high: "103", low: "99", close: "102", volume: "3" },
  ]), [
    { time: 1, open: 100, high: 103, low: 99, close: 102, volume: 3 },
    { time: 2, open: 102, high: 106, low: 101, close: 105, volume: 4 },
  ]);
});

test("builds cumulative bid and ask depth from the live book", () => {
  const result = buildDepthSeries({
    pricebook: {
      product_id: "SOL-USD",
      bids: [{ price: "100", size: "1" }, { price: "99", size: "2" }],
      asks: [{ price: "101", size: "1.5" }, { price: "102", size: "2.5" }],
      time: "2026-08-17T12:00:00Z",
    },
    mid_market: "100.5",
    spread_bps: "99.5",
  });

  assert.deepEqual(result.bids, [{ price: 100, cumulativeSize: 1 }, { price: 99, cumulativeSize: 3 }]);
  assert.deepEqual(result.asks, [{ price: 101, cumulativeSize: 1.5 }, { price: 102, cumulativeSize: 4 }]);
  assert.equal(result.productId, "SOL-USD");
  assert.equal(result.midMarket, 100.5);
  assert.equal(result.spreadBps, 99.5);
});
