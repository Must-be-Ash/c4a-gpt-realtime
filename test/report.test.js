import assert from "node:assert/strict";
import test from "node:test";

import { buildReport, renderReportHtml } from "../src/services/reports.js";

const research = {
  asset: { symbol: "HYPE", productId: "HYPE-USD" },
  generatedAt: "2026-08-17T12:00:00.000Z",
  market: { price: 50, change24hPercent: 4.2, volume24h: 9000, status: "online" },
  volumeComparison: { latest30: 120, previous30: 100, percentChange: 20, direction: "higher", sampleDays: 60 },
  news: [{ title: "Protocol launches major upgrade", url: "https://example.com/a", source: "example.com", excerpt: "Strong adoption and growth", publishedDate: null }],
  polymarket: [{ event: "HYPE", question: "Will HYPE exceed $60?", outcomes: [{ label: "Yes", probability: 0.62 }], volume: 1000 }],
  warnings: [],
};

test("builds a compact signal report with directional tags", () => {
  const report = buildReport(research);
  assert.equal(report.asset.symbol, "HYPE");
  assert.equal(report.news[0].direction, "bullish");
  assert.match(report.summary, /volume/i);
  assert.doesNotMatch(report.summary, /signal mix/i);
  assert.equal("polymarket" in report, false);
});

test("escapes untrusted report text in standalone HTML", () => {
  const report = buildReport({
    ...research,
    news: [{ ...research.news[0], title: "<script>alert(1)</script>" }],
  });
  const html = renderReportHtml(report);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /Polymarket/i);
});

test("news-only reports omit unavailable Coinbase metrics", () => {
  const report = buildReport({
    ...research,
    mode: "news",
    focusQuery: "Trump crypto executives CLARITY Act",
    market: null,
    volumeComparison: null,
  });
  const html = renderReportHtml(report);

  assert.equal(report.mode, "news");
  assert.match(report.summary, /Trump crypto executives CLARITY Act/);
  assert.doesNotMatch(html, /30D VOLUME/);
  assert.doesNotMatch(html, />SPOT</);
});
