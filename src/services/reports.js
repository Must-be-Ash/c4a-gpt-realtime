import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const POSITIVE = /\b(upgrade|launch|growth|adoption|approval|approved|partnership|record|surge|gain|bull|expand|secured)\b/i;
const NEGATIVE = /\b(hack|exploit|outage|lawsuit|seized|ban|delay|decline|drop|bear|risk|investigation|rejected)\b/i;

export function inferDirection(text) {
  const positive = (String(text).match(new RegExp(POSITIVE.source, "gi")) ?? []).length;
  const negative = (String(text).match(new RegExp(NEGATIVE.source, "gi")) ?? []).length;
  return positive > negative ? "bullish" : negative > positive ? "bearish" : "neutral";
}

const signed = (value) => `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(1)}%`;
const compact = (value) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export function buildReport(research) {
  const newsOnly = research.mode === "news";
  const volume = research.volumeComparison;
  const news = research.news.map((item) => ({
    ...item,
    direction: item.direction ?? inferDirection(`${item.title} ${item.excerpt}`),
    summary: item.summary ?? "Two-sentence summary unavailable for this source.",
  }));
  const volumeText = volume?.percentChange == null
    ? "Volume comparison is unavailable"
    : `30-day volume is ${Math.abs(volume.percentChange).toFixed(1)}% ${volume.direction} than the prior 30 days`;
  const priceText = research.market
    ? `Spot is ${signed(research.market.change24hPercent)} over 24 hours`
    : "Spot data is unavailable";

  return {
    id: randomUUID(),
    generatedAt: research.generatedAt,
    mode: newsOnly ? "news" : "research",
    asset: research.asset,
    summary: newsOnly
      ? `News matching: ${research.focusQuery}.`
      : `${volumeText}. ${priceText}.`,
    market: research.market,
    volume,
    news,
    warnings: research.warnings,
  };
}

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

export function renderReportHtml(report) {
  const metrics = report.mode === "news" ? "" : `
  <section class="metrics"><div class="metric"><span class="eyebrow">SPOT</span><strong>$${escapeHtml(report.market?.price ?? "—")}</strong><span>${report.market ? signed(report.market.change24hPercent) : "unavailable"} / 24h</span></div><div class="metric"><span class="eyebrow">30D VOLUME VS PRIOR 30D</span><strong>${report.volume?.percentChange == null ? "—" : signed(report.volume.percentChange)}</strong><span>${report.volume ? `${compact(report.volume.latest30)} ${escapeHtml(report.asset.symbol)}` : "unavailable"}</span></div></section>`;
  const newsCards = report.news.map((item) => `
    <article class="card"><div class="eyebrow">${escapeHtml(item.source)} <span class="tag ${item.direction}">${item.direction}</span></div>
    <h3><a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a></h3><p>${escapeHtml(item.summary)}</p></article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.asset.productId)} research</title><style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui;background:#0b0b0b;color:#f2f2f2}body{max-width:1040px;margin:auto;padding:48px 24px}a{color:inherit}.eyebrow{font-size:12px;color:#999}.hero{padding:24px 0;border-bottom:1px solid #303030}.hero h1{font-size:56px;line-height:1;margin:10px 0}.tag{border:1px solid currentColor;border-radius:99px;padding:4px 8px}.bullish{color:#74e2aa}.bearish{color:#ff8b7f}.neutral{color:#e2c874}.metrics,.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:20px 0}.metric,.card{background:#111;border:1px solid #303030;border-radius:8px;padding:16px}.metric strong{display:block;font-size:24px;margin-top:8px}.card h3{font-size:17px;margin:12px 0}.card p{color:#bbb;line-height:1.5}.section{margin-top:36px}h2{font-size:13px;color:#999}@media(max-width:720px){body{padding:28px 16px}.hero h1{font-size:42px}.metrics,.grid{grid-template-columns:1fr}}</style></head><body>
  <header class="hero"><div class="eyebrow">${escapeHtml(new Date(report.generatedAt).toLocaleString())}</div><h1>${escapeHtml(report.asset.productId)}</h1><p>${escapeHtml(report.summary)}</p></header>
  ${metrics}
  <section class="section"><h2>News and relevant factors</h2><div class="grid">${newsCards || '<article class="card"><p>No news results available.</p></article>'}</div></section></body></html>`;
}

export async function saveReport(report, directory) {
  await mkdir(directory, { recursive: true });
  const filename = `${report.asset.symbol.toLowerCase()}-${report.id}.html`;
  await writeFile(join(directory, filename), renderReportHtml(report), "utf8");
  return filename;
}
