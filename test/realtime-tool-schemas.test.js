import assert from "node:assert/strict";
import test from "node:test";

import { tool } from "@openai/agents/realtime";
import { x402RouterParameters } from "../src/services/realtime-tool-schemas.js";

test("the dynamic x402 router can be registered as a non-strict Realtime tool", () => {
  assert.doesNotThrow(() => tool({
    name: "use_x402",
    description: "Route one x402 call.",
    parameters: x402RouterParameters,
    strict: false,
    execute: async () => "{}",
  }));
  assert.deepEqual(x402RouterParameters.required, ["toolName", "arguments", "intent"]);
});
