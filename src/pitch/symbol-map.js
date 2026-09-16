// Desk symbol -> something the owner can actually buy on Coinbase.
//
// Returns either { ok: true, ... } describing the product to pitch, or
// { ok: false, reason } so the pitch record can say why an idea was skipped.
//
//   ok result:
//     productId        Coinbase product to order (e.g. NKE-USD, USO-USD, GOL-25NOV26-CDE)
//     kind             "equity" | "spot" | "future"
//     displayName      Spoken name ("Nike", "the USO oil fund")
//     underlyingRef    Pricing ref for the desk's own levels (qualification)
//     productRef       Pricing ref for the product we order (sizing)
//     contractSize     Units per contract (futures), else null
//     proxyOf          Desk symbol when an ETF stands in for a futures idea
//     underlyingName   What the desk is actually trading, for proxies ("crude oil")

const CRYPTO = new Set(["BTC", "ETH", "SOL"]);
const NOT_ON_COINBASE = new Set(["CORN", "WHEAT", "SOY", "COFFEE", "SUGAR"]);

// Desk commodity symbol -> Coinbase futures root, Yahoo underlying, ETF proxy.
export const COMMODITIES = {
  GOLD: { root: "CDEGLD", yahoo: "GC=F", proxy: "GLD", name: "gold" },
  SILVER: { root: "CDESIL", yahoo: "SI=F", proxy: null, name: "silver" },
  PLATINUM: { root: "CDEPT", yahoo: "PL=F", proxy: null, name: "platinum" },
  COPPER: { root: "CDECU", yahoo: "HG=F", proxy: null, name: "copper" },
  WTI: { root: "CDEOIL", yahoo: "CL=F", proxy: "USO", name: "crude oil" },
  NATGAS: { root: "CDENGS", yahoo: "NG=F", proxy: null, name: "natural gas" },
};

const PROXY_NAMES = { USO: "the USO oil fund", GLD: "the GLD gold fund" };

// Don't pitch a contract that expires before the idea can play out.
const MIN_DAYS_TO_EXPIRY = 7;

export function pickFrontContract(futures, root, now = Date.now()) {
  const cutoff = now + MIN_DAYS_TO_EXPIRY * 86_400_000;
  return futures
    .filter((p) => {
      const d = p.future_product_details;
      return d?.contract_root_unit === root
        && Date.parse(d.contract_expiry) > cutoff
        && !p.trading_disabled && !p.is_disabled;
    })
    .sort((a, b) => Date.parse(a.future_product_details.contract_expiry) - Date.parse(b.future_product_details.contract_expiry))[0] ?? null;
}

/**
 * @param {object} idea            From desk-source (needs symbol, name).
 * @param {object} market          From createMarketData().
 * @param {object} opts
 * @param {number} opts.maxOrderUsd
 * @param {number} [opts.now]
 */
export async function resolveProduct(idea, market, { maxOrderUsd, now = Date.now() }) {
  const symbol = String(idea.symbol || "").toUpperCase();

  if (NOT_ON_COINBASE.has(symbol)) return { ok: false, reason: "not_on_coinbase" };

  if (CRYPTO.has(symbol)) {
    const productId = `${symbol}-USD`;
    const ref = { source: "coinbase", symbol: productId };
    return { ok: true, productId, kind: "spot", displayName: idea.name || symbol, underlyingRef: ref, productRef: ref, contractSize: null, proxyOf: null };
  }

  const commodity = COMMODITIES[symbol];
  if (commodity) {
    const underlyingRef = { source: "yahoo", symbol: commodity.yahoo };
    const contract = pickFrontContract(await market.futuresList(), commodity.root, now);
    if (contract) {
      const contractSize = Number(contract.future_product_details.contract_size);
      const notional = contractSize * Number(contract.price);
      if (Number.isFinite(notional) && notional <= maxOrderUsd) {
        return {
          ok: true,
          productId: contract.product_id,
          kind: "future",
          displayName: `${commodity.name} futures`,
          underlyingRef,
          productRef: underlyingRef,
          contractSize,
          contractExpiry: contract.future_product_details.contract_expiry,
          proxyOf: null,
        };
      }
    }
    if (!commodity.proxy) return { ok: false, reason: contract ? "over_cap" : "no_contract" };
    const proxy = await market.coinbaseProduct(`${commodity.proxy}-USD`);
    if (!proxy || proxy.product_type !== "EQUITY") return { ok: false, reason: "not_tradable" };
    return {
      ok: true,
      productId: proxy.product_id,
      kind: "equity",
      displayName: PROXY_NAMES[commodity.proxy] || commodity.proxy,
      underlyingRef,
      productRef: { source: "yahoo", symbol: commodity.proxy },
      contractSize: null,
      proxyOf: symbol,
      underlyingName: commodity.name,
    };
  }

  if (!/^[A-Z.]{1,6}$/.test(symbol)) return { ok: false, reason: "not_tradable" };
  const product = await market.coinbaseProduct(`${symbol}-USD`);
  if (!product || product.product_type !== "EQUITY") return { ok: false, reason: "not_tradable" };
  const ref = { source: "yahoo", symbol: symbol.replace(".", "-") };
  return { ok: true, productId: product.product_id, kind: "equity", displayName: idea.name || symbol, underlyingRef: ref, productRef: ref, contractSize: null, proxyOf: null };
}
