// Artifact spec for a pitch call's brief (rendered by populateGenericArtifact).
// Pure so it can be unit-tested without a DOM.

const signed = (value) => (value == null ? "–" : `${value > 0 ? "+" : ""}${value}%`);
const tone = (value) => (value == null ? "neutral" : value >= 0 ? "positive" : "negative");
const httpOnly = (url) => /^https?:\/\//i.test(String(url ?? ""));

export function pitchBriefSpec({ facts = {}, asset, symbol } = {}) {
  const s = facts.suggested ?? {};
  const blocks = [
    {
      type: "metrics",
      title: null,
      items: [
        { label: "Price", value: `$${facts.price}`, detail: facts.proxyOf ? `stand-in for ${facts.underlyingName}` : null, tone: "neutral" },
        { label: "Target", value: `$${facts.target}`, detail: signed(facts.upsidePct), tone: "positive" },
        { label: "Stop", value: `$${facts.stop}`, detail: signed(facts.downsidePct), tone: "negative" },
        { label: "Reward / risk", value: `${facts.rewardRisk} : 1`, detail: `conviction ${facts.conviction}/10`, tone: "neutral" },
      ],
    },
  ];
  if (facts.trend) {
    blocks.push({
      type: "metrics",
      title: "Trend",
      items: [
        { label: "30 days", value: signed(facts.trend.change30dPct), detail: null, tone: tone(facts.trend.change30dPct) },
        { label: "90 days", value: signed(facts.trend.change90dPct), detail: null, tone: tone(facts.trend.change90dPct) },
        { label: "Off 90d high", value: signed(facts.trend.offHigh90dPct), detail: `high $${facts.trend.high90d}`, tone: "neutral" },
      ],
    });
  }
  blocks.push({
    type: "key_value",
    title: "The pitch",
    items: [
      { label: "Idea", value: String(facts.thesis?.title ?? "") },
      { label: "Desk trader", value: String(facts.trader?.name ?? "") },
      { label: "Suggested", value: s.usd ? `${s.units ? `${s.units} ${s.unitLabel} · ` : ""}$${s.usd}` : "fund the account first" },
      { label: "Buying power", value: `${facts.buyingPower?.currency ?? "USD"} ${facts.buyingPower?.amount ?? 0}` },
      { label: "Product", value: String(facts.productId ?? "") },
    ].filter((item) => item.value),
  });
  const links = (facts.sources ?? [])
    .filter((x) => httpOnly(x.url))
    .slice(0, 6)
    .map((x) => ({ label: String(x.title ?? x.source ?? x.url).slice(0, 160), url: x.url, detail: x.fact ? String(x.fact).slice(0, 240) : (x.source ?? null) }));
  if (links.length) blocks.push({ type: "links", title: "Sources", items: links });
  return {
    title: `Jordan's pitch · ${asset || symbol || facts.symbol || ""}`.trim(),
    subtitle: facts.thesis?.summary ?? null,
    source: `Desk thesis + Exa news (${facts.newsVerdict ?? "checked"}) + live prices`,
    blocks,
  };
}

export function describePitchState(state) {
  if (!state?.enabled) return "Pitch calls off";
  if (state.paused) return "Calls paused";
  const parts = [`${state.callsToday}/${state.maxCallsPerDay} calls today`];
  if (state.dryRun) parts.push("dry run");
  const last = state.recent?.[0];
  if (last) parts.push(`last: ${last.asset || last.symbol} · ${last.status.replace("_", " ")}`);
  return parts.join(" · ");
}

export function describeRunResult(result) {
  if (!result) return "No response";
  if (result.error && !result.action) return result.error;
  switch (result.action) {
    case "called": return `Calling you about ${result.asset || result.symbol}…`;
    case "dry_run": return `Dry run: would pitch ${result.asset || result.symbol}`;
    case "failed": return `Call failed: ${result.error}`;
    default: {
      const reasons = (result.reasons ?? []).map((r) => r.replaceAll("_", " "));
      const skipped = (result.skips ?? []).slice(0, 3).map((x) => `${x.symbol}: ${x.reasons.join(", ").replaceAll("_", " ")}`);
      return `Nothing worth a call: ${[...reasons, ...skipped].join(" · ") || "no ideas"}`;
    }
  }
}
