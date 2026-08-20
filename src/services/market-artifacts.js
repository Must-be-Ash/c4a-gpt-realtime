const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function normalizeCandles(candles) {
  return candles.flatMap((candle) => {
    const item = {
      time: finite(candle.start),
      open: finite(candle.open),
      high: finite(candle.high),
      low: finite(candle.low),
      close: finite(candle.close),
      volume: finite(candle.volume),
    };
    return Object.values(item).every((value) => value != null) ? [item] : [];
  }).sort((a, b) => a.time - b.time);
}

const cumulativeSide = (levels, direction) => {
  let cumulativeSize = 0;
  return levels
    .map((level) => ({ price: finite(level.price), size: finite(level.size) }))
    .filter((level) => level.price != null && level.size != null)
    .sort((a, b) => direction * (a.price - b.price))
    .map((level) => {
      cumulativeSize += level.size;
      return { price: level.price, cumulativeSize };
    });
};

export function buildDepthSeries(payload) {
  const book = payload.pricebook ?? {};
  return {
    productId: book.product_id,
    generatedAt: book.time ?? new Date().toISOString(),
    midMarket: finite(payload.mid_market),
    spreadBps: finite(payload.spread_bps),
    bids: cumulativeSide(book.bids ?? [], -1),
    asks: cumulativeSide(book.asks ?? [], 1),
  };
}
