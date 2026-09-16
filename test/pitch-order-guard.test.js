import assert from "node:assert/strict";
import test from "node:test";

import { equityPreviewEstimate, estimateNotionalUsd, isEquityPreviewUnavailable, pitchGuardViolation } from "../src/pitch/order-guard.js";

const guard = { maxUsd: 500, productId: "NKE-USD" };
const buy = (over) => ({ productId: "NKE-USD", side: "BUY", type: "market", ...over });

test("$499 quote passes, $501 fails", () => {
  const ok = buy({ quoteSize: "499" });
  assert.equal(pitchGuardViolation(guard, ok, estimateNotionalUsd(ok, equityPreviewEstimate(ok, 36.3))), null);
  const over = buy({ quoteSize: "501" });
  assert.match(pitchGuardViolation(guard, over, estimateNotionalUsd(over, equityPreviewEstimate(over, 36.3))), /max on this line is \$500/);
});

test("share orders are valued at the live price with a buffer", () => {
  const order = buy({ productId: "LLY-USD", baseSize: "2" }); // 2 x $300 stand-in
  const notional = estimateNotionalUsd(order, equityPreviewEstimate(order, 300));
  assert.equal(Math.round(notional), 612);
  assert.match(pitchGuardViolation({ maxUsd: 500, productId: "LLY-USD" }, order, notional), /about \$612/);
  const small = buy({ baseSize: "13" });
  assert.equal(pitchGuardViolation(guard, small, estimateNotionalUsd(small, equityPreviewEstimate(small, 36.3))), null);
});

test("futures use contract size, and a contract over the cap fails", () => {
  const order = { productId: "NOL-20OCT26-CDE", side: "BUY", type: "market", baseSize: "1" };
  const notional = estimateNotionalUsd(order, { order_total: "50" }, { price: 102.5, contractSize: 10 });
  assert.ok(notional > 1000);
  assert.ok(pitchGuardViolation({ maxUsd: 500, productId: "NOL-20OCT26-CDE" }, order, notional));
  assert.equal(estimateNotionalUsd(order, {}, { price: 102.5 }), null); // unknown contract size
});

test("spot crypto uses the preview's order total", () => {
  const order = { productId: "BTC-USD", side: "BUY", type: "market", baseSize: "0.001" };
  assert.equal(estimateNotionalUsd(order, { order_total: "75.9" }), 75.9);
  const q = { productId: "BTC-USD", side: "BUY", type: "market", quoteSize: "8" };
  assert.equal(estimateNotionalUsd(q, { order_total: "8.07" }), 8.07);
});

test("sells, other products, and unsizable orders are refused", () => {
  assert.match(pitchGuardViolation(guard, buy({ side: "SELL", baseSize: "1" }), 36), /Only buys/);
  assert.match(pitchGuardViolation(guard, buy({ productId: "TSLA-USD", quoteSize: "10" }), 10), /only trade NKE-USD/);
  assert.match(pitchGuardViolation(guard, buy({ baseSize: "1" }), null), /Couldn't size/);
  assert.equal(pitchGuardViolation(null, buy({ quoteSize: "10000" }), 10000), null); // no guard = normal flow
});

test("equity preview estimate and error detection", () => {
  assert.equal(isEquityPreviewUnavailable(new Error("rpc error: API order preview is not available for equities products; pass a portfolio_id")), true);
  assert.equal(isEquityPreviewUnavailable(new Error("insufficient funds")), false);
  const est = equityPreviewEstimate(buy({ quoteSize: "10" }), 36.3);
  assert.equal(est.estimated, true);
  assert.equal(est.base_size, "0.27548");
  assert.equal(est.order_total, "10");
  assert.throws(() => equityPreviewEstimate(buy({ baseSize: "1" }), null), /no live price/);
});

test("limit orders are estimated at their limit price", () => {
  const est = equityPreviewEstimate({ productId: "NKE-USD", side: "BUY", type: "limit", baseSize: "2", limitPrice: "35" }, 36.3);
  assert.equal(est.est_average_filled_price, "35");
  assert.equal(est.order_total, "70");
});
