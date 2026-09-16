import assert from "node:assert/strict";
import test from "node:test";

import { describePitchState, describeRunResult, pitchBriefSpec } from "../dashboard/pitch-brief.js";
import { artifactSpecSchema } from "../src/shared/artifact-schema.js";

const facts = {
  symbol: "WTI", productId: "USO-USD", proxyOf: "WTI", underlyingName: "crude oil",
  price: 156.85, stop: 152.87, target: 171.39, upsidePct: 9.3, downsidePct: -2.5, rewardRisk: 3.6, conviction: 7,
  trend: { change30dPct: 21.2, change90dPct: 34.7, offHigh90dPct: -3.2, high90d: 105.83 },
  trader: { name: "Rig Margins" },
  suggested: { usd: 156.85, units: 1, unitLabel: "shares" },
  buyingPower: { currency: "USD", amount: 4000 },
  thesis: { title: "Hormuz tightens", summary: "Physical owns the tape." },
  sources: [{ title: "Hormuz transits fall", url: "https://portnews.ru/x", fact: "Transits fell to 4." }, { title: "bad", url: "javascript:alert(1)" }],
  newsVerdict: "supports",
};

test("brief spec is a valid artifact and drops non-http links", () => {
  const spec = pitchBriefSpec({ facts, asset: "crude oil via USO" });
  const parsed = artifactSpecSchema.safeParse(spec);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(spec.title, "Jordan's pitch · crude oil via USO");
  const links = spec.blocks.find((b) => b.type === "links");
  assert.deepEqual(links.items.map((l) => l.url), ["https://portnews.ru/x"]);
  assert.match(spec.blocks[0].items[0].detail, /stand-in for crude oil/);
});

test("brief spec handles a thin account and no trend", () => {
  const spec = pitchBriefSpec({ facts: { ...facts, trend: null, suggested: null, proxyOf: null, sources: [] }, symbol: "NKE" });
  assert.equal(artifactSpecSchema.safeParse(spec).success, true);
  assert.equal(spec.blocks.find((b) => b.type === "key_value").items.find((i) => i.label === "Suggested").value, "fund the account first");
  assert.equal(spec.blocks.some((b) => b.type === "links"), false);
});

test("state and run summaries read naturally", () => {
  assert.equal(describePitchState({ enabled: false }), "Pitch calls off");
  assert.equal(describePitchState({ enabled: true, paused: true }), "Calls paused");
  assert.equal(describePitchState({ enabled: true, callsToday: 1, maxCallsPerDay: 3, recent: [{ asset: "Nike", status: "no_answer" }] }), "1/3 calls today · last: Nike · no answer");
  assert.equal(describeRunResult({ action: "called", asset: "Nike" }), "Calling you about Nike…");
  assert.equal(describeRunResult({ action: "none", reasons: ["no_qualified_idea"], skips: [{ symbol: "WTI", reasons: ["news_contradicts"] }] }), "Nothing worth a call: no qualified idea · WTI: news contradicts");
  assert.equal(describeRunResult({ error: "Pitch calls are off" }), "Pitch calls are off");
});
