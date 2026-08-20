import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPaidFailure,
  createPaidAttemptTracker,
} from "../public/paid-recovery.js";

test("blocks only an identical paid request while allowing corrected arguments or another provider", () => {
  const tracker = createPaidAttemptTracker();
  const base = {
    intent: "search professional people by developer relations title",
    toolName: "fetch",
    argumentsValue: { url: "https://one.example/search", method: "POST", body: { title: "DevRel" } },
  };

  assert.equal(tracker.register(base).duplicate, false);
  assert.equal(tracker.register({
    ...base,
    argumentsValue: { method: "POST", body: { title: "DevRel" }, url: "https://one.example/search" },
  }).duplicate, true);
  assert.equal(tracker.register({
    ...base,
    argumentsValue: { ...base.argumentsValue, body: { headline: "Developer Relations" } },
  }).duplicate, false);
  const alternative = tracker.register({
    ...base,
    argumentsValue: { ...base.argumentsValue, url: "https://two.example/people" },
  });
  assert.equal(alternative.duplicate, false);
  assert.equal(alternative.attemptCount, 3);
  assert.equal(alternative.distinctEndpointCount, 2);
});

test("classifies invalid requests, empty results, and provider failures for semantic recovery", () => {
  assert.equal(classifyPaidFailure({
    failure: "Unprocessable Entity",
    data: { statusCode: 422, providerError: { validationErrors: [{ field: "skill" }] } },
  }), "invalid_request");
  assert.equal(classifyPaidFailure({ empty: true, data: [] }), "empty_result");
  assert.equal(classifyPaidFailure({
    failure: "Not enough credits",
    data: { statusCode: 403, providerError: { error: "Not enough credits" } },
  }), "provider_failure");
});
