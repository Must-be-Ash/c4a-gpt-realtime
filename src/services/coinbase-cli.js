import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { coinbaseCommand } from "./coinbase-command.js";

const COINBASE_PRODUCT = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
const FUTURES_PRODUCT = /-CDE$/;
const EQUITY_TRADING_SESSIONS = new Set(["PRE_MARKET", "AFTER_HOURS", "OVERNIGHT", "MULTI_SESSION"]);

const positiveDecimal = (value, label) => {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
    throw new Error(`${label} must be a positive decimal.`);
  }
  return text;
};

const decimalRatio = (value, label) => {
  const text = positiveDecimal(value, label);
  const [whole, fraction = ""] = text.split(".");
  return {
    numerator: BigInt(`${whole}${fraction}`),
    denominator: 10n ** BigInt(fraction.length),
  };
};

const formatScaledDecimal = (numerator, denominator) => {
  const decimalPlaces = denominator.toString().length - 1;
  const padded = numerator.toString().padStart(decimalPlaces + 1, "0");
  if (decimalPlaces === 0) return padded;
  const whole = padded.slice(0, -decimalPlaces);
  const fraction = padded.slice(-decimalPlaces).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
};

const sizeFromIncrementUnits = (units, increment) => {
  if (units <= 0n) throw new Error("Order amount is below Coinbase's minimum base increment.");
  return formatScaledDecimal(units * increment.numerator, increment.denominator);
};

export function quantizeBaseSize(baseSize, baseIncrement) {
  const size = decimalRatio(baseSize, "baseSize");
  const increment = decimalRatio(baseIncrement, "baseIncrement");
  const units = (size.numerator * increment.denominator)
    / (size.denominator * increment.numerator);
  return sizeFromIncrementUnits(units, increment);
}

export function quoteSizeToBaseSize(quoteSize, limitPrice, baseIncrement) {
  const quote = decimalRatio(quoteSize, "quoteSize");
  const price = decimalRatio(limitPrice, "limitPrice");
  const increment = decimalRatio(baseIncrement, "baseIncrement");
  const units = (quote.numerator * price.denominator * increment.denominator)
    / (quote.denominator * price.numerator * increment.numerator);
  return sizeFromIncrementUnits(units, increment);
}

export function quantizePrice(price, quoteIncrement, rounding = "floor") {
  const value = decimalRatio(price, "price");
  const increment = decimalRatio(quoteIncrement, "quoteIncrement");
  const numerator = value.numerator * increment.denominator;
  const denominator = value.denominator * increment.numerator;
  let units = numerator / denominator;
  if (rounding === "ceil" && numerator % denominator !== 0n) units += 1n;
  if (units <= 0n) throw new Error("Price is below Coinbase's minimum quote increment.");
  return formatScaledDecimal(units * increment.numerator, increment.denominator);
}

export function normalizeMarketOrder(input) {
  const productId = String(input.productId ?? "").toUpperCase();
  const side = String(input.side ?? "").toUpperCase();
  const type = String(input.type ?? "market").toLowerCase();
  if (productId.length > 64 || !COINBASE_PRODUCT.test(productId)) {
    throw new Error("productId must be a valid Coinbase product such as AAPL-USD or BIT-28AUG26-CDE.");
  }
  if (!new Set(["BUY", "SELL"]).has(side)) throw new Error("side must be BUY or SELL.");
  if (!new Set(["market", "limit", "stop_limit"]).has(type)) {
    throw new Error("type must be market, limit, or stop_limit.");
  }

  const hasQuoteSize = input.quoteSize != null;
  const hasBaseSize = input.baseSize != null;
  if (hasQuoteSize === hasBaseSize) throw new Error("Provide exactly one of quoteSize or baseSize.");
  if (hasQuoteSize && (type !== "market" || side !== "BUY")) {
    throw new Error("This order uses baseSize only; quoteSize is supported only for market BUY orders.");
  }
  if (FUTURES_PRODUCT.test(productId) && hasQuoteSize) {
    throw new Error("Futures orders must use baseSize in contracts, including market BUY orders.");
  }

  const order = { productId, side, type };
  if (hasQuoteSize) order.quoteSize = positiveDecimal(input.quoteSize, "quoteSize");
  if (hasBaseSize) order.baseSize = positiveDecimal(input.baseSize, "baseSize");

  if (type === "market") {
    if (input.equityTradingSession != null) {
      throw new Error("Extended-hours equity sessions accept limit orders only.");
    }
    return order;
  }
  order.limitPrice = positiveDecimal(input.limitPrice, "limitPrice");
  if (type === "limit") {
    const equityTradingSession = input.equityTradingSession == null
      ? null
      : String(input.equityTradingSession).toUpperCase();
    if (equityTradingSession != null) {
      if (!EQUITY_TRADING_SESSIONS.has(equityTradingSession)) {
        throw new Error("equityTradingSession must be PRE_MARKET, AFTER_HOURS, OVERNIGHT, or MULTI_SESSION.");
      }
      if (!/^\d+(?:\.0+)?$/.test(order.baseSize)) {
        throw new Error("Extended-hours equity sessions accept whole-share limit orders only.");
      }
      order.equityTradingSession = equityTradingSession;
    }
    return order;
  }

  if (input.equityTradingSession != null) {
    throw new Error("Extended-hours equity sessions accept limit orders only.");
  }

  order.stopPrice = positiveDecimal(input.stopPrice, "stopPrice");
  order.stopDirection = String(input.stopDirection ?? "").toLowerCase();
  if (!new Set(["up", "down"]).has(order.stopDirection)) {
    throw new Error("stopDirection must be up or down.");
  }
  return order;
}

export async function prepareOrderForPreview(input, { getProduct }) {
  const type = String(input.type ?? "market").toLowerCase();
  const productId = String(input.productId ?? "").toUpperCase();
  if (FUTURES_PRODUCT.test(productId) && input.quoteSize != null) {
    throw new Error("Futures orders must use baseSize in contracts, including priced BUY orders.");
  }
  if (input.equityTradingSession != null && input.quoteSize != null) {
    throw new Error("Extended-hours equity sessions use baseSize for whole shares; quoteSize is not supported.");
  }
  if (input.equityTradingSession != null && !/^\d+(?:\.0+)?$/.test(String(input.baseSize ?? ""))) {
    throw new Error("Extended-hours equity sessions require an explicit whole-share baseSize.");
  }
  if (type === "market") {
    const order = normalizeMarketOrder(input);
    return {
      order,
      requestedQuoteSize: order.quoteSize ?? null,
      baseIncrement: null,
    };
  }

  const product = await getProduct(productId);
  const baseIncrement = positiveDecimal(product?.base_increment, "Coinbase base_increment");
  const quoteIncrement = positiveDecimal(product?.quote_increment, "Coinbase quote_increment");
  const side = String(input.side ?? "").toUpperCase();
  const limitPrice = quantizePrice(input.limitPrice, quoteIncrement, side === "SELL" ? "ceil" : "floor");
  const stopDirection = String(input.stopDirection ?? "").toLowerCase();
  const stopPrice = type === "stop_limit"
    ? quantizePrice(input.stopPrice, quoteIncrement, stopDirection === "up" ? "ceil" : "floor")
    : undefined;
  const requestedQuoteSize = side === "BUY" && input.quoteSize != null
    ? positiveDecimal(input.quoteSize, "quoteSize")
    : null;
  const baseSize = requestedQuoteSize != null
    ? quoteSizeToBaseSize(requestedQuoteSize, limitPrice, baseIncrement)
    : quantizeBaseSize(input.baseSize, baseIncrement);
  const { quoteSize: _quoteSize, ...orderInput } = input;
  const order = normalizeMarketOrder({ ...orderInput, baseSize, limitPrice, ...(stopPrice == null ? {} : { stopPrice }) });

  return { order, requestedQuoteSize, baseIncrement };
}

export function buildOrderArgs(action, order, clientOrderId) {
  if (!new Set(["preview", "create"]).has(action)) throw new Error("Unsupported Coinbase order action.");
  const sizeArg = order.quoteSize != null
    ? `quote_size=${order.quoteSize}`
    : `base_size=${order.baseSize}`;
  const args = [
    "orders",
    action,
    `product_id=${order.productId}`,
    `side=${order.side}`,
    `type=${order.type}`,
    sizeArg,
  ];
  if (order.type !== "market") {
    args.push(`limit_price=${order.limitPrice}`);
    if (order.type === "stop_limit") {
      args.push(`stop_price=${order.stopPrice}`, `stop_direction=${order.stopDirection}`);
    }
    args.push("time_in_force=GTC");
    if (order.equityTradingSession) {
      args.push(`equity_trading_session=${order.equityTradingSession}`);
    }
  }
  if (action === "create") {
    if (!clientOrderId) throw new Error("clientOrderId is required to create an order.");
    args.push(`client_order_id=${clientOrderId}`);
  }
  return args;
}

export function findAvailableBalance(payload, currency) {
  const wanted = String(currency ?? "").toUpperCase();
  const account = payload?.accounts?.find((item) => String(item.currency ?? "").toUpperCase() === wanted);
  const value = account?.available_balance?.value;
  return value == null ? null : String(value);
}

export function describeInsufficientFunds(order, balances) {
  const parts = String(order.productId).split("-");
  const quoteCurrency = ["USD", "USDC"].includes(parts.at(-1)) ? parts.at(-1) : "USD";
  const currency = order.side === "BUY" ? quoteCurrency : parts[0];
  const available = findAvailableBalance(balances, currency);
  const suffix = available == null ? "" : ` Available ${currency}: ${available}.`;
  return `Coinbase rejected the ${order.productId} ${order.side} preview for insufficient funds.${suffix}`;
}

const runCoinbase = (args, { env = process.env, timeoutMs = 30_000 } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(coinbaseCommand.command, [...coinbaseCommand.args, ...args], {
      env: { ...env, COINBASE_ENV: env.COINBASE_ENV || "live", COINBASE_NO_HISTORY: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Coinbase CLI failed (${code}): ${stderr.trim() || stdout.trim() || "unknown error"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Coinbase CLI returned non-JSON output."));
      }
    });
  });

export function createCoinbaseTrader({ env = process.env, runner = runCoinbase } = {}) {
  return {
    async balance() {
      return runner(["balance"], { env });
    },
    async preview(input) {
      const order = normalizeMarketOrder(input);
      return { order, result: await runner(buildOrderArgs("preview", order), { env }) };
    },
    async execute(order, clientOrderId = randomUUID()) {
      const normalized = normalizeMarketOrder(order);
      return runner(buildOrderArgs("create", normalized, clientOrderId), { env });
    },
  };
}
