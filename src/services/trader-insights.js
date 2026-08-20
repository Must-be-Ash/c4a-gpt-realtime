import { fetchJson } from "../lib/http.js";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const NANSEN_ROOT = "https://api.nansen.ai/api/v1";
const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const moneyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const compact = (value) => compactFormatter.format(number(value) ?? 0);
const money = (value) => moneyFormatter.format(number(value) ?? 0);
const signedMoney = (value) => `${number(value) >= 0 ? "+" : "-"}${money(Math.abs(number(value) ?? 0))}`;
const percent = (value, digits = 2) => value == null ? "—" : `${value >= 0 ? "+" : ""}${Number(value).toFixed(digits)}%`;
const toneFor = (value, invert = false) => {
  const normalized = (number(value) ?? 0) * (invert ? -1 : 1);
  return normalized > 0 ? "positive" : normalized < 0 ? "negative" : "neutral";
};

export const symbolFromProduct = (productId) => String(productId ?? "").split("-")[0].trim().toUpperCase();

const hyperliquidRequest = (body, request = fetchJson) => request(HYPERLIQUID_INFO_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(15_000),
});

export async function getDerivativesPositioning(productId, { request = fetchJson, now = Date.now() } = {}) {
  const symbol = symbolFromProduct(productId);
  if (!/^[A-Z0-9]{2,15}$/.test(symbol)) throw new Error("productId must contain a valid crypto ticker.");
  const [marketPayload, fundingPayload] = await Promise.all([
    hyperliquidRequest({ type: "metaAndAssetCtxs" }, request),
    hyperliquidRequest({ type: "fundingHistory", coin: symbol, startTime: now - 7 * 86_400_000 }, request),
  ]);
  const universe = marketPayload?.[0]?.universe ?? [];
  const contexts = marketPayload?.[1] ?? [];
  const index = universe.findIndex((asset) => String(asset.name).toUpperCase() === symbol);
  if (index < 0 || !contexts[index]) throw new Error(`${symbol} is not available in Hyperliquid perpetual market data.`);
  const asset = universe[index];
  const context = contexts[index];
  const markPrice = number(context.markPx);
  const openInterestBase = number(context.openInterest);
  const hourlyFundingRate = number(context.funding);
  const premiumRate = number(context.premium);
  const previousDayPrice = number(context.prevDayPx);
  const change24hPercent = markPrice != null && previousDayPrice
    ? ((markPrice - previousDayPrice) / previousDayPrice) * 100
    : null;
  const crowding = hourlyFundingRate == null || premiumRate == null
    ? "unclear"
    : hourlyFundingRate > 0 && premiumRate > 0
      ? "long-leaning"
      : hourlyFundingRate < 0 && premiumRate < 0
        ? "short-leaning"
        : "mixed";

  return {
    type: "derivatives-positioning",
    productId,
    symbol,
    generatedAt: new Date(now).toISOString(),
    markPrice,
    oraclePrice: number(context.oraclePx),
    change24hPercent,
    openInterestBase,
    openInterestUsd: openInterestBase != null && markPrice != null ? openInterestBase * markPrice : null,
    volume24hUsd: number(context.dayNtlVlm),
    hourlyFundingRate,
    annualizedFundingPercent: hourlyFundingRate == null ? null : hourlyFundingRate * 24 * 365 * 100,
    premiumPercent: premiumRate == null ? null : premiumRate * 100,
    maxLeverage: number(asset.maxLeverage),
    crowding,
    fundingHistory: (Array.isArray(fundingPayload) ? fundingPayload : [])
      .map((point) => ({ time: Number(point.time), ratePercent: (number(point.fundingRate) ?? 0) * 100 }))
      .filter((point) => Number.isFinite(point.time))
      .slice(-60),
  };
}

const recordsFrom = (payload) => Array.isArray(payload?.data?.data)
  ? payload.data.data
  : Array.isArray(payload?.data)
    ? payload.data
    : [];

export function summarizePerpPositions(payload, markPrice) {
  const positions = recordsFrom(payload).map((item) => ({
    side: String(item.side ?? (number(item.position_value_usd) < 0 ? "Short" : "Long")),
    valueUsd: Math.abs(number(item.position_value_usd) ?? 0),
    liquidationPrice: number(item.liquidation_price),
    leverage: String(item.leverage ?? "—"),
    upnlUsd: number(item.upnl_usd),
    label: String(item.address_label ?? item.address ?? "Unlabeled trader"),
  }));
  const isLong = (position) => position.side.toLowerCase().includes("long");
  const longPositions = positions.filter(isLong);
  const shortPositions = positions.filter((position) => !isLong(position));
  const sum = (items) => items.reduce((total, item) => total + item.valueUsd, 0);
  const withDistance = positions
    .filter((position) => markPrice && position.liquidationPrice)
    .map((position) => ({
      ...position,
      liquidationDistancePercent: Math.abs((markPrice - position.liquidationPrice) / markPrice) * 100,
    }))
    .sort((a, b) => a.liquidationDistancePercent - b.liquidationDistancePercent);
  return {
    positionCount: positions.length,
    longCount: longPositions.length,
    shortCount: shortPositions.length,
    longUsd: sum(longPositions),
    shortUsd: sum(shortPositions),
    nearestLiquidations: withDistance.slice(0, 8),
  };
}

export const buildNansenPerpPositionsRequest = (symbol) => ({
  url: `${NANSEN_ROOT}/tgm/perp-positions`,
  method: "POST",
  paymentProtocol: "x402",
  paymentNetwork: "base",
  body: {
    token_symbol: String(symbol).toUpperCase(),
    label_type: "all_traders",
    pagination: { page: 1, per_page: 100 },
    order_by: [{ field: "position_value_usd", direction: "DESC" }],
  },
});

export function buildDerivativesArtifact(market, positions = null, warnings = []) {
  const blocks = [{
    type: "metrics",
    title: null,
    items: [
      { label: "Mark price", value: money(market.markPrice), detail: `${percent(market.change24hPercent)} in 24h`, tone: toneFor(market.change24hPercent) },
      { label: "Open interest", value: money(market.openInterestUsd), detail: `${compact(market.openInterestBase)} ${market.symbol}`, tone: "neutral" },
      { label: "Funding (annualized)", value: percent(market.annualizedFundingPercent), detail: `${percent((market.hourlyFundingRate ?? 0) * 100, 4)} hourly`, tone: toneFor(-(market.hourlyFundingRate ?? 0)) },
      { label: "24h perp volume", value: money(market.volume24hUsd), detail: `${market.maxLeverage ?? "—"}× max leverage`, tone: "neutral" },
      { label: "Market crowding", value: market.crowding, detail: `premium ${percent(market.premiumPercent, 3)}`, tone: market.crowding === "long-leaning" ? "warning" : market.crowding === "short-leaning" ? "negative" : "neutral" },
    ],
  }];
  if (positions?.positionCount) {
    const total = positions.longUsd + positions.shortUsd;
    blocks[0].items.push({
      label: "Observed long / short",
      value: `${total ? Math.round((positions.longUsd / total) * 100) : 0}% / ${total ? Math.round((positions.shortUsd / total) * 100) : 0}%`,
      detail: `${positions.longCount} long · ${positions.shortCount} short positions`,
      tone: positions.longUsd > positions.shortUsd ? "positive" : positions.shortUsd > positions.longUsd ? "negative" : "neutral",
    });
  }
  if (market.fundingHistory.length) blocks.push({
    type: "chart",
    title: "Seven-day hourly funding",
    chartType: "line",
    xLabel: "Time",
    yLabel: "Funding %",
    series: [{
      name: "Hourly funding",
      tone: "neutral",
      points: market.fundingHistory.map((point) => ({
        label: new Date(point.time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" }),
        value: point.ratePercent,
      })),
    }],
  });
  if (positions?.nearestLiquidations?.length) blocks.push({
    type: "table",
    title: "Positions nearest liquidation",
    columns: ["Trader", "Side", "Value", "Leverage", "Liquidation", "Distance", "uPnL"],
    rows: positions.nearestLiquidations.map((item) => [
      item.label,
      item.side,
      money(item.valueUsd),
      item.leverage,
      money(item.liquidationPrice),
      percent(item.liquidationDistancePercent),
      item.upnlUsd == null ? "—" : signedMoney(item.upnlUsd),
    ]),
  });
  if (warnings.length) blocks.push({ type: "text", title: "Partial data", body: warnings.join(" · "), tone: "warning" });
  return {
    title: `${market.symbol} derivatives positioning`,
    subtitle: "Live perpetual market structure. Funding and premium indicate crowding, not a measured exchange-wide long/short ratio.",
    source: positions?.positionCount ? "Hyperliquid + Nansen" : "Hyperliquid public API",
    blocks,
  };
}

const normalizeBookLevels = (levels) => (levels ?? [])
  .map((level) => ({ price: number(level.price), size: number(level.size) }))
  .filter((level) => level.price > 0 && level.size > 0);

export function calculateBookImpact(bookPayload, quoteSize, feeTier = null) {
  const book = bookPayload?.pricebook ?? bookPayload;
  const bids = normalizeBookLevels(book?.bids).sort((a, b) => b.price - a.price);
  const asks = normalizeBookLevels(book?.asks).sort((a, b) => a.price - b.price);
  if (!bids.length || !asks.length) throw new Error("Coinbase returned an empty order book.");
  const midpoint = (bids[0].price + asks[0].price) / 2;
  const sizes = [...new Set([quoteSize * 0.25, quoteSize * 0.5, quoteSize, quoteSize * 2].map((value) => Math.max(1, Number(value.toFixed(2)))))];
  const takerFeeRate = number(feeTier?.taker_fee_rate) ?? 0;
  const consume = (levels, usd, side) => {
    let remainingBase = side === "sell" ? usd / midpoint : null;
    let remainingQuote = side === "buy" ? usd : null;
    let base = 0;
    let quote = 0;
    for (const level of levels) {
      if (side === "buy") {
        const levelQuote = level.price * level.size;
        const usedQuote = Math.min(remainingQuote, levelQuote);
        quote += usedQuote;
        base += usedQuote / level.price;
        remainingQuote -= usedQuote;
        if (remainingQuote <= 1e-8) break;
      } else {
        const usedBase = Math.min(remainingBase, level.size);
        base += usedBase;
        quote += usedBase * level.price;
        remainingBase -= usedBase;
        if (remainingBase <= 1e-12) break;
      }
    }
    const complete = side === "buy" ? remainingQuote <= 1e-8 : remainingBase <= 1e-12;
    const averagePrice = base ? quote / base : null;
    const reference = side === "buy" ? asks[0].price : bids[0].price;
    const impactBps = averagePrice == null ? null : Math.abs((averagePrice - reference) / reference) * 10_000;
    return { complete, averagePrice, impactBps, estimatedFeeUsd: usd * takerFeeRate };
  };
  return {
    productId: book.product_id ?? bookPayload?.productId,
    generatedAt: book.time ?? new Date().toISOString(),
    midpoint,
    spreadBps: ((asks[0].price - bids[0].price) / midpoint) * 10_000,
    takerFeeRate,
    scenarios: sizes.map((usd) => ({ usd, buy: consume(asks, usd, "buy"), sell: consume(bids, usd, "sell") })),
  };
}

export function buildTradeImpactArtifact(impact, requestedQuoteSize) {
  const requested = impact.scenarios.find((item) => item.usd === requestedQuoteSize) ?? impact.scenarios.at(-2) ?? impact.scenarios[0];
  const chartPoints = impact.scenarios.filter((item) => item.buy.impactBps != null && item.sell.impactBps != null);
  return {
    title: `${impact.productId} execution impact`,
    subtitle: "Estimated from the current Coinbase order book snapshot; no order was placed.",
    source: "Coinbase live order book + account fee tier",
    blocks: [
      {
        type: "metrics",
        title: null,
        items: [
          { label: "Midpoint", value: money(impact.midpoint), detail: `${impact.spreadBps.toFixed(2)} bps spread`, tone: "neutral" },
          { label: "Requested size", value: money(requestedQuoteSize), detail: "USD notional", tone: "neutral" },
          { label: "Buy impact", value: requested?.buy.impactBps == null ? "—" : `${requested.buy.impactBps.toFixed(2)} bps`, detail: requested?.buy.complete ? `avg ${money(requested.buy.averagePrice)}` : "insufficient displayed depth", tone: requested?.buy.complete ? "neutral" : "warning" },
          { label: "Sell impact", value: requested?.sell.impactBps == null ? "—" : `${requested.sell.impactBps.toFixed(2)} bps`, detail: requested?.sell.complete ? `avg ${money(requested.sell.averagePrice)}` : "insufficient displayed depth", tone: requested?.sell.complete ? "neutral" : "warning" },
          { label: "Estimated taker fee", value: money(requestedQuoteSize * impact.takerFeeRate), detail: `${percent(impact.takerFeeRate * 100)} fee tier`, tone: "neutral" },
        ],
      },
      {
        type: "chart",
        title: "Price impact by order size",
        chartType: "line",
        xLabel: "USD notional",
        yLabel: "Basis points",
        series: [
          { name: "Buy", tone: "negative", points: chartPoints.map((item) => ({ label: money(item.usd), value: item.buy.impactBps })) },
          { name: "Sell", tone: "positive", points: chartPoints.map((item) => ({ label: money(item.usd), value: item.sell.impactBps })) },
        ],
      },
      {
        type: "table",
        title: "Scenario comparison",
        columns: ["Notional", "Buy avg", "Buy impact", "Sell avg", "Sell impact", "Fee"],
        rows: impact.scenarios.map((item) => [
          money(item.usd),
          item.buy.complete ? money(item.buy.averagePrice) : "insufficient depth",
          item.buy.impactBps == null ? "—" : `${item.buy.impactBps.toFixed(2)} bps`,
          item.sell.complete ? money(item.sell.averagePrice) : "insufficient depth",
          item.sell.impactBps == null ? "—" : `${item.sell.impactBps.toFixed(2)} bps`,
          money(item.buy.estimatedFeeUsd),
        ]),
      },
    ],
  };
}

const arraysAt = (value, keys) => keys.flatMap((key) => Array.isArray(value?.[key]) ? value[key] : []);

export function buildPortfolioRiskArtifact(portfolios, openOrders = []) {
  const totalValue = portfolios.reduce((sum, item) => sum + (number(item.portfolio_balances?.total_balance?.value) ?? 0), 0);
  const totalCash = portfolios.reduce((sum, item) => sum + (number(item.portfolio_balances?.total_cash_equivalent_balance?.value) ?? 0), 0);
  const spot = portfolios.flatMap((item) => item.spot_positions ?? []);
  const allocation = new Map();
  for (const position of spot) {
    const asset = String(position.asset ?? "Unknown");
    const current = allocation.get(asset) ?? { asset, valueUsd: 0, units: 0 };
    current.valueUsd += number(position.total_balance_fiat) ?? 0;
    current.units += number(position.total_balance_crypto) ?? 0;
    allocation.set(asset, current);
  }
  const spotPositions = [...allocation.values()].sort((a, b) => b.valueUsd - a.valueUsd);
  const leveraged = portfolios.flatMap((item) => arraysAt(item, ["positions", "perp_positions", "futures_positions", "perpetual_positions"]));
  const top = spotPositions[0];
  const blocks = [{
    type: "metrics",
    title: null,
    items: [
      { label: "Portfolio value", value: money(totalValue), detail: `${portfolios.length} portfolio${portfolios.length === 1 ? "" : "s"}`, tone: "neutral" },
      { label: "Cash equivalent", value: money(totalCash), detail: `${totalValue ? ((totalCash / totalValue) * 100).toFixed(1) : 0}% of portfolio`, tone: "neutral" },
      { label: "Largest exposure", value: top?.asset ?? "—", detail: top ? `${money(top.valueUsd)} · ${totalValue ? ((top.valueUsd / totalValue) * 100).toFixed(1) : 0}%` : "No spot positions", tone: totalValue && top?.valueUsd / totalValue > 0.5 ? "warning" : "neutral" },
      { label: "Open orders", value: String(openOrders.length), detail: "resting Coinbase orders", tone: openOrders.length ? "warning" : "neutral" },
      { label: "Leveraged positions", value: String(leveraged.length), detail: leveraged.length ? "returned by Coinbase" : "none returned", tone: leveraged.length ? "warning" : "neutral" },
    ],
  }];
  if (spotPositions.length) blocks.push({
    type: "chart",
    title: "Largest spot exposures",
    chartType: "bar",
    xLabel: "Asset",
    yLabel: "USD value",
    series: [{ name: "Exposure", tone: "neutral", points: spotPositions.slice(0, 12).map((item) => ({ label: item.asset, value: item.valueUsd })) }],
  });
  if (leveraged.length) blocks.push({
    type: "table",
    title: "Leveraged positions",
    columns: ["Product", "Side", "Size", "Entry", "Mark", "uPnL", "Liquidation", "Leverage"],
    rows: leveraged.slice(0, 20).map((item) => [
      String(item.product_id ?? item.productId ?? item.asset ?? "—"),
      String(item.side ?? item.position_side ?? "—"),
      String(item.size ?? item.net_size ?? item.position_size ?? "—"),
      item.entry_price == null && item.entry_vwap == null ? "—" : money(item.entry_price ?? item.entry_vwap),
      item.mark_price == null ? "—" : money(item.mark_price),
      item.unrealized_pnl == null && item.upnl == null ? "—" : signedMoney(item.unrealized_pnl ?? item.upnl),
      item.liquidation_price == null ? "—" : money(item.liquidation_price),
      String(item.leverage ?? "—"),
    ]),
  });
  if (openOrders.length) blocks.push({
    type: "table",
    title: "Open orders",
    columns: ["Product", "Side", "Type", "Size", "Limit", "Status"],
    rows: openOrders.slice(0, 20).map((item) => [
      String(item.product_id ?? "—"),
      String(item.side ?? "—"),
      String(item.order_type ?? item.type ?? "—"),
      String(item.base_size ?? item.size ?? "—"),
      String(item.limit_price ?? "—"),
      String(item.status ?? "OPEN"),
    ]),
  });
  if (!leveraged.length) blocks.push({
    type: "text",
    title: "Margin risk",
    body: "Coinbase returned no leveraged positions for the available portfolios, so there is no liquidation-price or margin-buffer data to display.",
    tone: "neutral",
  });
  return {
    title: "Coinbase portfolio risk",
    subtitle: "Current allocation, resting orders, and leveraged-position risk from read-only account data.",
    source: "Coinbase portfolios and orders",
    blocks,
  };
}

export const buildNansenTokenScreenerRequest = (chains) => ({
  url: `${NANSEN_ROOT}/token-screener`,
  method: "POST",
  paymentProtocol: "x402",
  paymentNetwork: "base",
  body: {
    chains,
    timeframe: "24h",
    pagination: { page: 1, per_page: 100 },
    order_by: [{ field: "market_cap_usd", direction: "DESC" }],
  },
});

export const buildNansenFlowIntelligenceRequest = ({ chain, tokenAddress }) => ({
  url: `${NANSEN_ROOT}/tgm/flow-intelligence`,
  method: "POST",
  paymentProtocol: "x402",
  paymentNetwork: "base",
  body: { chain, token_address: tokenAddress, timeframe: "1d" },
});

export function selectTokenRepresentation(payload, symbol, { chain = null, tokenAddress = null } = {}) {
  if (chain && tokenAddress) return { chain, token_address: tokenAddress, token_symbol: symbol };
  const normalized = String(symbol).toUpperCase();
  const variants = new Set([normalized, `W${normalized}`, `CB${normalized}`, `U${normalized}`]);
  return recordsFrom(payload)
    .filter((item) => variants.has(String(item.token_symbol ?? "").toUpperCase()))
    .sort((a, b) => (number(b.liquidity) ?? 0) - (number(a.liquidity) ?? 0))[0] ?? null;
}

export function buildOnchainFlowArtifact(symbol, token, flowPayload = null) {
  const flows = recordsFrom(flowPayload)[0] ?? flowPayload?.data ?? null;
  const segmentFields = [
    ["Exchange", "exchange_net_flow_usd", "exchange_wallet_count", true],
    ["Smart traders", "smart_trader_net_flow_usd", "smart_trader_wallet_count", false],
    ["Whales", "whale_net_flow_usd", "whale_wallet_count", false],
    ["Fresh wallets", "fresh_wallets_net_flow_usd", "fresh_wallets_wallet_count", false],
    ["Top PnL traders", "top_pnl_net_flow_usd", "top_pnl_wallet_count", false],
  ];
  const segmentItems = flows ? segmentFields
    .filter(([, field]) => number(flows[field]) != null)
    .map(([label, field, countField, invert]) => ({
      label,
      value: signedMoney(flows[field]),
      detail: `${number(flows[countField]) ?? 0} wallets · 24h net flow`,
      tone: toneFor(flows[field], invert),
    })) : [];
  const blocks = [{
    type: "metrics",
    title: "Token market flows",
    items: [
      { label: "24h net trading flow", value: signedMoney(token.netflow), detail: `${token.token_symbol} on ${token.chain}`, tone: toneFor(token.netflow) },
      { label: "Buy volume", value: money(token.buy_volume), detail: "24h on-chain venues", tone: "positive" },
      { label: "Sell volume", value: money(token.sell_volume), detail: "24h on-chain venues", tone: "negative" },
      { label: "Liquidity", value: money(token.liquidity), detail: `price ${money(token.price_usd)}`, tone: "neutral" },
    ],
  }];
  if (segmentItems.length) blocks.push({ type: "metrics", title: "Holder-segment flows", items: segmentItems });
  blocks.push({
    type: "text",
    title: "How to read this",
    body: "Positive exchange flow can indicate more inventory moving toward venues, while positive Smart Money, whale, or fresh-wallet flow indicates net accumulation by that segment. Wrapped or bridged representations are labeled explicitly.",
    tone: "neutral",
  });
  return {
    title: `${symbol} on-chain flows`,
    subtitle: token.token_symbol === symbol
      ? `${token.token_symbol} on ${token.chain}`
      : `${token.token_symbol} on ${token.chain}, selected as the most liquid on-chain representation of ${symbol}`,
    source: "Nansen x402",
    blocks,
  };
}

export function buildCatalystArtifact(symbol, catalysts, warnings = []) {
  const blocks = [];
  if (catalysts.length) blocks.push({
    type: "list",
    title: "Upcoming catalysts",
    items: catalysts.map((item) => ({
      title: `${item.dateLabel} · ${item.title}`,
      detail: item.whyItMatters,
      tag: `${item.impact} · ${item.confidence}`,
      tone: item.impact === "bullish" ? "positive" : item.impact === "bearish" ? "negative" : item.confidence === "low" ? "warning" : "neutral",
    })),
  });
  const links = catalysts.filter((item) => item.url).map((item) => ({ label: item.title, url: item.url, detail: item.source }));
  if (links.length) blocks.push({ type: "links", title: "Sources", items: links.slice(0, 12) });
  if (!catalysts.length) blocks.push({ type: "text", title: null, body: "No dated, source-backed upcoming catalysts were found in the requested window.", tone: "neutral" });
  if (warnings.length) blocks.push({ type: "text", title: "Partial data", body: warnings.join(" · "), tone: "warning" });
  return {
    title: `${symbol} catalyst calendar`,
    subtitle: "Only dated or explicitly scheduled events are included; estimates and uncertain dates are labeled.",
    source: "Exa + source-linked summaries",
    blocks,
  };
}
