import assert from "node:assert/strict";
import test from "node:test";

import { buildFacts, buyingPower, renderVapiVariables, suggestSize, ungroundedNumbers, writeBrief } from "../src/pitch/brief.js";

const balances = (usd, usdc = 0) => ({
  accounts: [
    { currency: "USD", available_balance: { value: String(usd) } },
    { currency: "USDC", available_balance: { value: String(usdc) } },
  ],
});

test("buyingPower uses USD, or USDC for crypto when larger", () => {
  assert.deepEqual(buyingPower(balances(100, 500), "NKE-USD", "equity"), { currency: "USD", amount: 100, productId: "NKE-USD" });
  assert.deepEqual(buyingPower(balances(100, 500), "BTC-USD", "spot"), { currency: "USDC", amount: 500, productId: "BTC-USDC" });
  assert.deepEqual(buyingPower(balances(900, 500), "BTC-USD", "spot"), { currency: "USD", amount: 900, productId: "BTC-USD" });
  assert.equal(buyingPower(balances(100, 500), "NOL-20OCT26-CDE", "future").currency, "USD");
});

const pct = { upsidePct: 10, downsidePct: -5 };

test("equity sizing rounds to whole shares within 5% of buying power and the cap", () => {
  const s = suggestSize({ kind: "equity", price: 36.3, ...pct }, { available: 4000, maxOrderUsd: 500 });
  assert.equal(s.units, 5); // 5% of 4000 = 200 → 5 shares
  assert.equal(s.usd, 181.5);
  assert.equal(s.amountType, "base");
  assert.equal(s.pnlAtTarget, 18.15);
  assert.equal(s.pnlAtStop, -9.07);
  assert.equal(s.lowBuyingPower, false);
});

test("sizing never exceeds the cap", () => {
  const s = suggestSize({ kind: "equity", price: 36.3, ...pct }, { available: 100_000, maxOrderUsd: 500 });
  assert.ok(s.usd <= 500);
  assert.equal(s.units, 13);
});

test("expensive equities fall back to a dollar amount", () => {
  const s = suggestSize({ kind: "equity", price: 1140, ...pct }, { available: 4000, maxOrderUsd: 500 });
  assert.equal(s.units, null);
  assert.equal(s.usd, 200);
  assert.equal(s.amountType, "quote");
});

test("thin accounts get a tiny size flagged as low buying power", () => {
  const s = suggestSize({ kind: "equity", price: 36.3, ...pct }, { available: 17.4, maxOrderUsd: 500 });
  assert.equal(s.usd, 17);
  assert.equal(s.lowBuyingPower, true);
  assert.equal(suggestSize({ kind: "equity", price: 36.3, ...pct }, { available: 0.5, maxOrderUsd: 500 }).usd, null);
});

test("crypto sizes in dollars", () => {
  const s = suggestSize({ kind: "spot", price: 75000, ...pct }, { available: 2000, maxOrderUsd: 500 });
  assert.equal(s.usd, 100);
  assert.equal(s.unitLabel, "coins");
});

test("futures size to one contract only when it fits the cap and the account", () => {
  const fits = suggestSize({ kind: "future", price: 2.9, contractSize: 100, ...pct }, { available: 1000, maxOrderUsd: 500 });
  assert.deepEqual([fits.units, fits.usd, fits.amountType], [1, 290, "base"]);
  assert.equal(suggestSize({ kind: "future", price: 2.9, contractSize: 100, ...pct }, { available: 200, maxOrderUsd: 500 }).usd, null);
  assert.equal(suggestSize({ kind: "future", price: 102.5, contractSize: 10, ...pct }, { available: 5000, maxOrderUsd: 500 }).usd, null);
});

const candidate = (over = {}) => ({
  idea: {
    symbol: "WTI", name: "WTI Crude Oil", entry: 103.56, stop: 99.9, target: 112, traderName: "Rig Margins",
    thesis: { conviction: 7, title: "t", summary: "s", interpretation: "i", keyPoints: ["Hormuz transits fell to 4"], body: "b", sources: [{ title: "x", source: "reuters.com", url: "u", snippet: "WTI held 100" }] },
  },
  product: { productId: "USO-USD", kind: "equity", proxyOf: "WTI", underlyingName: "crude oil", displayName: "the USO oil fund", contractSize: null },
  underlying: { price: 102.5, trend: { change30dPct: 21.2 } },
  productQuote: { price: 156.85 },
  metrics: { upsidePct: 9.3, downsidePct: -2.5, rewardRisk: 3.6 },
  news: { verdict: "supports", reason: "r", facts: [{ title: "a", source: "reuters.com", url: "v", fact: "Transits fell to 4." }] },
  ...over,
});

test("proxy facts translate the desk levels by percentage", () => {
  const f = buildFacts(candidate(), { record: { closedTrades: 6, hitRatePct: 50, realizedPnlUsd: 1386 }, balances: balances(4000), maxOrderUsd: 500 });
  assert.equal(f.productId, "USO-USD");
  assert.equal(f.stop, 152.87); // 99.9 * 156.85/102.5
  assert.equal(f.target, 171.39); // 112 * 156.85/102.5
  assert.equal(f.underlyingName, "crude oil");
  assert.equal(f.trader.credible, false); // 50% hit rate isn't worth bragging about
  assert.equal(f.suggested.units, 1);
});

test("a strong record is marked credible", () => {
  const f = buildFacts(candidate(), { record: { closedTrades: 5, hitRatePct: 80, realizedPnlUsd: 900 }, balances: balances(4000), maxOrderUsd: 500 });
  assert.equal(f.trader.credible, true);
});

test("grounding rejects invented numbers and accepts traceable ones", () => {
  const facts = buildFacts(candidate(), { record: null, balances: balances(4000), maxOrderUsd: 500 });
  assert.deepEqual(ungroundedNumbers(["Your $6,000 could be $60,000!"], facts), ["6,000", "60,000"]);
  assert.deepEqual(ungroundedNumbers(["Hormuz transits fell to 4, oil held 100, 9.3% upside to 171.39, 30-day run."], facts), []);
  assert.deepEqual(ungroundedNumbers(["Stop at 152.9, down 2.5%."], facts), []);
  assert.deepEqual(ungroundedNumbers(["Analysts see 250."], facts), ["250"]);
});

function fakeWriter(drafts) {
  let i = 0;
  const prompts = [];
  const request = async (_url, options) => {
    prompts.push(JSON.parse(options.body).input);
    return { output_text: JSON.stringify(drafts[Math.min(i++, drafts.length - 1)]) };
  };
  request.prompts = prompts;
  return request;
}

const words = (over = {}) => ({
  spokenName: "crude oil via USO", opener: "Jordan here. Give me sixty seconds.", hook: "h", trendLine: "Up 21.2% in 30 days.",
  catalyst: "Transits fell to 4.", whyNow: "w", theTurn: "t", keyRisk: "Stop 152.87, about 2.5% below.", close: "c",
  voicemail: "Jordan here. Call me back on this number.", sourceLine: "Per Reuters.", ...over,
});

test("writeBrief retries once with the offending numbers, then succeeds", async () => {
  const facts = buildFacts(candidate(), { record: null, balances: balances(4000), maxOrderUsd: 500 });
  const request = fakeWriter([words({ hook: "It could run 40% from here." }), words({ hook: "Upside $9.3% to the target." })]);
  const out = await writeBrief(facts, { apiKey: "k", model: "m", request });
  assert.equal(out.ok, true);
  assert.match(request.prompts[1], /numbers not in the facts: 40/);
  assert.equal(out.brief.words.hook, "Upside 9.3% to the target."); // "$9.3%" cleaned
});

test("writeBrief gives up when the model keeps inventing numbers", async () => {
  const facts = buildFacts(candidate(), { record: null, balances: balances(4000), maxOrderUsd: 500 });
  const out = await writeBrief(facts, { apiKey: "k", model: "m", request: fakeWriter([words({ hook: "Guaranteed 60,000." })]) });
  assert.deepEqual(out, { ok: false, reason: "ungrounded", detail: ["60,000"] });
});

test("renderVapiVariables produces flat strings for Vapi", () => {
  const facts = buildFacts(candidate(), { record: null, balances: balances(4000), maxOrderUsd: 500 });
  const out = renderVapiVariables({ facts, words: words() });
  assert.equal(out.firstMessage, "Jordan here. Give me sixty seconds.");
  assert.match(out.voicemailMessage, /call me back/i);
  for (const [key, value] of Object.entries(out.variableValues)) assert.equal(typeof value, "string", key);
  assert.equal(out.variableValues.suggestedSize, "1 share (~$156.85)");
  assert.match(out.variableValues.proxyNote, /USO-USD/);
  assert.match(out.variableValues.pnlAtStop, /loss$/);
});
