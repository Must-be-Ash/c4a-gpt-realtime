import { spawn } from "node:child_process";

const FIELDS = "token_symbol,side,action,token_amount,price_usd,value_usd,block_timestamp,trader_address_label";

export const buildSmartMoneyArgs = () => [
  "research",
  "smart-money",
  "perp-trades",
  "--limit",
  "100",
  "--fields",
  FIELDS,
];

const runNansen = (args, { env = process.env, timeoutMs = 35_000 } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("nansen", args, {
      env: { ...env, NO_COLOR: "1" },
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
      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        payload = null;
      }
      if (code !== 0 || payload?.success === false) {
        const fundingAddress = env.NANSEN_X402_EVM_ADDRESS;
        const paymentError = payload?.code === "PAYMENT_REQUIRED" && fundingAddress
          ? `Nansen x402 wallet needs USDC on Base. Fund ${fundingAddress}; this endpoint costs $0.05 per call.`
          : null;
        const error = new Error(paymentError || payload?.error || stderr.trim() || stdout.trim() || `Nansen CLI failed (${code}).`);
        error.status = payload?.status;
        reject(error);
        return;
      }
      if (!payload) {
        reject(new Error("Nansen CLI returned non-JSON output."));
        return;
      }
      resolve(payload);
    });
  });

const recordsFrom = (payload) => {
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};

const activityDirection = (record) => {
  const side = String(record.side ?? "").toLowerCase();
  const action = String(record.action ?? "").toLowerCase();
  const reducing = action.includes("close") || action.includes("reduce");
  if (side.includes("long")) return reducing ? "bearish" : "bullish";
  if (side.includes("short")) return reducing ? "bullish" : "bearish";
  return "neutral";
};

export function summarizeSmartMoney(payload, symbol) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const trades = recordsFrom(payload)
    .filter((record) => String(record.token_symbol ?? "").toUpperCase() === normalizedSymbol)
    .map((record) => ({
      ...record,
      valueUsd: Number(record.value_usd) || 0,
      signal: activityDirection(record),
    }));
  const total = (direction) => trades
    .filter((trade) => trade.signal === direction)
    .reduce((sum, trade) => sum + trade.valueUsd, 0);
  const bullishActivityUsd = total("bullish");
  const bearishActivityUsd = total("bearish");
  const netBiasUsd = bullishActivityUsd - bearishActivityUsd;
  const threshold = Math.max(bullishActivityUsd, bearishActivityUsd) * 0.1;
  const lean = Math.abs(netBiasUsd) <= threshold ? "mixed" : netBiasUsd > 0 ? "bullish" : "bearish";

  return {
    source: "Nansen Smart Money Perp Trades",
    symbol: normalizedSymbol,
    tradeCount: trades.length,
    bullishActivityUsd,
    bearishActivityUsd,
    netBiasUsd,
    lean,
    topTrades: trades
      .sort((a, b) => b.valueUsd - a.valueUsd)
      .slice(0, 8)
      .map(({ token_symbol, side, action, token_amount, price_usd, value_usd, block_timestamp, trader_address_label, signal }) => ({
        tokenSymbol: token_symbol,
        side,
        action,
        tokenAmount: token_amount,
        priceUsd: price_usd,
        valueUsd: value_usd,
        timestamp: block_timestamp,
        traderLabel: trader_address_label,
        signal,
      })),
  };
}

export function createNansenClient({ env = process.env, runner = runNansen } = {}) {
  return {
    async smartMoney({ symbol }) {
      const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{2,15}$/.test(normalizedSymbol)) throw new Error("symbol must be a crypto ticker such as HYPE or BTC.");
      const payload = await runner(buildSmartMoneyArgs(), { env });
      return summarizeSmartMoney(payload, normalizedSymbol);
    },
  };
}
