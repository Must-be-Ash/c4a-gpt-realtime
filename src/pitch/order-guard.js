// Server-side limits for orders placed on a pitch call. The model can't lift
// them: the guard is attached by the webhook from call context, never from
// tool arguments, and re-checked at execute time against the stored preview.

const FEE_BUFFER = 1.02; // price drift + fees on estimates

const num = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Worst-case USD notional of a normalized order.
 * @param {object} order           { productId, side, quoteSize?, baseSize? }
 * @param {object} previewResult   Coinbase preview (may be an estimate)
 * @param {object} [opts]
 * @param {number|null} [opts.price]         live price for the product (or underlying)
 * @param {number|null} [opts.contractSize]  futures multiplier
 */
export function estimateNotionalUsd(order, previewResult, { price = null, contractSize = null } = {}) {
  const quote = num(order.quoteSize);
  const total = num(previewResult?.order_total);
  const fees = num(previewResult?.commission_total) ?? 0;
  if (quote != null) return Math.max(quote, total ?? 0);
  const base = num(order.baseSize);
  if (base == null) return null;
  const px = num(previewResult?.est_average_filled_price) ?? num(price);
  if (/-CDE$/.test(order.productId)) {
    if (px == null || contractSize == null) return null;
    return base * contractSize * px * FEE_BUFFER;
  }
  // Spot previews report order_total; equities don't have API previews.
  if (total != null && !previewResult?.estimated) return total;
  return px == null ? null : base * px * FEE_BUFFER + fees;
}

/**
 * @param {object} guard   { maxUsd, productId }
 * @returns {string|null}  error message, or null if the order is allowed
 */
export function pitchGuardViolation(guard, order, notionalUsd) {
  if (!guard) return null;
  if (order.side !== "BUY") return "Only buys of the pitched product are allowed on this line.";
  if (order.productId !== guard.productId) return `This line can only trade ${guard.productId}.`;
  if (notionalUsd == null) return "Couldn't size this order against the pitch-line cap; use a dollar amount instead.";
  if (notionalUsd > guard.maxUsd) {
    return `That's about $${Math.round(notionalUsd)}; the max on this line is $${guard.maxUsd}. Offer $${guard.maxUsd} or less.`;
  }
  return null;
}

// Coinbase has no API order preview for equities ("API order preview is not
// available for equities products"). Build an estimate from the live price so
// the agent can still read back what the order will cost before executing.
export const isEquityPreviewUnavailable = (error) => /order preview is not available for equities/i.test(String(error?.message ?? error));

export function equityPreviewEstimate(order, price) {
  const quote = num(order.quoteSize);
  const base = num(order.baseSize);
  // A limit order won't fill above its limit; value it there.
  const px = num(order.limitPrice) ?? num(price);
  if (px == null) throw new Error("Coinbase has no preview for stocks and no live price was available to estimate this order.");
  const shares = base ?? (quote != null ? quote / px : null);
  return {
    estimated: true,
    note: "Coinbase has no API preview for stocks; this is an estimate at the live price. The fill may differ slightly.",
    est_average_filled_price: String(px),
    base_size: shares == null ? null : String(Math.round(shares * 1e5) / 1e5),
    quote_size: quote != null ? String(quote) : String(Math.round(shares * px * 100) / 100),
    order_total: quote != null ? String(quote) : String(Math.round(shares * px * 100) / 100),
    commission_total: null,
  };
}
