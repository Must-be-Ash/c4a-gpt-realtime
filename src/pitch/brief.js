// The pitch brief: everything Jordan may say on a call.
//
// Numbers are computed here, in code. The model only writes words around them,
// and a grounding check rejects any number in its text that isn't one of ours
// or doesn't appear in the source material.

import { findAvailableBalance } from "../services/coinbase-cli.js";
import { openAiJson } from "./openai-json.js";

const round = (value, places = 2) => (Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null);

// ── Sizing ──
export function buyingPower(balances, productId, kind) {
  const usd = Number(findAvailableBalance(balances, "USD") ?? 0);
  const usdc = Number(findAvailableBalance(balances, "USDC") ?? 0);
  // Spot crypto may trade against USDC; equities and futures are USD.
  if (kind === "spot" && usdc > usd) return { currency: "USDC", amount: usdc, productId: productId.replace(/-USD$/, "-USDC") };
  return { currency: "USD", amount: usd, productId };
}

/**
 * @returns {{ usd, units, unitLabel, amountType, lowBuyingPower, pnlAtTarget, pnlAtStop } | null}
 */
export function suggestSize({ kind, price, contractSize, upsidePct, downsidePct }, { available, maxOrderUsd }) {
  const lowBuyingPower = available < 50;
  let usd;
  if (available >= 100) usd = Math.min(maxOrderUsd, Math.max(100, available * 0.05));
  else usd = Math.min(maxOrderUsd, Math.floor(available));

  let units = null;
  let unitLabel;
  let amountType = "quote";
  if (kind === "future") {
    const notional = contractSize * price;
    if (notional > Math.min(maxOrderUsd, available)) return { usd: null, units: null, unitLabel: "contracts", amountType: "base", lowBuyingPower: true, pnlAtTarget: null, pnlAtStop: null };
    units = 1;
    usd = notional;
    unitLabel = "contract";
    amountType = "base";
  } else if (kind === "equity") {
    const whole = Math.floor(usd / price);
    if (whole >= 1) {
      units = whole;
      usd = whole * price;
      amountType = "base";
    }
    unitLabel = "shares";
  } else {
    unitLabel = "coins";
  }
  if (!(usd > 0)) return { usd: null, units: null, unitLabel, amountType, lowBuyingPower: true, pnlAtTarget: null, pnlAtStop: null };
  return {
    usd: round(usd, 2),
    units,
    unitLabel,
    amountType,
    lowBuyingPower,
    pnlAtTarget: round((usd * upsidePct) / 100, 2),
    pnlAtStop: round((usd * downsidePct) / 100, 2),
  };
}

// ── Facts (code-computed) ──
export function buildFacts(candidate, { record, balances, maxOrderUsd }) {
  const { idea, product, underlying, productQuote, metrics, news } = candidate;
  const price = productQuote.price;
  // Desk levels are in underlying terms; translate by % for ETF stand-ins.
  const scale = product.proxyOf ? price / underlying.price : 1;
  const stop = round(idea.stop * scale, 2);
  const target = round(idea.target * scale, 2);
  const bp = buyingPower(balances, product.productId, product.kind);
  const size = suggestSize(
    { kind: product.kind, price, contractSize: product.contractSize, upsidePct: metrics.upsidePct, downsidePct: metrics.downsidePct },
    { available: bp.amount, maxOrderUsd },
  );
  return {
    symbol: idea.symbol,
    name: product.proxyOf ? product.displayName : (idea.name || idea.symbol),
    productId: bp.productId,
    kind: product.kind,
    proxyOf: product.proxyOf,
    underlyingName: product.proxyOf ? product.underlyingName : null,
    contractSize: product.contractSize,
    price: round(price, 2),
    underlyingPrice: round(underlying.price, 2),
    deskEntry: idea.entry,
    deskStop: idea.stop,
    deskTarget: idea.target,
    stop,
    target,
    upsidePct: metrics.upsidePct,
    downsidePct: metrics.downsidePct,
    rewardRisk: metrics.rewardRisk,
    trend: underlying.trend,
    conviction: idea.thesis.conviction,
    trader: {
      name: idea.traderName,
      closedTrades: record?.closedTrades ?? 0,
      hitRatePct: record?.hitRatePct ?? null,
      realizedPnlUsd: record?.realizedPnlUsd ?? 0,
      // Only brag about a record worth bragging about.
      credible: Boolean(record && record.closedTrades >= 3 && record.hitRatePct >= 55),
    },
    buyingPower: { currency: bp.currency, amount: round(bp.amount, 2) },
    maxOrderUsd,
    suggested: size,
    thesis: {
      title: idea.thesis.title,
      summary: idea.thesis.summary,
      interpretation: idea.thesis.interpretation,
      keyPoints: idea.thesis.keyPoints,
      body: idea.thesis.body,
    },
    sources: [
      ...news.facts.map((f) => ({ title: f.title, source: f.source, url: f.url, fact: f.fact })),
      ...idea.thesis.sources.slice(0, 4).map((s) => ({ title: s.title, source: s.source, url: s.url, snippet: String(s.snippet ?? "").slice(0, 600) })),
    ],
    newsVerdict: news.verdict,
    newsReason: news.reason,
  };
}

// ── Grounding ──
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

function collectNumbers(value, into) {
  if (value == null) return into;
  if (typeof value === "number") {
    if (Number.isFinite(value)) for (const v of [value, Math.abs(value)]) {
      into.add(v);
      for (const p of [0, 1, 2]) into.add(round(v, p));
    }
    return into;
  }
  if (typeof value === "string") {
    for (const m of value.match(NUMBER) ?? []) collectNumbers(Number(m.replace(/,/g, "")), into);
    return into;
  }
  if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, into));
  else if (typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, into));
  return into;
}

// Numbers the model wrote that we can't trace back to facts. Small counting
// words ("2 things") and the cap are fine; everything else must be traceable.
export function ungroundedNumbers(texts, facts) {
  // Small counts, "sixty seconds", and the 30/90-day trend windows are always fine.
  const allowed = collectNumbers(facts, new Set([0, 1, 2, 3, 4, 5, 10, 30, 60, 90]));
  const bad = [];
  for (const text of texts) {
    for (const raw of String(text).match(NUMBER) ?? []) {
      const n = Number(raw.replace(/,/g, ""));
      if (!allowed.has(n) && !allowed.has(round(n, 0)) && !allowed.has(round(n, 1))) bad.push(raw);
    }
  }
  return bad;
}

// ── Writing ──
const WORDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["spokenName", "opener", "hook", "trendLine", "catalyst", "whyNow", "theTurn", "keyRisk", "close", "voicemail", "sourceLine"],
  properties: {
    spokenName: { type: "string", description: "How to say the asset out loud, e.g. Nike, Occidental, oil (through the USO oil fund)." },
    opener: { type: "string", description: "First words on the call, max 25 words." },
    hook: { type: "string", description: "One plain sentence: what we buy and why, like you would tell a friend." },
    trendLine: { type: "string", description: "Where price has been, from trend facts." },
    catalyst: { type: "string", description: "What just happened, in everyday words." },
    whyNow: { type: "string", description: "Why today and not next week, in everyday words." },
    theTurn: { type: "string", description: "Why the price should go up from here (the 'this turns it around' line), in everyday words." },
    keyRisk: { type: "string", description: "One honest plain sentence: where we get out and roughly what he would lose." },
    close: { type: "string", description: "The assumptive close using the suggested size." },
    voicemail: { type: "string", description: "Voicemail teaser, max 40 words, ends by asking for a call back on this number." },
    sourceLine: { type: "string", description: "Who reported it, e.g. per Reuters and Portnews." },
  },
};

function writerPrompt(facts) {
  return `You write the talking points for "Jordan", a Wolf-of-Wall-Street-style closer who phones his one client with a trade.
Jordan is cool, confident, dead serious about closing, and sharp. Short punchy spoken sentences. He needles the client to fire him up, never small talk, never jokes for their own sake. Mild swearing at most (hell, damn). He is selling a real idea, so every claim must be true.

The client wants to make money but is NEW TO INVESTING. Write for someone with zero finance knowledge:
- Everyday words. No jargon: never write thesis, catalyst, dislocation, tape, physical, reward-risk, basis points, bps, VLCC, LNG carrier, equity, sell-side, index trackers, forced flow. Say what they mean ("big funds have to sell", "fewer oil tankers can get through").
- Tell it like a short story: what happened, why that matters for this company, why the price should move.
- Money first: what he puts in and roughly what he could make or lose.
- One sentence per field, 25 words max, except voicemail.

Rules:
- Use ONLY facts below. Every number you write must appear in the facts (prices, percents, dollar amounts, dates, counts). Round the way the facts are rounded. Never invent analysts, targets, patents, or returns.
- Write every number as digits ("12-year low", not "twelve-year low"), except "sixty seconds" in the opener.
- Losses are said as positive amounts with words: "down 3.9%", "about $0.66 at the stop". Never write a minus sign.
- Say names the way people say them (Nike, not NKE). Say prices naturally ("thirty-six thirty" is fine as "$36.30").
- ${facts.proxyOf ? `The desk's idea is on ${facts.underlyingName}; the client buys ${facts.name} as the stand-in. Make that clear once.` : ""}
- trendLine uses trend.change30dPct / change90dPct / offHigh90dPct if meaningful.
- keyRisk names the stop ${facts.stop} and that it's about ${Math.abs(facts.downsidePct)}% below here.
- close: ${facts.suggested?.usd ? `suggest ${facts.suggested.units ? `${facts.suggested.units} ${facts.suggested.unitLabel} (about $${facts.suggested.usd})` : `$${facts.suggested.usd}`}; at the target that's about $${facts.suggested.pnlAtTarget}, at the stop about $${Math.abs(facts.suggested.pnlAtStop)}.` : "the account needs funding before a real position fits; tell him to fund it."}${facts.suggested?.lowBuyingPower ? ` His account only has $${facts.buyingPower.amount} available, so the position is tiny; needle him to fund the account so the next one actually counts.` : ""}
- ${facts.trader.credible ? `You may mention ${facts.trader.name}'s record: ${facts.trader.hitRatePct}% hit rate over ${facts.trader.closedTrades} closed trades.` : "Do not cite the desk trader's track record."}
- Never say guaranteed, can't lose, risk-free, or sure thing. Don't claim to be a licensed broker.
- opener starts with "Jordan here." and asks for sixty seconds.

FACTS:
${JSON.stringify(facts)}`;
}

/**
 * @returns {Promise<{ ok: true, brief } | { ok: false, reason, detail }>}
 */
export async function writeBrief(facts, { apiKey, model, request, attempts = 2 }) {
  let lastBad = [];
  for (let i = 0; i < attempts; i += 1) {
    const words = await openAiJson({
      apiKey,
      model,
      request,
      effort: "medium",
      name: "pitch_words",
      schema: WORDS_SCHEMA,
      input: writerPrompt(facts) + (lastBad.length ? `\n\nYour previous draft used numbers not in the facts: ${lastBad.join(", ")}. Remove or correct them.` : ""),
    });
    // "$8.7%" reads aloud as dollars; percentages never carry a dollar sign.
    for (const key of Object.keys(words)) words[key] = String(words[key]).replace(/\$(\d[\d,]*(?:\.\d+)?)%/g, "$1%");
    lastBad = ungroundedNumbers(Object.values(words), facts);
    if (!lastBad.length) return { ok: true, brief: { facts, words } };
  }
  return { ok: false, reason: "ungrounded", detail: lastBad };
}

// ── Vapi rendering ──
const fmtPct = (v) => (v == null ? "" : `${v > 0 ? "+" : ""}${v}%`);

export function renderVapiVariables(brief) {
  const { facts, words } = brief;
  const s = facts.suggested ?? {};
  return {
    firstMessage: words.opener,
    voicemailMessage: words.voicemail,
    variableValues: {
      asset: words.spokenName,
      productId: facts.productId,
      kind: facts.kind,
      proxyNote: facts.proxyOf ? `The desk trade is ${facts.underlyingName}; the client buys ${facts.name} (${facts.productId}) as the stand-in.` : "",
      price: String(facts.price),
      stop: String(facts.stop),
      target: String(facts.target),
      upside: fmtPct(facts.upsidePct),
      downside: fmtPct(facts.downsidePct),
      rewardRisk: String(facts.rewardRisk),
      trend: facts.trend ? `30d ${fmtPct(facts.trend.change30dPct)}, 90d ${fmtPct(facts.trend.change90dPct)}, ${fmtPct(facts.trend.offHigh90dPct)} off the 90-day high of ${facts.trend.high90d}` : "",
      conviction: `${facts.conviction}/10`,
      hook: words.hook,
      trendLine: words.trendLine,
      catalyst: words.catalyst,
      whyNow: words.whyNow,
      theTurn: words.theTurn,
      keyRisk: words.keyRisk,
      close: words.close,
      sourceLine: words.sourceLine,
      keyPoints: (facts.thesis.keyPoints ?? []).join(" | "),
      newsFacts: facts.sources.filter((x) => x.fact).map((x) => `${x.fact} (${x.source})`).join(" | "),
      suggestedSize: s.usd ? (s.units ? `${s.units} ${s.units === 1 ? s.unitLabel.replace(/s$/, "") : s.unitLabel} (~$${s.usd})` : `$${s.usd}`) : "none: account needs funding",
      suggestedAmount: s.usd ? String(s.units ?? s.usd) : "",
      suggestedAmountType: s.usd ? s.amountType : "",
      pnlAtTarget: s.pnlAtTarget == null ? "" : `$${s.pnlAtTarget}`,
      pnlAtStop: s.pnlAtStop == null ? "" : `$${Math.abs(s.pnlAtStop)} loss`,
      buyingPower: `${facts.buyingPower.currency} ${facts.buyingPower.amount}`,
      maxOrderUsd: String(facts.maxOrderUsd),
      deskTrader: facts.trader.name,
    },
  };
}
