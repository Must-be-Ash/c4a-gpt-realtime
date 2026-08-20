import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderArgs,
  createCoinbaseTrader,
  describeInsufficientFunds,
  findAvailableBalance,
  normalizeMarketOrder,
  prepareOrderForPreview,
} from "../src/services/coinbase-cli.js";

test("normalizes a market buy into an explicit quote-sized order", () => {
  assert.deepEqual(
    normalizeMarketOrder({ productId: "hype-usd", side: "buy", quoteSize: "25" }),
    { productId: "HYPE-USD", side: "BUY", type: "market", quoteSize: "25" },
  );
});

test("accepts any syntactically valid USD crypto product", () => {
  assert.equal(
    normalizeMarketOrder({ productId: "sol-usd", side: "buy", quoteSize: "5" }).productId,
    "SOL-USD",
  );
  assert.throws(
    () => normalizeMarketOrder({ productId: "not a market", side: "BUY", quoteSize: "5" }),
    /USD product/,
  );
});

test("rejects mutually exclusive or missing sizes", () => {
  assert.throws(
    () => normalizeMarketOrder({ productId: "BTC-USD", side: "BUY", quoteSize: 10, baseSize: 1 }),
    /quoteSize only/,
  );
  assert.throws(
    () => normalizeMarketOrder({ productId: "BTC-USD", side: "SELL" }),
    /baseSize/,
  );
});

test("builds fully explicit preview and create arguments", () => {
  const order = normalizeMarketOrder({ productId: "BTC-USD", side: "SELL", baseSize: "0.001" });
  assert.deepEqual(buildOrderArgs("preview", order), [
    "orders", "preview", "product_id=BTC-USD", "side=SELL", "type=market", "base_size=0.001",
  ]);
  assert.deepEqual(buildOrderArgs("create", order, "fixed-client-id"), [
    "orders", "create", "product_id=BTC-USD", "side=SELL", "type=market", "base_size=0.001",
    "client_order_id=fixed-client-id",
  ]);
});

test("normalizes and builds a limit order with an explicit base size and price", () => {
  const order = normalizeMarketOrder({
    productId: "BTC-USD",
    side: "BUY",
    type: "limit",
    baseSize: "0.001",
    limitPrice: "62000",
  });

  assert.deepEqual(order, {
    productId: "BTC-USD",
    side: "BUY",
    type: "limit",
    baseSize: "0.001",
    limitPrice: "62000",
  });
  assert.deepEqual(buildOrderArgs("preview", order), [
    "orders", "preview", "product_id=BTC-USD", "side=BUY", "type=limit",
    "base_size=0.001", "limit_price=62000", "time_in_force=GTC",
  ]);
});

test("converts a dollar-denominated HYPE limit buy to its exact base increment", async () => {
  const prepared = await prepareOrderForPreview({
    productId: "HYPE-USD",
    side: "BUY",
    type: "limit",
    quoteSize: "15",
    limitPrice: "55",
  }, {
    getProduct: async () => ({ base_increment: "0.001", quote_increment: "0.01" }),
  });

  assert.deepEqual(prepared, {
    order: {
      productId: "HYPE-USD",
      side: "BUY",
      type: "limit",
      baseSize: "0.272",
      limitPrice: "55",
    },
    requestedQuoteSize: "15",
    baseIncrement: "0.001",
  });
});

test("rounds an over-precise priced-order base size down before Coinbase sees it", async () => {
  const prepared = await prepareOrderForPreview({
    productId: "HYPE-USD",
    side: "BUY",
    type: "limit",
    baseSize: "0.2727273",
    limitPrice: "55",
  }, {
    getProduct: async () => ({ base_increment: "0.001", quote_increment: "0.01" }),
  });

  assert.equal(prepared.order.baseSize, "0.272");
});

test("uses each product's live base and quote increments instead of HYPE-specific values", async () => {
  const btc = await prepareOrderForPreview({
    productId: "BTC-USD",
    side: "BUY",
    type: "limit",
    quoteSize: "12.345678",
    limitPrice: "60000.009",
  }, {
    getProduct: async () => ({ base_increment: "0.00000001", quote_increment: "0.01" }),
  });
  const sol = await prepareOrderForPreview({
    productId: "SOL-USD",
    side: "SELL",
    type: "limit",
    baseSize: "1.234567",
    limitPrice: "123.451",
  }, {
    getProduct: async () => ({ base_increment: "0.001", quote_increment: "0.01" }),
  });

  assert.equal(btc.order.limitPrice, "60000");
  assert.equal(btc.order.baseSize, "0.00020576");
  assert.equal(sol.order.limitPrice, "123.46");
  assert.equal(sol.order.baseSize, "1.234");
});

test("normalizes and builds a stop-limit order with trigger direction", () => {
  const order = normalizeMarketOrder({
    productId: "BTC-USD",
    side: "SELL",
    type: "stop_limit",
    baseSize: "0.001",
    limitPrice: "59500",
    stopPrice: "60000",
    stopDirection: "down",
  });

  assert.deepEqual(buildOrderArgs("create", order, "fixed-client-id"), [
    "orders", "create", "product_id=BTC-USD", "side=SELL", "type=stop_limit",
    "base_size=0.001", "limit_price=59500", "stop_price=60000",
    "stop_direction=down", "time_in_force=GTC", "client_order_id=fixed-client-id",
  ]);
});

test("rejects incomplete or unsupported priced orders", () => {
  assert.throws(
    () => normalizeMarketOrder({ productId: "BTC-USD", side: "BUY", type: "limit", baseSize: "0.001" }),
    /limitPrice/,
  );
  assert.throws(
    () => normalizeMarketOrder({
      productId: "BTC-USD", side: "SELL", type: "stop_limit", baseSize: "0.001", limitPrice: "59000",
    }),
    /stopPrice/,
  );
  assert.throws(
    () => normalizeMarketOrder({ productId: "BTC-USD", side: "BUY", type: "twap", baseSize: "0.001" }),
    /market, limit, or stop_limit/,
  );
});

test("checks balances through the same Coinbase environment as orders", async () => {
  const calls = [];
  const trader = createCoinbaseTrader({
    env: { COINBASE_ENV: "live" },
    runner: async (args, options) => {
      calls.push({ args, options });
      return { accounts: [{ currency: "USD", available_balance: { value: "12.50", currency: "USD" } }] };
    },
  });

  const result = await trader.balance();

  assert.deepEqual(result, { accounts: [{ currency: "USD", available_balance: { value: "12.50", currency: "USD" } }] });
  assert.deepEqual(calls, [{ args: ["balance"], options: { env: { COINBASE_ENV: "live" } } }]);
});

test("always sends previews and executions to the Coinbase runner", async () => {
  const calls = [];
  const trader = createCoinbaseTrader({
    env: { COINBASE_ENV: "live" },
    runner: async (args, options) => {
      calls.push({ args, options });
      return args[1] === "preview" ? { order_total: "10" } : { order_id: "live-order" };
    },
  });
  const order = { productId: "BTC-USD", side: "BUY", type: "market", quoteSize: "10" };

  assert.deepEqual(await trader.preview(order), { order, result: { order_total: "10" } });
  assert.deepEqual(await trader.execute(order, "client-order"), { order_id: "live-order" });
  assert.deepEqual(calls.map(({ args }) => args), [
    ["orders", "preview", "product_id=BTC-USD", "side=BUY", "type=market", "quote_size=10"],
    ["orders", "create", "product_id=BTC-USD", "side=BUY", "type=market", "quote_size=10", "client_order_id=client-order"],
  ]);
});

test("finds the available balance for an exact currency", () => {
  const payload = {
    accounts: [
      { currency: "USDC", available_balance: { value: "8.25" } },
      { currency: "USD", available_balance: { value: "42.75" } },
    ],
  };

  assert.equal(findAvailableBalance(payload, "usd"), "42.75");
  assert.equal(findAvailableBalance(payload, "BTC"), null);
});

test("describes the exact balance relevant to an insufficient-funds order", () => {
  const balances = {
    accounts: [
      { currency: "USD", available_balance: { value: "42.75" } },
      { currency: "HYPE", available_balance: { value: "0.086" } },
    ],
  };

  assert.equal(
    describeInsufficientFunds({ productId: "HYPE-USD", side: "BUY", quoteSize: "50" }, balances),
    "Coinbase rejected the HYPE-USD BUY preview for insufficient funds. Available USD: 42.75.",
  );
  assert.equal(
    describeInsufficientFunds({ productId: "HYPE-USD", side: "SELL", baseSize: "1" }, balances),
    "Coinbase rejected the HYPE-USD SELL preview for insufficient funds. Available HYPE: 0.086.",
  );
});
