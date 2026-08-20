import assert from "node:assert/strict";
import test from "node:test";

import { artifactSpecSchema } from "../src/shared/artifact-schema.js";
import {
  buildDerivativesArtifact,
  buildOnchainFlowArtifact,
  buildPortfolioRiskArtifact,
  buildTradeImpactArtifact,
  calculateBookImpact,
  getDerivativesPositioning,
  selectTokenRepresentation,
  summarizePerpPositions,
} from "../src/services/trader-insights.js";

test("derivatives positioning uses live market context and funding history", async () => {
  const calls = [];
  const result = await getDerivativesPositioning("HYPE-USD", {
    now: Date.parse("2026-08-20T12:00:00Z"),
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.type);
      if (body.type === "fundingHistory") return [
        { time: 1_787_200_000_000, fundingRate: "0.00001" },
      ];
      return [
        { universe: [{ name: "BTC", maxLeverage: 40 }, { name: "HYPE", maxLeverage: 10 }] },
        [
          {},
          {
            funding: "0.00002",
            openInterest: "1000000",
            prevDayPx: "50",
            dayNtlVlm: "250000000",
            premium: "0.0001",
            oraclePx: "55.1",
            markPx: "55",
          },
        ],
      ];
    },
  });

  assert.deepEqual(calls.sort(), ["fundingHistory", "metaAndAssetCtxs"]);
  assert.equal(result.symbol, "HYPE");
  assert.equal(result.openInterestUsd, 55_000_000);
  assert.equal(result.crowding, "long-leaning");
  assert.equal(result.fundingHistory[0].ratePercent, 0.001);
});

test("perp positions calculate observed long-short balance and liquidation proximity", () => {
  const result = summarizePerpPositions({ data: [
    { side: "Long", position_value_usd: 60_000, liquidation_price: 45, leverage: "5X", upnl_usd: 500, address_label: "Fund A" },
    { side: "Short", position_value_usd: 40_000, liquidation_price: 70, leverage: "3X", upnl_usd: -100, address_label: "Trader B" },
  ] }, 55);
  assert.equal(result.longUsd, 60_000);
  assert.equal(result.shortUsd, 40_000);
  assert.equal(result.nearestLiquidations[0].label, "Fund A");
});

test("trade impact walks the real book and includes the account fee tier", () => {
  const impact = calculateBookImpact({
    pricebook: {
      product_id: "BTC-USD",
      time: "2026-08-20T12:00:00Z",
      bids: [{ price: "99", size: "2" }, { price: "98", size: "10" }],
      asks: [{ price: "101", size: "1" }, { price: "102", size: "10" }],
    },
  }, 200, { taker_fee_rate: "0.01" });
  const requested = impact.scenarios.find((item) => item.usd === 200);
  assert.equal(impact.productId, "BTC-USD");
  assert.equal(requested.buy.complete, true);
  assert.equal(requested.buy.estimatedFeeUsd, 2);
  assert.ok(requested.buy.averagePrice > 101);
  artifactSpecSchema.parse(buildTradeImpactArtifact(impact, 200));
});

test("portfolio risk aggregates repeated spot assets and does not invent leveraged positions", () => {
  const spec = buildPortfolioRiskArtifact([{
    portfolio_balances: {
      total_balance: { value: "100" },
      total_cash_equivalent_balance: { value: "10" },
    },
    spot_positions: [
      { asset: "SOL", total_balance_fiat: 30, total_balance_crypto: 0.2 },
      { asset: "SOL", total_balance_fiat: 20, total_balance_crypto: 0.1 },
      { asset: "BTC", total_balance_fiat: 40, total_balance_crypto: 0.001 },
    ],
  }], []);
  artifactSpecSchema.parse(spec);
  assert.match(JSON.stringify(spec), /none returned/i);
  const chart = spec.blocks.find((block) => block.type === "chart");
  assert.deepEqual(chart.series[0].points[0], { label: "SOL", value: 50 });
});

test("on-chain resolution selects the most liquid exact or wrapped representation", () => {
  const token = selectTokenRepresentation({ data: [
    { chain: "ethereum", token_symbol: "WHYPE", token_address: "0x1", liquidity: 10 },
    { chain: "hyperevm", token_symbol: "WHYPE", token_address: "0x2", liquidity: 100 },
    { chain: "base", token_symbol: "NOTHYPE", token_address: "0x3", liquidity: 10_000 },
  ] }, "HYPE");
  assert.equal(token.token_address, "0x2");
  artifactSpecSchema.parse(buildOnchainFlowArtifact("HYPE", {
    ...token,
    netflow: 100,
    buy_volume: 1000,
    sell_volume: 900,
    liquidity: 50_000,
    price_usd: 55,
  }, { data: [{ whale_net_flow_usd: 25_000, whale_wallet_count: 4, exchange_net_flow_usd: -10_000, exchange_wallet_count: 2 }] }));
});

test("derivatives artifact stays valid when paid position data is unavailable", () => {
  const spec = buildDerivativesArtifact({
    symbol: "BTC",
    markPrice: 70_000,
    change24hPercent: 2,
    openInterestUsd: 2_000_000,
    openInterestBase: 28,
    annualizedFundingPercent: 10,
    hourlyFundingRate: 0.00001,
    volume24hUsd: 1_000_000,
    maxLeverage: 40,
    crowding: "mixed",
    premiumPercent: 0,
    fundingHistory: [],
  }, null, ["Nansen unavailable"]);
  artifactSpecSchema.parse(spec);
});
