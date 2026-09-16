// "Only call when it's real." Every desk idea must pass all of these checks
// before it can become a call. Cheap checks run first; the paid news check
// runs last and only for ideas that survived everything else.

import { isMarketOpen } from "./market-hours.js";
import { resolveProduct } from "./symbol-map.js";

const HOUR = 3_600_000;
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

// Pure price checks against the desk's own levels (underlying price terms).
export function priceChecks({ price, entry, stop, target }, { minRewardRisk }) {
  const reasons = [];
  if (![price, entry, stop, target].every(Number.isFinite)) return { reasons: ["missing_levels"], metrics: null };
  if (!(stop < entry && entry < target)) reasons.push("bad_levels");
  if (price <= stop) reasons.push("below_stop");
  if (price >= target) reasons.push("target_hit");
  const progress = (price - entry) / (target - entry);
  if (progress >= 0.5) reasons.push("move_mostly_done");
  const rewardRisk = price > stop ? (target - price) / (price - stop) : 0;
  if (rewardRisk < minRewardRisk) reasons.push("reward_risk_too_low");
  return {
    reasons,
    metrics: {
      price,
      upsidePct: round(((target - price) / price) * 100, 1),
      downsidePct: round(((stop - price) / price) * 100, 1),
      rewardRisk: round(rewardRisk, 2),
      progressPct: round(progress * 100, 0),
    },
  };
}

/**
 * @param {object} idea  desk idea
 * @param {object} deps
 * @param {object} deps.market          createMarketData()
 * @param {Function} deps.checkNews     createNewsCheck()
 * @param {object} deps.store           { hasPitched(ledgerId), lastPitchOfSymbol(symbol) -> ts|null }
 * @param {object} deps.desk            createDeskSource()
 * @param {object} deps.settings        config.pitch
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @returns {Promise<{ ok: boolean, reasons: string[], candidate?: object }>}
 */
export async function evaluateIdea(idea, { market, checkNews, store, desk, settings }, { now = Date.now() } = {}) {
  const fail = (...reasons) => ({ ok: false, reasons });

  // 1. The idea itself.
  if (!idea.thesis) return fail("no_thesis");
  if (idea.thesis.stance !== "bullish") return fail("not_bullish");
  if (!(idea.thesis.conviction >= settings.minConviction)) return fail("low_conviction");
  if (now - Date.parse(idea.openedAt) > settings.maxIdeaAgeHours * HOUR) return fail("stale");
  if (await store.hasPitched(idea.ledgerId)) return fail("already_pitched");
  const lastSameSymbol = await store.lastPitchOfSymbol(idea.symbol);
  if (lastSameSymbol && now - lastSameSymbol < 48 * HOUR) return fail("symbol_pitched_recently");

  // 2. Can the owner buy it on Coinbase within the cap?
  const product = await resolveProduct(idea, market, { maxOrderUsd: settings.maxOrderUsd, now });
  if (!product.ok) return fail(product.reason);
  if (product.kind !== "spot" && !isMarketOpen(now)) return fail("market_closed");

  // 3. Is the setup still intact at today's price?
  const underlying = await market.quote(product.underlyingRef);
  if (!underlying) return fail("no_price");
  const { reasons, metrics } = priceChecks({ price: underlying.price, entry: idea.entry, stop: idea.stop, target: idea.target }, settings);
  if (reasons.length) return fail(...reasons);
  const productQuote = product.productRef === product.underlyingRef ? underlying : await market.quote(product.productRef);
  if (!productQuote) return fail("no_price");

  // 4. Still open on the desk (the desk may have been stopped out meanwhile).
  if (!(await desk.isStillOpen(idea.ledgerId))) return fail("desk_closed_position");

  // 5. Nothing in the last 48 hours says the thesis is broken.
  let news;
  try {
    news = await checkNews(idea, product.proxyOf ? product.displayName.replace(/^the /, "") : (idea.name || idea.symbol), { now });
  } catch (error) {
    return { ok: false, reasons: ["news_check_failed"], error: error.message };
  }
  if (news.verdict === "contradicts") return { ok: false, reasons: ["news_contradicts"], news };

  return {
    ok: true,
    reasons: [],
    candidate: { idea, product, underlying, productQuote, metrics, news, evaluatedAt: new Date(now).toISOString() },
  };
}

// Best first: conviction, then reward/risk, then news support, then freshness.
export function rankCandidates(candidates) {
  const newsScore = { supports: 1, neutral: 0 };
  return [...candidates].sort((a, b) =>
    (b.idea.thesis.conviction - a.idea.thesis.conviction)
    || (b.metrics.rewardRisk - a.metrics.rewardRisk)
    || ((newsScore[b.news.verdict] ?? 0) - (newsScore[a.news.verdict] ?? 0))
    || (Date.parse(b.idea.openedAt) - Date.parse(a.idea.openedAt)));
}
