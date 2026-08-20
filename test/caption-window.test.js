import test from "node:test";
import assert from "node:assert/strict";

import { captionWindow } from "../public/caption-window.js";

test("keeps only the newest words in a one-line caption window", () => {
  assert.equal(
    captionWindow("This is a long response that should not cover the report while the model continues speaking", { maxWords: 8 }),
    "cover the report while the model continues speaking",
  );
});

test("normalizes streamed whitespace and bounds the visible characters", () => {
  const caption = captionWindow("Hello   there\nthis is streaming in real time", { maxWords: 20, maxChars: 24 });
  assert.equal(caption.includes("\n"), false);
  assert.equal(caption.length <= 24, true);
  assert.equal(caption.endsWith("streaming in real time"), true);
});

test("returns short captions unchanged", () => {
  assert.equal(captionWindow("Added the chart."), "Added the chart.");
});
