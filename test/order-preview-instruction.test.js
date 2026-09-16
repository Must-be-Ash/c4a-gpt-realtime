import assert from "node:assert/strict";
import test from "node:test";

import { ESTIMATED_PREVIEW_INSTRUCTION, PREVIEW_INSTRUCTION, previewInstruction } from "../src/shared/order-preview.js";

test("estimated stock previews tell the agent it's an estimate and that confirming places the order", () => {
  assert.equal(previewInstruction({ preview: { estimated: true } }), ESTIMATED_PREVIEW_INSTRUCTION);
  assert.match(ESTIMATED_PREVIEW_INSTRUCTION, /no order preview for stocks/);
  assert.match(ESTIMATED_PREVIEW_INSTRUCTION, /places the real Coinbase order/);
  assert.equal(previewInstruction({ preview: { order_total: "8" } }), PREVIEW_INSTRUCTION);
});
