import test from "node:test";
import assert from "node:assert/strict";

import { PreviewStore } from "../src/services/preview-store.js";

test("PreviewStore consumes an approved preview exactly once", () => {
  let now = 1_000;
  const store = new PreviewStore({ now: () => now, ttlMs: 60_000 });
  const preview = store.create({
    productId: "HYPE-USD",
    side: "BUY",
    type: "market",
    quoteSize: "10",
  });

  assert.deepEqual(store.consume(preview.id).order, {
    productId: "HYPE-USD",
    side: "BUY",
    type: "market",
    quoteSize: "10",
  });
  assert.throws(() => store.consume(preview.id), /already executed/i);
});

test("PreviewStore rejects expired previews", () => {
  let now = 1_000;
  const store = new PreviewStore({ now: () => now, ttlMs: 60_000 });
  const preview = store.create({ productId: "BTC-USD", side: "BUY" });

  now += 60_001;
  assert.throws(() => store.consume(preview.id), /expired/i);
});

test("creating a new preview invalidates the old pending preview", () => {
  const store = new PreviewStore();
  const first = store.create({ productId: "HYPE-USD", side: "BUY" });
  const second = store.create({ productId: "HYPE-USD", side: "SELL" });

  assert.throws(() => store.consume(first.id), /superseded/i);
  assert.equal(store.consume(second.id).order.side, "SELL");
});

test("execution can be claimed, released after failure, and completed", () => {
  const store = new PreviewStore();
  const item = store.create({ productId: "HYPE-USD" });

  assert.equal(store.claim(item.id).status, "executing");
  assert.throws(() => store.claim(item.id), /already executing/i);
  store.release(item.id);
  assert.equal(store.claim(item.id).status, "executing");
  store.complete(item.id, { orderId: "order-1" });
  assert.equal(store.get(item.id).status, "executed");
  assert.throws(() => store.claim(item.id), /already executed/i);
});
