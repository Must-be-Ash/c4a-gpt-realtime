import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { artifactSpecSchema } from "../src/shared/artifact-schema.js";
import { x402RouterParameters } from "../src/services/realtime-tool-schemas.js";
import { captionWindow } from "./caption-window.js";
import { classifyPaidFailure, createPaidAttemptTracker } from "./paid-recovery.js";
import {
  buildSmartMoneyArtifact,
  buildToolResultArtifact,
  classifyX402Result,
  isEmptyToolResult,
  toolTitle,
  unwrapToolResult,
} from "./tool-result-artifact.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  voiceButton: $("#voiceButton"), voiceButtonText: $("#voiceButtonText"),
  status: $(".voice-state"), statusText: $("#statusText"), setupNote: $("#setupNote"),
  reportTemplate: $("#reportTemplate"), tradeTemplate: $("#tradeTemplate"), captions: $("#captions"),
  sessionControls: $("#sessionControls"), speakerButton: $("#speakerButton"), endButton: $("#endButton"),
  queueStatus: $("#queueStatus"), artifacts: $("#artifacts"), agentAudio: $("#agentAudio"),
  themeToggle: $("#themeToggle"), themeColor: $('meta[name="theme-color"]'),
};

let session = null;
let appConfig = null;
let pendingPreviewId = null;
let activeTradeEntry = null;
let runningTasks = 0;
let artifactNumber = 0;
let micHeld = false;
let speakerMuted = false;
let microphoneStream = null;
let liveCaptionRole = null;
let liveCaptionText = "";
let captionDismissTimer = null;
const paidAttemptTracker = createPaidAttemptTracker();

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  elements.themeToggle.setAttribute("aria-label", `Switch to ${nextTheme === "dark" ? "light" : "dark"} mode`);
  elements.themeToggle.title = `Switch to ${nextTheme === "dark" ? "light" : "dark"} mode`;
  elements.themeColor.content = nextTheme === "dark" ? "#080a0f" : "#f6f8fc";
}

applyTheme(document.documentElement.dataset.theme);
elements.themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  try { localStorage.setItem("coinbase-agents-theme", nextTheme); } catch { /* Theme still applies for this page. */ }
});

const cancelCaptionDismiss = () => {
  if (captionDismissTimer) window.clearTimeout(captionDismissTimer);
  captionDismissTimer = null;
};

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
};

const logVoiceTranscript = (role, text) => {
  const transcript = String(text ?? "").trim();
  if (!transcript) return;
  console.info(`[voice:${role}]`, transcript);
  fetch("/api/logs/voice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, text: transcript }),
    keepalive: true,
  }).catch(() => {});
};

const setStatus = (label, live = false) => {
  elements.statusText.textContent = label;
  elements.status.classList.toggle("live", live);
};
const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const compact = (value) => compactFormatter.format(value ?? 0);
const percent = (value) => value == null ? "—" : `${value >= 0 ? "+" : ""}${Number(value).toFixed(1)}%`;
const append = (parent, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  parent.append(node);
  return node;
};

function appendTimelineEntry(entry, { scroll = false } = {}) {
  artifactNumber += 1;
  entry.dataset.timelinePosition = String(artifactNumber);
  elements.artifacts.hidden = false;
  document.body.classList.add("has-report");
  elements.artifacts.append(entry);
  if (scroll) entry.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return artifactNumber;
}

function clearLiveCaption() {
  cancelCaptionDismiss();
  liveCaptionRole = null;
  liveCaptionText = "";
  elements.captions.replaceChildren();
  elements.captions.hidden = true;
  document.body.classList.remove("has-captions");
}

function scheduleCaptionDismiss(delayMs) {
  cancelCaptionDismiss();
  captionDismissTimer = window.setTimeout(clearLiveCaption, delayMs);
}

function renderLiveCaption() {
  const text = captionWindow(liveCaptionText);
  if (!liveCaptionRole || !text) return;
  elements.captions.replaceChildren();
  const caption = append(elements.captions, "div", `caption caption-${liveCaptionRole}`);
  append(caption, "span", "caption-label", liveCaptionRole === "user" ? "YOU" : "MODEL");
  append(caption, "strong", "caption-text", text);
  elements.captions.hidden = false;
  document.body.classList.add("has-captions");
}

function appendLiveCaption(role, delta) {
  if (!delta) return;
  cancelCaptionDismiss();
  if (liveCaptionRole !== role) {
    liveCaptionRole = role;
    liveCaptionText = "";
  }
  liveCaptionText += delta;
  renderLiveCaption();
}

function handleTransportEvent(event) {
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    if (micHeld) appendLiveCaption("user", event.delta);
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    logVoiceTranscript("user", event.transcript);
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.failed" && liveCaptionRole === "user") {
    clearLiveCaption();
    return;
  }
  if (event.type === "response.output_audio_transcript.delta") {
    appendLiveCaption("model", event.delta);
    return;
  }
  if (event.type === "response.output_audio_transcript.done") {
    logVoiceTranscript("model", event.transcript);
    return;
  }
  if (event.type === "output_audio_buffer.stopped") {
    scheduleCaptionDismiss(1_100);
    return;
  }
  if (event.type === "output_audio_buffer.cleared") {
    clearLiveCaption();
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const svgNode = (tag, attributes = {}, text = null) => {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  if (text != null) node.textContent = text;
  return node;
};

const chartFrame = (container, {
  width = 960,
  height = 360,
  margin = { top: 24, right: 22, bottom: 38, left: 64 },
} = {}) => {
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  container.replaceChildren(svg);
  return { svg, width, height, margin, innerWidth: width - margin.left - margin.right, innerHeight: height - margin.top - margin.bottom };
};

function renderCandles(container, payload) {
  const candles = payload.candles;
  if (!candles.length) throw new Error("Coinbase returned no candles for this product.");
  const frame = chartFrame(container);
  frame.svg.setAttribute("aria-label", `${payload.productId} candlestick chart`);
  const minPrice = Math.min(...candles.map((candle) => candle.low));
  const maxPrice = Math.max(...candles.map((candle) => candle.high));
  const priceRange = maxPrice - minPrice || 1;
  const x = (index) => frame.margin.left + ((index + 0.5) / candles.length) * frame.innerWidth;
  const y = (price) => frame.margin.top + ((maxPrice - price) / priceRange) * frame.innerHeight;

  for (let index = 0; index <= 4; index += 1) {
    const price = maxPrice - (priceRange * index) / 4;
    const yPosition = y(price);
    frame.svg.append(svgNode("line", { class: "grid", x1: frame.margin.left, x2: frame.width - frame.margin.right, y1: yPosition, y2: yPosition }));
    frame.svg.append(svgNode("text", { x: frame.margin.left - 9, y: yPosition + 3, "text-anchor": "end" }, price.toLocaleString(undefined, { maximumFractionDigits: 4 })));
  }

  const candleWidth = Math.max(2, Math.min(10, (frame.innerWidth / candles.length) * 0.62));
  candles.forEach((candle, index) => {
    const color = candle.close >= candle.open ? "#7ee2a8" : "#ff9186";
    const xPosition = x(index);
    frame.svg.append(svgNode("line", { x1: xPosition, x2: xPosition, y1: y(candle.high), y2: y(candle.low), stroke: color, "stroke-width": 1.2 }));
    const bodyTop = Math.min(y(candle.open), y(candle.close));
    const bodyHeight = Math.max(1.5, Math.abs(y(candle.open) - y(candle.close)));
    frame.svg.append(svgNode("rect", { x: xPosition - candleWidth / 2, y: bodyTop, width: candleWidth, height: bodyHeight, rx: 1, fill: color }));
  });

  const firstTime = new Date(candles[0].time * 1_000).toLocaleDateString([], { month: "short", day: "numeric" });
  const lastTime = new Date(candles.at(-1).time * 1_000).toLocaleDateString([], { month: "short", day: "numeric" });
  frame.svg.append(svgNode("text", { x: frame.margin.left, y: frame.height - 10 }, firstTime));
  frame.svg.append(svgNode("text", { x: frame.width - frame.margin.right, y: frame.height - 10, "text-anchor": "end" }, lastTime));

  const crosshair = svgNode("line", {
    class: "chart-crosshair",
    y1: frame.margin.top,
    y2: frame.height - frame.margin.bottom,
    visibility: "hidden",
  });
  const marker = svgNode("circle", { class: "chart-marker", r: 3.5, visibility: "hidden" });
  const tooltip = svgNode("g", { class: "chart-tooltip", visibility: "hidden" });
  tooltip.append(svgNode("rect", { width: 265, height: 49, rx: 6 }));
  const dateText = svgNode("text", { x: 10, y: 18, class: "chart-tooltip-date" });
  const ohlcText = svgNode("text", { x: 10, y: 37, class: "chart-tooltip-values" });
  tooltip.append(dateText, ohlcText);
  frame.svg.append(crosshair, marker, tooltip);
  frame.svg.setAttribute("tabindex", "0");

  let activeIndex = candles.length - 1;
  const showCandle = (index) => {
    activeIndex = Math.max(0, Math.min(candles.length - 1, index));
    const candle = candles[activeIndex];
    const xPosition = x(activeIndex);
    const tooltipX = Math.min(frame.width - frame.margin.right - 265, Math.max(frame.margin.left, xPosition + 12));
    crosshair.setAttribute("x1", xPosition);
    crosshair.setAttribute("x2", xPosition);
    crosshair.setAttribute("visibility", "visible");
    marker.setAttribute("cx", xPosition);
    marker.setAttribute("cy", y(candle.close));
    marker.setAttribute("visibility", "visible");
    tooltip.setAttribute("transform", `translate(${tooltipX} ${frame.margin.top + 8})`);
    tooltip.setAttribute("visibility", "visible");
    dateText.textContent = new Date(candle.time * 1_000).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const price = (value) => Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
    ohlcText.textContent = `O ${price(candle.open)}  H ${price(candle.high)}  L ${price(candle.low)}  C ${price(candle.close)}`;
  };
  const hideCandle = () => {
    crosshair.setAttribute("visibility", "hidden");
    marker.setAttribute("visibility", "hidden");
    tooltip.setAttribute("visibility", "hidden");
  };
  frame.svg.addEventListener("pointermove", (event) => {
    const bounds = frame.svg.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * frame.width;
    const index = Math.floor(((svgX - frame.margin.left) / frame.innerWidth) * candles.length);
    showCandle(index);
  });
  frame.svg.addEventListener("pointerleave", hideCandle);
  frame.svg.addEventListener("focus", () => showCandle(activeIndex));
  frame.svg.addEventListener("blur", hideCandle);
  frame.svg.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    showCandle(activeIndex + (event.key === "ArrowRight" ? 1 : -1));
  });
}

function renderDepth(container, payload) {
  if (!payload.bids.length || !payload.asks.length) throw new Error("Coinbase returned an empty order book.");
  const frame = chartFrame(container);
  frame.svg.setAttribute("aria-label", `${payload.productId} cumulative order book depth chart`);
  const bids = [...payload.bids].reverse();
  const asks = payload.asks;
  const prices = [...bids, ...asks].map((point) => point.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice || 1;
  const maxDepth = Math.max(...[...bids, ...asks].map((point) => point.cumulativeSize)) || 1;
  const x = (price) => frame.margin.left + ((price - minPrice) / priceRange) * frame.innerWidth;
  const y = (depth) => frame.margin.top + (1 - depth / maxDepth) * frame.innerHeight;
  const bottom = frame.height - frame.margin.bottom;

  for (let index = 0; index <= 4; index += 1) {
    const depth = (maxDepth * index) / 4;
    const yPosition = y(depth);
    frame.svg.append(svgNode("line", { class: "grid", x1: frame.margin.left, x2: frame.width - frame.margin.right, y1: yPosition, y2: yPosition }));
    frame.svg.append(svgNode("text", { x: frame.margin.left - 9, y: yPosition + 3, "text-anchor": "end" }, compact(depth)));
  }

  const drawSide = (points, color) => {
    const line = points.map((point, index) => `${index ? "L" : "M"}${x(point.price)},${y(point.cumulativeSize)}`).join(" ");
    const area = `${line} L${x(points.at(-1).price)},${bottom} L${x(points[0].price)},${bottom} Z`;
    frame.svg.append(svgNode("path", { d: area, fill: color, "fill-opacity": .15 }));
    frame.svg.append(svgNode("path", { d: line, fill: "none", stroke: color, "stroke-width": 2 }));
  };
  drawSide(bids, "#7ee2a8");
  drawSide(asks, "#ff9186");

  if (payload.midMarket != null) {
    const midX = x(payload.midMarket);
    frame.svg.append(svgNode("line", { x1: midX, x2: midX, y1: frame.margin.top, y2: bottom, stroke: "#aeb6b1", "stroke-dasharray": "4 5" }));
    frame.svg.append(svgNode("text", { x: midX, y: frame.margin.top - 8, "text-anchor": "middle" }, `$${payload.midMarket.toLocaleString()}`));
  }
  frame.svg.append(svgNode("text", { x: frame.margin.left, y: frame.height - 10, fill: "#7ee2a8" }, `Bids · $${minPrice.toLocaleString()}`));
  frame.svg.append(svgNode("text", { x: frame.width - frame.margin.right, y: frame.height - 10, "text-anchor": "end", fill: "#ff9186" }, `Asks · $${maxPrice.toLocaleString()}`));
}

function renderPolymarketArtifact(container, payload) {
  container.classList.add("polymarket-artifact");
  const cards = append(container, "div", "cards");
  payload.markets.forEach((item) => {
    const card = $("#polyCardTemplate").content.firstElementChild.cloneNode(true);
    card.querySelector(".question").textContent = item.question;
    item.outcomes.forEach((outcome) => append(
      card.querySelector(".outcomes"),
      "span",
      "outcome",
      `${outcome.label} ${outcome.probability == null ? "—" : `${Math.round(outcome.probability * 100)}%`}`,
    ));
    card.querySelector(".poly-volume").textContent = `${compact(item.volume)} volume`;
    cards.append(card);
  });
  if (!payload.markets.length) append(cards, "p", "muted", "No directly relevant active Polymarket markets found.");
}

function renderGenericChart(container, block) {
  const margin = { top: 42, right: 22, bottom: 50, left: 64 };
  const frame = chartFrame(container, { height: 300, margin });
  const { svg, width, height, innerWidth, innerHeight } = frame;
  svg.setAttribute("aria-label", block.title || `${block.chartType} chart`);

  const values = block.series.flatMap((series) => series.points.map((point) => point.value));
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (block.chartType === "bar") {
    minValue = Math.min(0, minValue);
    maxValue = Math.max(0, maxValue);
  }
  const range = maxValue - minValue || Math.abs(maxValue) || 1;
  const y = (value) => margin.top + ((maxValue - value) / range) * innerHeight;
  const longestSeries = Math.max(...block.series.map((series) => series.points.length));
  const x = (index) => margin.left + (longestSeries === 1 ? innerWidth / 2 : (index / (longestSeries - 1)) * innerWidth);

  for (let index = 0; index <= 4; index += 1) {
    const value = maxValue - (range * index) / 4;
    const yPosition = y(value);
    svg.append(svgNode("line", { class: "grid", x1: margin.left, x2: width - margin.right, y1: yPosition, y2: yPosition }));
    svg.append(svgNode("text", { x: margin.left - 9, y: yPosition + 3, "text-anchor": "end" }, compact(value)));
  }

  if (block.chartType === "line") {
    block.series.forEach((series) => {
      const path = series.points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.value)}`).join(" ");
      svg.append(svgNode("path", { class: `generic-series tone-${series.tone}`, d: path, fill: "none", "stroke-width": 2.5 }));
      series.points.forEach((point, index) => {
        const marker = svgNode("circle", { class: `generic-point tone-${series.tone}`, cx: x(index), cy: y(point.value), r: 3.5 });
        marker.append(svgNode("title", {}, `${point.label}: ${point.value.toLocaleString()}`));
        svg.append(marker);
      });
    });
  } else {
    const groupWidth = innerWidth / Math.max(1, longestSeries);
    const barWidth = Math.max(3, Math.min(42, (groupWidth * 0.72) / block.series.length));
    const zeroY = y(0);
    block.series.forEach((series, seriesIndex) => {
      series.points.forEach((point, pointIndex) => {
        const center = margin.left + groupWidth * (pointIndex + 0.5);
        const yPosition = y(point.value);
        const bar = svgNode("rect", {
          class: `generic-bar tone-${series.tone}`,
          x: center - (barWidth * block.series.length) / 2 + barWidth * seriesIndex,
          y: Math.min(zeroY, yPosition),
          width: Math.max(1, barWidth - 2),
          height: Math.max(1, Math.abs(zeroY - yPosition)),
          rx: 2,
        });
        bar.append(svgNode("title", {}, `${point.label}: ${point.value.toLocaleString()}`));
        svg.append(bar);
      });
    });
  }

  const labels = block.series.find((series) => series.points.length === longestSeries).points;
  const labelIndexes = [...new Set([0, Math.floor((labels.length - 1) / 2), labels.length - 1])];
  labelIndexes.forEach((index) => {
    const xPosition = block.chartType === "bar"
      ? margin.left + (innerWidth / Math.max(1, longestSeries)) * (index + 0.5)
      : x(index);
    svg.append(svgNode("text", { x: xPosition, y: height - 20, "text-anchor": "middle" }, labels[index].label));
  });

  const legend = svgNode("g", { class: "generic-legend" });
  block.series.forEach((series, index) => {
    const offset = margin.left + index * 170;
    legend.append(svgNode("circle", { class: `generic-point tone-${series.tone}`, cx: offset, cy: 17, r: 4 }));
    legend.append(svgNode("text", { x: offset + 10, y: 20 }, series.name));
  });
  svg.append(legend);
  if (block.xLabel) svg.append(svgNode("text", { class: "axis-label", x: width / 2, y: height - 4, "text-anchor": "middle" }, block.xLabel));
  if (block.yLabel) svg.append(svgNode("text", { class: "axis-label", x: 13, y: height / 2, transform: `rotate(-90 13 ${height / 2})`, "text-anchor": "middle" }, block.yLabel));
}

function renderGenericBlock(parent, block) {
  const section = append(parent, "section", `generic-block generic-${block.type}`);
  if (block.title) append(section, "h3", null, block.title);

  if (block.type === "metrics") {
    const grid = append(section, "div", "generic-metrics");
    block.items.forEach((item) => {
      const metric = append(grid, "div", "generic-metric");
      metric.dataset.tone = item.tone;
      append(metric, "span", "generic-label", item.label);
      append(metric, "strong", null, item.value);
      if (item.detail) append(metric, "span", "generic-detail", item.detail);
    });
    return;
  }

  if (block.type === "table") {
    const wrap = append(section, "div", "generic-table-wrap");
    const table = append(wrap, "table", "generic-table");
    const head = append(table, "thead");
    const headRow = append(head, "tr");
    block.columns.forEach((column) => append(headRow, "th", null, column));
    const body = append(table, "tbody");
    block.rows.forEach((row) => {
      const tableRow = append(body, "tr");
      block.columns.forEach((column, index) => {
        const cell = append(tableRow, "td", null, row[index] ?? "—");
        cell.dataset.label = column;
      });
    });
    return;
  }

  if (block.type === "list") {
    const list = append(section, "div", "generic-list");
    block.items.forEach((item) => {
      const row = append(list, "div", "generic-list-item");
      row.dataset.tone = item.tone;
      const copy = append(row, "div", "generic-list-copy");
      append(copy, "strong", null, item.title);
      if (item.detail) append(copy, "span", null, item.detail);
      if (item.tag) append(row, "span", "generic-tag", item.tag);
    });
    return;
  }

  if (block.type === "cards") {
    const cards = append(section, "div", "generic-card-grid");
    block.items.forEach((item) => {
      const card = append(cards, "article", "generic-card");
      const avatar = append(card, "div", "generic-card-avatar");
      if (item.imageUrl) {
        const image = append(avatar, "img");
        image.src = item.imageUrl;
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => image.remove(), { once: true });
      } else {
        append(avatar, "span", null, item.title.trim().charAt(0).toUpperCase());
      }
      const content = append(card, "div", "generic-card-content");
      append(content, "strong", null, item.title);
      if (item.subtitle) append(content, "span", "generic-card-subtitle", item.subtitle);
      if (item.detail) append(content, "p", null, item.detail);
      if (item.links.length) {
        const links = append(content, "div", "generic-card-links");
        item.links.forEach((itemLink) => {
          const link = append(links, "a", null, itemLink.label);
          link.href = itemLink.url;
          if (!itemLink.url.startsWith("mailto:")) {
            link.target = "_blank";
            link.rel = "noreferrer";
          }
        });
      }
    });
    return;
  }

  if (block.type === "key_value") {
    const grid = append(section, "dl", "generic-key-values");
    block.items.forEach((item) => {
      const pair = append(grid, "div", "generic-key-value");
      append(pair, "dt", null, item.label);
      append(pair, "dd", null, item.value);
    });
    return;
  }

  if (block.type === "text") {
    const callout = append(section, "p", "generic-callout", block.body);
    callout.dataset.tone = block.tone;
    return;
  }

  if (block.type === "links") {
    const links = append(section, "div", "generic-links");
    block.items.forEach((item) => {
      const link = append(links, "a", "generic-link");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      append(link, "strong", null, item.label);
      if (item.detail) append(link, "span", null, item.detail);
      append(link, "span", "generic-link-arrow", "↗");
    });
    return;
  }

  const chart = append(section, "div", "generic-chart-canvas chart");
  renderGenericChart(chart, block);
}

function populateGenericArtifact(artifact, spec, { variant = null, timestamp = new Date() } = {}) {
  artifact.replaceChildren();
  artifact.className = ["artifact", "generic-artifact", variant ? `${variant}-artifact` : null]
    .filter(Boolean)
    .join(" ");
  const header = append(artifact, "header", "artifact-header");
  append(header, "h2", null, spec.title);
  const state = append(header, "span", "artifact-state done", "ready");
  state.setAttribute("aria-label", "Artifact ready");
  const body = append(artifact, "div", "generic-artifact-body");
  if (spec.subtitle) append(body, "p", "generic-subtitle", spec.subtitle);
  spec.blocks.forEach((block) => renderGenericBlock(body, block));
  const footer = append(artifact, "footer", "artifact-footer");
  append(footer, "span", null, spec.source || "Live tool result");
  append(footer, "span", null, timestamp.toLocaleString());
}

function renderGenericArtifact(spec, { variant = null } = {}) {
  const artifact = document.createElement("article");
  populateGenericArtifact(artifact, spec, { variant });
  const position = appendTimelineEntry(artifact, { scroll: true });
  return { id: crypto.randomUUID(), position, title: spec.title };
}

function displayToolResult({ title, source, result, spec, variant }) {
  const data = unwrapToolResult(result);
  const artifact = renderGenericArtifact(
    spec || buildToolResultArtifact({ title, source, result: data }),
    { variant },
  );
  return JSON.stringify({
    data,
    display: { displayed: true, ...artifact },
    instruction: "The completed tool result is visible. State only the most important conclusion in one short sentence.",
  });
}

function updateQueueStatus() {
  elements.queueStatus.hidden = runningTasks === 0;
  elements.queueStatus.textContent = runningTasks === 1 ? "1 artifact running" : `${runningTasks} artifacts running`;
}

function queueArtifact({
  title,
  productId,
  endpoint,
  renderer,
  loadingLabel = "fetching Coinbase…",
  sourceLabel = "Coinbase live market data",
}) {
  runningTasks += 1;
  updateQueueStatus();

  const artifact = document.createElement("article");
  artifact.className = "artifact";
  const header = append(artifact, "header", "artifact-header");
  append(header, "h2", null, title);
  const state = append(header, "span", "artifact-state", loadingLabel);
  const chart = append(artifact, "div", "chart");
  const footer = append(artifact, "footer", "artifact-footer");
  const source = append(footer, "span", null, sourceLabel);
  const timestamp = append(footer, "span", null, "queued");
  const id = crypto.randomUUID();
  const position = appendTimelineEntry(artifact);

  requestJson(endpoint, { method: "POST", body: JSON.stringify({ productId }) })
    .then((payload) => {
      renderer(chart, payload);
      state.textContent = "ready";
      state.classList.add("done");
      if (payload.spreadBps != null) source.textContent = `Coinbase live market data · ${payload.spreadBps.toFixed(2)} bps spread`;
      timestamp.textContent = new Date(payload.generatedAt).toLocaleString();
    })
    .catch((error) => {
      chart.replaceChildren();
      append(chart, "p", "artifact-error", error.message);
      state.textContent = "failed";
      state.classList.add("error");
    })
    .finally(() => {
      runningTasks -= 1;
      updateQueueStatus();
    });

  return { id, position, title };
}

function queueGenericArtifact({
  title,
  endpoint,
  body = {},
  loadingLabel = "fetching live data…",
  variant = "insight",
}) {
  runningTasks += 1;
  updateQueueStatus();

  const artifact = document.createElement("article");
  artifact.className = "artifact";
  const header = append(artifact, "header", "artifact-header");
  append(header, "h2", null, title);
  const state = append(header, "span", "artifact-state", loadingLabel);
  const placeholder = append(artifact, "div", "generic-artifact-body");
  append(placeholder, "p", "generic-subtitle", "Loading current data…");
  const id = crypto.randomUUID();
  const position = appendTimelineEntry(artifact);

  requestJson(endpoint, { method: "POST", body: JSON.stringify(body) })
    .then((payload) => {
      const spec = artifactSpecSchema.parse(payload.spec ?? payload);
      populateGenericArtifact(artifact, spec, {
        variant,
        timestamp: payload.generatedAt ? new Date(payload.generatedAt) : new Date(),
      });
    })
    .catch((error) => {
      placeholder.replaceChildren();
      append(placeholder, "p", "artifact-error", error.message);
      state.textContent = "failed";
      state.classList.add("error");
    })
    .finally(() => {
      runningTasks -= 1;
      updateQueueStatus();
    });

  return { id, position, title };
}

function renderReport(report, reportUrl) {
  const entry = elements.reportTemplate.content.firstElementChild.cloneNode(true);
  const reportTime = entry.querySelector(".report-time");
  const reportAsset = entry.querySelector(".report-asset");
  const toolTrace = entry.querySelector(".tool-trace");
  const reportSummary = entry.querySelector(".report-summary");
  const metrics = entry.querySelector(".metrics");
  const news = entry.querySelector(".news");
  const warnings = entry.querySelector(".warnings");
  const standaloneLink = entry.querySelector(".standalone-link");
  const newsOnly = report.mode === "news";
  reportTime.textContent = new Date(report.generatedAt).toLocaleString();
  reportAsset.textContent = report.asset.productId;
  reportSummary.textContent = report.summary;
  toolTrace.textContent = [
    report.market && "Coinbase spot",
    report.volume && `Coinbase ${report.volume.sampleDays} daily candles`,
    `Exa ${report.news.length} results`,
  ].filter(Boolean).join("  ·  ");
  standaloneLink.href = reportUrl;

  metrics.hidden = newsOnly;
  const metric = (label, value, detail) => {
    const node = append(metrics, "div", "metric");
    append(node, "span", null, label); append(node, "strong", null, value); append(node, "span", null, detail);
  };
  if (!newsOnly) {
    metric("Spot price", report.market ? `$${Number(report.market.price).toLocaleString()}` : "—", report.market ? `${percent(report.market.change24hPercent)} in 24h` : "unavailable");
    metric("30-day volume change", percent(report.volume?.percentChange), "compared with prior 30 days");
    metric("30-day volume", report.volume ? `${compact(report.volume.latest30)} ${report.asset.symbol}` : "—", `${report.volume?.sampleDays ?? 0} daily candles`);
  }

  report.news.slice(0, 6).forEach((item) => {
    const card = $("#newsCardTemplate").content.firstElementChild.cloneNode(true);
    card.querySelector(".source").textContent = item.source;
    const direction = card.querySelector(".direction"); direction.textContent = item.direction; direction.classList.add(item.direction);
    const headline = card.querySelector(".headline"); headline.textContent = item.title; headline.href = item.url;
    card.querySelector(".summary").textContent = item.summary || "No excerpt returned.";
    news.append(card);
  });
  if (!report.news.length) append(news, "p", "muted", "No news results returned.");

  warnings.textContent = report.warnings.length ? `Partial data: ${report.warnings.join(" · ")}` : "";
  appendTimelineEntry(entry, { scroll: true });
}

function renderPreview(payload) {
  pendingPreviewId = payload.previewId;
  const panel = elements.tradeTemplate.content.firstElementChild.cloneNode(true);
  const tradeTitle = panel.querySelector(".trade-title");
  const tradeDetails = panel.querySelector(".trade-details");
  const tradeStatus = panel.querySelector(".trade-status");
  const order = payload.order;
  const quoteCurrency = order.productId.split("-").at(-1);
  const isFutures = order.productId.endsWith("-CDE");
  const amount = payload.requestedQuoteSize != null
    ? `${payload.requestedQuoteSize} ${quoteCurrency}`
    : order.quoteSize != null
      ? `${order.quoteSize} ${quoteCurrency}`
      : isFutures
        ? `${order.baseSize} contracts`
        : `${order.baseSize} ${order.productId.split("-")[0]}`;
  const type = order.type === "stop_limit" ? "STOP LIMIT" : order.type.toUpperCase();
  tradeTitle.textContent = `${order.side} ${amount} of ${order.productId} · ${type}`;
  const estimate = payload.preview.est_average_filled_price || payload.preview.average_filled_price;
  const fee = payload.preview.commission_total;
  const liquidationPrice = payload.preview.predicted_liquidation_price;
  tradeDetails.textContent = [
    order.limitPrice && `limit $${order.limitPrice}`,
    order.stopPrice && `stop $${order.stopPrice} ${order.stopDirection}`,
    order.equityTradingSession && `session ${order.equityTradingSession.replaceAll("_", " ").toLowerCase()}`,
    estimate && `estimated fill $${estimate}`,
    fee && `fee $${fee}`,
    liquidationPrice && `estimated liquidation $${liquidationPrice}`,
    `expires ${new Date(payload.expiresAt).toLocaleTimeString()}`,
  ].filter(Boolean).join(" · ");
  activeTradeEntry = { panel, status: tradeStatus };
  appendTimelineEntry(panel, { scroll: true });
}

function renderExecution(payload) {
  const orderId = payload.result.order_id || payload.result.client_order_id || "submitted";
  if (activeTradeEntry) {
    activeTradeEntry.status.textContent = `Executed · ${orderId}`;
    activeTradeEntry.status.classList.add("executed");
  }
  pendingPreviewId = null;
}

const productIdSchema = z.string()
  .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/)
  .max(64)
  .describe("Exact Coinbase product ID discovered with coinbase_products_list or coinbase_products_get, for example AAPL-USD, BTC-USDC, or BIT-28AUG26-CDE");
const cryptoProductIdSchema = z.string()
  .regex(/^[A-Z0-9]{2,15}-(?:USD|USDC)$/)
  .refine((productId) => !productId.endsWith("-CDE"), "Use a spot crypto product ID, not an equity or futures product")
  .describe("Coinbase spot crypto product ID such as BTC-USD or SOL-USDC; equities and futures are not supported by this crypto-specific tool");
const newsFocusSchema = z.string().min(3).max(500)
  .describe("Focused news query. Preserve every user-provided entity, name, date, and topic instead of reducing it to only the asset symbol.");
const newsTimeframeSchema = z.enum(["today", "yesterday", "today_and_yesterday", "last_7_days", "last_30_days"])
  .describe("Publication window requested by the user.");
const newsRequestBody = ({ productId, focusQuery, timeframe }) => ({
  productId,
  focusQuery,
  timeframe,
  timezoneOffsetMinutes: new Date().getTimezoneOffset(),
});

const researchTool = tool({
  name: "research_crypto",
  description: "Combined Coinbase market/volume and Exa news research. Use only when the user asks for both market context and news. Preserve every user-provided entity, name, date, and topic in focusQuery. For a news-only request, do not call research_crypto; call search_crypto_news.",
  parameters: z.object({ productId: cryptoProductIdSchema, focusQuery: newsFocusSchema, timeframe: newsTimeframeSchema }),
  execute: async ({ productId, focusQuery, timeframe }) => {
    setStatus("researching", true);
    try {
      const payload = await requestJson("/api/research", { method: "POST", body: JSON.stringify(newsRequestBody({ productId, focusQuery, timeframe })) });
      renderReport(payload.report, payload.reportUrl);
      return JSON.stringify({ report: payload.report, instruction: "The report is visible. Give a short spoken summary grounded only in these returned values and sources." });
    } finally {
      setStatus(micHeld ? "listening" : "ready", true);
    }
  },
});

const cryptoNewsTool = tool({
  name: "search_crypto_news",
  description: "Focused news-only Exa search that does not fetch Coinbase market data. Crypto news must use search_crypto_news instead of the paid-data router. Preserve every user-provided entity, name, date, and topic in focusQuery. Use this whenever the user asks only for news, an event, a claim, or why something happened; do not call research_crypto unless they also request market or volume data.",
  parameters: z.object({ productId: cryptoProductIdSchema, focusQuery: newsFocusSchema, timeframe: newsTimeframeSchema }),
  execute: async ({ productId, focusQuery, timeframe }) => {
    setStatus("researching", true);
    try {
      const payload = await requestJson("/api/news", { method: "POST", body: JSON.stringify(newsRequestBody({ productId, focusQuery, timeframe })) });
      renderReport(payload.report, payload.reportUrl);
      return JSON.stringify({ report: payload.report, instruction: "The focused news report is visible. Give a short spoken summary grounded only in these returned sources." });
    } finally {
      setStatus(micHeld ? "listening" : "ready", true);
    }
  },
});

const polymarketTool = tool({
  name: "show_polymarket",
  description: "Polymarket-only lookup for a crypto asset. Use this when the user asks specifically for Polymarket markets, probabilities, odds, or sentiment. It calls the live Polymarket API and shows only those results; do not call or fetch research_crypto unless the user also asks for news, volume, or broader research.",
  parameters: z.object({ productId: cryptoProductIdSchema }),
  execute: async ({ productId }) => JSON.stringify({
    queued: true,
    ...queueArtifact({
      title: `${productId} · Polymarket`,
      productId,
      endpoint: "/api/artifacts/polymarket",
      renderer: renderPolymarketArtifact,
      loadingLabel: "fetching Polymarket…",
      sourceLabel: "Polymarket live markets",
    }),
    instruction: `Say only: "Added the current Polymarket markets for ${productId}."`,
  }),
});

const candleChartTool = tool({
  name: "show_candle_chart",
  description: "Add an interactive Coinbase candlestick chart for any USD crypto product using the latest 30 daily OHLCV candles. Hover or use arrow keys for exact values.",
  parameters: z.object({ productId: cryptoProductIdSchema }),
  execute: async ({ productId }) => JSON.stringify({
    queued: true,
    ...queueArtifact({
      title: `${productId} · 1 month · daily candles`,
      productId,
      endpoint: "/api/artifacts/candles",
      renderer: renderCandles,
    }),
    instruction: `Say only: "Added the one-month ${productId} chart."`,
  }),
});

const orderBookTool = tool({
  name: "show_order_book_depth",
  description: "Queue a fresh Coinbase cumulative bid and ask order-book depth artifact for any USD crypto product. It appends without replacing earlier artifacts.",
  parameters: z.object({ productId: cryptoProductIdSchema }),
  execute: async ({ productId }) => JSON.stringify({
    queued: true,
    ...queueArtifact({
      title: `${productId} · order book depth`,
      productId,
      endpoint: "/api/artifacts/order-book",
      renderer: renderDepth,
    }),
    instruction: "The live depth chart is queued and will render independently. Acknowledge briefly; do not wait for it before accepting another request.",
  }),
});

const balanceTool = tool({
  name: "check_balance",
  description: "Fetch the user's real available Coinbase balances. Use this whenever the user asks what they own, what is available to trade, or whether they can afford an order.",
  parameters: z.object({}),
  execute: async () => {
    setStatus("checking balance", true);
    try {
      const result = await requestJson("/api/balance");
      return displayToolResult({ title: "Coinbase balances", source: "Coinbase", result });
    } finally {
      setStatus(micHeld ? "listening" : "ready", true);
    }
  },
});

const smartMoneyTool = tool({
  name: "check_smart_money",
  description: "Fetch real Nansen-labeled Smart Money perpetual trades for a crypto ticker through the configured Nansen API key or x402 wallet, then calculate bullish versus bearish position-changing activity.",
  parameters: z.object({ symbol: z.string().regex(/^[A-Za-z0-9]{2,15}$/).describe("Crypto ticker such as HYPE, BTC, or SOL") }),
  execute: async ({ symbol }) => {
    setStatus("checking smart money", true);
    try {
      const result = await requestJson("/api/smart-money", {
        method: "POST",
        body: JSON.stringify({ symbol }),
      });
      return displayToolResult({
        title: `${result.symbol || symbol} smart-money activity`,
        source: result.source || "Nansen",
        result,
        spec: buildSmartMoneyArtifact(result),
        variant: "smart-money",
      });
    } finally {
      setStatus(micHeld ? "listening" : "ready", true);
    }
  },
});

const derivativesPositioningTool = tool({
  name: "show_derivatives_positioning",
  description: "Show live perpetual-market positioning for a crypto asset: mark price, funding, open interest, 24h volume, premium/crowding, seven-day funding history, and—when Nansen returns it—observed long/short positioning and positions nearest liquidation. Use only when the user asks about derivatives, perps, funding, open interest, crowding, long/short market positioning, or liquidation risk. Do not call news, Polymarket, or broader research tools unless separately requested.",
  parameters: z.object({ productId: cryptoProductIdSchema }),
  execute: async ({ productId }) => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: `${productId} · derivatives positioning`,
      endpoint: "/api/artifacts/derivatives-positioning",
      body: { productId },
      loadingLabel: "fetching derivatives…",
      variant: "derivatives",
    }),
    instruction: `Say only: "Added the live derivatives positioning for ${productId}."`,
  }),
});

const positionRiskTool = tool({
  name: "show_position_risk",
  description: "Show the user's current Coinbase portfolio allocation, concentration, open orders, leveraged positions, PnL, liquidation prices, and margin-risk fields that Coinbase actually returns. Use only for requests about the user's portfolio exposure, open-position risk, liquidation level, margin, or active orders.",
  parameters: z.object({}),
  execute: async () => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: "Coinbase portfolio risk",
      endpoint: "/api/artifacts/position-risk",
      loadingLabel: "fetching portfolio…",
      variant: "portfolio-risk",
    }),
    instruction: "Say only: \"Added your current Coinbase position-risk view.\"",
  }),
});

const tradeImpactTool = tool({
  name: "show_trade_impact",
  description: "Estimate market-order execution quality from the live Coinbase order book and account fee tier. Shows expected average price, price impact, displayed liquidity, and fees across several USD order sizes. This is analysis only and never previews or places an order. Use when the user asks about slippage, market impact, liquidity cost, market versus limit execution, or how an order size may fill.",
  parameters: z.object({
    productId: cryptoProductIdSchema,
    quoteSize: z.number().positive().max(1_000_000).describe("USD notional the user wants to evaluate"),
  }),
  execute: async ({ productId, quoteSize }) => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: `${productId} · ${quoteSize.toLocaleString()} USD execution impact`,
      endpoint: "/api/artifacts/trade-impact",
      body: { productId, quoteSize },
      loadingLabel: "measuring impact…",
      variant: "trade-impact",
    }),
    instruction: `Say only: "Added the live execution-impact estimate for ${quoteSize.toLocaleString()} dollars of ${productId}."`,
  }),
});

const onchainFlowTool = tool({
  name: "show_onchain_flows",
  description: "Show real Nansen on-chain token flows: buy/sell volume, net trading flow, liquidity, and—when available—exchange, Smart Money, whale, fresh-wallet, and top-PnL-holder flows. The server dynamically resolves the token representation; provide chain and tokenAddress only when the user supplies them or an exact contract is important. Use only for on-chain flows, exchange inflows/outflows, whale accumulation/distribution, or holder-segment movement.",
  parameters: z.object({
    productId: cryptoProductIdSchema,
    chain: z.string().max(40).nullable().describe("Nansen chain slug or null to resolve dynamically"),
    tokenAddress: z.string().max(100).nullable().describe("Exact token contract/address or null to resolve dynamically"),
  }),
  execute: async ({ productId, chain, tokenAddress }) => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: `${productId} · on-chain flows`,
      endpoint: "/api/artifacts/onchain-flows",
      body: { productId, chain, tokenAddress },
      loadingLabel: "fetching on-chain flows…",
      variant: "onchain-flows",
    }),
    instruction: `Say only: "Added the current on-chain flow view for ${productId}."`,
  }),
});

const catalystCalendarTool = tool({
  name: "show_catalyst_calendar",
  description: "Search current sources and show a source-linked calendar of explicitly dated upcoming crypto catalysts such as token unlocks, governance votes, upgrades, launches, listings, regulatory deadlines, CPI, and FOMC events. Use only when the user asks for upcoming catalysts, events, deadlines, unlocks, or a calendar. Do not add news or Polymarket artifacts unless separately requested.",
  parameters: z.object({
    productId: cryptoProductIdSchema,
    horizonDays: z.number().int().min(7).max(180).describe("Calendar horizon in days; use 90 when the user does not specify"),
  }),
  execute: async ({ productId, horizonDays }) => JSON.stringify({
    queued: true,
    ...queueGenericArtifact({
      title: `${productId} · upcoming catalysts`,
      endpoint: "/api/artifacts/catalysts",
      body: { productId, horizonDays },
      loadingLabel: "building catalyst calendar…",
      variant: "catalysts",
    }),
    instruction: `Say only: "Added the upcoming ${productId} catalyst calendar."`,
  }),
});

const presentArtifactTool = tool({
  name: "present_artifact",
  description: "Create an alternate visual or combine completed real tool results when that adds value beyond the artifact already shown automatically. Use only returned values: metrics for compact summaries, tables for records, lists for highlights or service catalogs, cards for people and candidates with real avatars and contact/profile links, key/value panels for objects, text for conclusions, links for sources, and line or bar charts for numeric series. Never invent missing data and never duplicate an artifact that is already visible.",
  parameters: artifactSpecSchema,
  execute: async (spec) => JSON.stringify({
    displayed: true,
    ...renderGenericArtifact(spec),
    instruction: "The tool result is visible. Acknowledge it in one short sentence without reading the artifact aloud.",
  }),
});

let agentCashToolPromise = null;

const alternativeCount = (catalog) => Array.isArray(catalog?.results)
  ? catalog.results.reduce((count, provider) => count + (provider.endpoints?.length || 0), 0)
  : 0;

const discoverPaidAlternatives = (intent) => {
  if (!appConfig?.readiness?.orthogonal) return Promise.resolve(null);
  return requestJson("/api/orthogonal/discover", {
    method: "POST",
    body: JSON.stringify({
      action: "search",
      arguments: {
        prompt: `Find an API endpoint that directly returns the requested records for this task: ${intent}. Prefer searchable records and filters relevant to the request.`,
        limit: 8,
      },
    }),
  }).catch(() => null);
};

const logPaidRecovery = (payload) => fetch("/api/logs/paid-recovery", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
  keepalive: true,
}).catch(() => {});

async function loadAgentCashTool() {
  const discovery = await requestJson("/api/agentcash/tools").catch(() => null);
  if (!discovery?.connected || !discovery.tools?.length) return null;
  const catalog = discovery.tools.map(({ name, description, inputSchema }) =>
    `${name}: ${description || "No description"}\nInput schema: ${JSON.stringify(inputSchema || {})}`
  ).join("\n\n");
  return tool({
    name: "use_agentcash",
    description: `Use AgentCash for real paid or wallet-authenticated API calls. Do not use this router for crypto news; use search_crypto_news. The intent field must describe the exact records/data needed and useful filters in tool language, not merely repeat the user's conversational wording; recovery uses it to find another provider. For people/company enrichment, non-crypto web search, scraping, maps, LinkedIn, email verification, or non-crypto news, go directly to discover_api_endpoints on https://stableenrich.dev. Use https://stablesocial.dev for social data, https://stablestudio.dev for image/video generation, https://stablejobs.dev only for job postings, and https://stabletravel.dev for travel. A request to find people to hire is a people/enrichment search, not a job-posting search. Use search only when no known origin fits. Always follow discover_api_endpoints -> check_endpoint_schema -> fetch, reading endpoint instructions and exact field names before fetching. Prefer x402 on Base when the endpoint supports it, but follow an endpoint's explicit Solana, Tempo, or MPP requirement. Discovery, search, schema checks, empty results, and failed calls are internal navigation. Do not display or narrate them. On invalid arguments, correct the request using the returned validation/schema details; on an empty or broken endpoint, switch to another suitable provider. The runtime blocks identical repeated fetches. Continue until data is returned or at least two materially different attempts have failed and no suitable unused alternative remains. Never use wallet mutation, settings, bridging, or error-reporting tools. Do not narrate AgentCash or payment mechanics unless the user asks.\n\n${catalog}`,
    parameters: x402RouterParameters,
    strict: false,
    execute: async ({ toolName, arguments: argumentsValue, intent }) => {
      const endpoint = String(argumentsValue?.url ?? argumentsValue?.origin ?? "");
      const attempt = toolName === "fetch"
        ? paidAttemptTracker.register({ intent, toolName, argumentsValue })
        : { duplicate: false, attemptCount: 0, distinctEndpointCount: 0 };
      if (attempt.duplicate) {
        const alternatives = await discoverPaidAlternatives(intent);
        const alternativesFound = alternativeCount(alternatives);
        logPaidRecovery({
          intent,
          toolName,
          endpoint,
          outcome: "duplicate_blocked",
          failureKind: "unchanged_request",
          ...attempt,
          alternativeCount: alternativesFound,
        });
        return JSON.stringify({
          data: { error: "Identical paid request blocked before execution." },
          alternatives,
          display: { displayed: false },
          instruction: `Do not report failure and do not repeat this request. It is identical to an earlier attempt. ${alternativesFound ? "Choose a different provider from alternatives, inspect it with use_orthogonal_catalog details, then call use_agentcash fetch with its exact schema." : "Change the request arguments based on the prior provider error or use AgentCash discovery to choose a different endpoint."}`,
        });
      }
      const result = await requestJson("/api/agentcash/call", {
        method: "POST",
        body: JSON.stringify({ toolName, arguments: argumentsValue, intent }),
      });
      const { data, navigation, failure, empty, autoDisplay } = classifyX402Result(toolName, result);
      if (!autoDisplay) {
        const failureKind = classifyPaidFailure({ failure, empty, data });
        const alternatives = failureKind ? await discoverPaidAlternatives(intent) : null;
        const hasAlternatives = alternatives && !isEmptyToolResult(alternatives);
        logPaidRecovery({
          intent,
          toolName,
          endpoint,
          outcome: navigation ? "navigation" : "recovery_required",
          failureKind,
          ...attempt,
          alternativeCount: alternativeCount(alternatives),
        });
        return JSON.stringify({
          data: failure ? { error: failure } : data,
          alternatives,
          display: { displayed: false },
          instruction: failure || empty
            ? `This was material attempt ${attempt.attemptCount} and it ${empty ? "returned no records" : `failed (${failureKind}): ${failure}`}. Do not tell the user yet and do not display this response. ${failureKind === "invalid_request" ? "Inspect the returned validation error or expected schema and make a corrected request with changed arguments; if the provider contract is contradictory or the correction is unclear, switch providers." : "Switch to a different suitable endpoint or provider."} ${hasAlternatives ? "Relevant alternatives are included. Inspect one with use_orthogonal_catalog details, then call use_agentcash fetch using its exact x402Url or mppUrl and schema." : "Use AgentCash discovery or search to find another suitable endpoint."} Never repeat the same endpoint with unchanged arguments. Continue until requested data is returned; conclude unavailable only after at least two materially different attempts and no unused suitable alternative remains.`
            : `${navigation ? "This is internal AgentCash navigation metadata." : "This result is not displayable."} Continue to the requested data endpoint without summarizing it. Only if the user explicitly asked to see available services, call present_artifact with one concise list block containing service names and short descriptions; never use a table for the catalog.`,
        });
      }
      if (toolName === "fetch") paidAttemptTracker.clear(intent);
      logPaidRecovery({
        intent,
        toolName,
        endpoint,
        outcome: "success",
        ...attempt,
      });
      return displayToolResult({ title: toolTitle(toolName), source: "AgentCash", result });
    },
  });
}

function getAgentCashTool() {
  if (!agentCashToolPromise) {
    agentCashToolPromise = loadAgentCashTool().catch((error) => {
      agentCashToolPromise = null;
      console.error("Unable to load AgentCash tools", error);
      return null;
    });
  }
  return agentCashToolPromise;
}

function loadOrthogonalCatalogTool(agentCashTool) {
  if (!agentCashTool || !appConfig?.readiness?.orthogonal) return null;
  return tool({
    name: "use_orthogonal_catalog",
    description: "Discover additional live API providers and inspect exact endpoint schemas. This tool only discovers endpoints; it never runs or pays for them. Use action search with the user's outcome, then details for the selected api and path. Execute the returned x402Url or mppUrl only through use_agentcash fetch. Keep all catalog and schema results internal unless the user explicitly asks to see available services.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "details", "list"] },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["action", "arguments"],
      additionalProperties: false,
    },
    strict: false,
    execute: async ({ action, arguments: argumentsValue }) => {
      const result = await requestJson("/api/orthogonal/discover", {
        method: "POST",
        body: JSON.stringify({ action, arguments: argumentsValue }),
      });
      return JSON.stringify({
        data: result,
        display: { displayed: false },
        instruction: action === "details"
          ? "Internal endpoint schema. Call use_agentcash fetch with the returned x402Url or mppUrl and the exact documented method, headers, query, and body. Never call an Orthogonal run endpoint."
          : "Internal catalog navigation. Select a suitable endpoint and call use_orthogonal_catalog with action details. Do not summarize or display this catalog unless the user explicitly requested the service list.",
      });
    },
  });
}

let coinbaseToolsPromise = null;

function loadCoinbaseTools() {
  if (!coinbaseToolsPromise) {
    coinbaseToolsPromise = requestJson("/api/coinbase/tools")
      .then((discovery) => {
        if (!discovery?.connected || !discovery.tools?.length) return [];
        return discovery.tools.map(({ name, description, inputSchema }) => tool({
          name,
          description,
          parameters: inputSchema || { type: "object", properties: {} },
          strict: false,
          execute: async (argumentsValue) => {
            const result = await requestJson("/api/coinbase/call", {
              method: "POST",
              body: JSON.stringify({ toolName: name, arguments: argumentsValue }),
            });
            return displayToolResult({ title: `Coinbase ${toolTitle(name)}`, source: "Coinbase", result });
          },
        }));
      })
      .catch((error) => {
        coinbaseToolsPromise = null;
        console.error("Unable to load Coinbase tools", error);
        return [];
      });
  }
  return coinbaseToolsPromise;
}

const previewOrderTool = tool({
  name: "preview_order",
  description: "Get a real Coinbase preview for a spot, equity, or futures market, limit, or stop-limit order, then ask for explicit confirmation. Set amountType to quote for a quote-currency amount or base for shares, contracts, or base-asset units. Futures always use base. The server converts priced quote amounts and quantizes them to Coinbase's live increment; do not calculate or convert a quote amount to base size yourself. Extended-hours equities require a whole-share limit order and equityTradingSession.",
  parameters: z.object({
    productId: productIdSchema,
    side: z.enum(["BUY", "SELL"]),
    type: z.enum(["market", "limit", "stop_limit"]),
    amount: z.number().positive().describe("Amount in the unit selected by amountType"),
    amountType: z.enum(["quote", "base"]).describe("quote for dollars/USDC; base for shares, futures contracts, or base-asset units"),
    limitPrice: z.number().positive().nullable(),
    stopPrice: z.number().positive().nullable(),
    stopDirection: z.enum(["up", "down"]).nullable(),
    equityTradingSession: z.enum(["PRE_MARKET", "AFTER_HOURS", "OVERNIGHT", "MULTI_SESSION"]).nullable(),
  }),
  execute: async ({ productId, side, type, amount, amountType, limitPrice, stopPrice, stopDirection, equityTradingSession }) => {
    const order = {
      productId,
      side,
      type,
      ...(amountType === "quote" ? { quoteSize: String(amount) } : { baseSize: String(amount) }),
      ...(limitPrice == null ? {} : { limitPrice: String(limitPrice) }),
      ...(stopPrice == null ? {} : { stopPrice: String(stopPrice) }),
      ...(stopDirection == null ? {} : { stopDirection }),
      ...(equityTradingSession == null ? {} : { equityTradingSession }),
    };
    const payload = await requestJson("/api/orders/preview", { method: "POST", body: JSON.stringify(order) });
    renderPreview(payload);
    return JSON.stringify({ ...payload, instruction: "Read back the exact preview and ask for confirmation. Stop this turn without executing." });
  },
});

const executeOrderTool = tool({
  name: "execute_order",
  description: "Execute the exact pending Coinbase preview only after the user's newest utterance explicitly confirms it.",
  parameters: z.object({ previewId: z.string().uuid() }),
  execute: async ({ previewId }) => {
    if (!pendingPreviewId || previewId !== pendingPreviewId) throw new Error("This is not the currently displayed preview. Preview the order again.");
    if (activeTradeEntry) activeTradeEntry.status.textContent = "Executing…";
    const payload = await requestJson("/api/orders/execute", { method: "POST", body: JSON.stringify({ previewId }) });
    renderExecution(payload);
    return JSON.stringify(payload);
  },
});

async function startSession() {
  elements.voiceButton.disabled = true;
  let candidate = null;
  try {
    clearLiveCaption();
    setStatus("allow microphone");
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setStatus("connecting");
    const [{ value }, agentCashTool, coinbaseTools] = await Promise.all([
      requestJson("/api/realtime-token", { method: "POST", body: "{}" }),
      getAgentCashTool(),
      loadCoinbaseTools(),
    ]);
    const orthogonalCatalogTool = loadOrthogonalCatalogTool(agentCashTool);
    const agent = new RealtimeAgent({
      name: "Coinbase for Agents",
      instructions: appConfig.agentInstructions,
      tools: [
        researchTool,
        cryptoNewsTool,
        polymarketTool,
        candleChartTool,
        orderBookTool,
        balanceTool,
        smartMoneyTool,
        derivativesPositioningTool,
        positionRiskTool,
        tradeImpactTool,
        onchainFlowTool,
        catalystCalendarTool,
        presentArtifactTool,
        ...(agentCashTool ? [agentCashTool] : []),
        ...(orthogonalCatalogTool ? [orthogonalCatalogTool] : []),
        ...coinbaseTools,
        previewOrderTool,
        executeOrderTool,
      ],
    });
    const transport = new OpenAIRealtimeWebRTC({
      audioElement: elements.agentAudio,
      mediaStream: microphoneStream,
    });
    candidate = new RealtimeSession(agent, {
      model: appConfig.realtimeModel,
      transport,
      config: {
        outputModalities: ["audio"], parallelToolCalls: true, reasoning: { effort: "low" },
        audio: { input: { transcription: { model: "gpt-realtime-whisper" }, turnDetection: { type: "semantic_vad", eagerness: "medium", createResponse: true, interruptResponse: true } }, output: { voice: appConfig.realtimeVoice } },
      },
    });
    candidate.on("transport_event", handleTransportEvent);
    candidate.on("error", (event) => { console.error(event); setStatus("error"); });
    candidate.on("audio_start", () => {
      if (liveCaptionRole === "user") clearLiveCaption();
      setStatus(speakerMuted ? "agent speaking · muted" : "agent speaking", true);
    });
    candidate.on("audio_stopped", () => {
      // response.output_audio.done can arrive before WebRTC finishes playing its buffer.
      // The transport's output_audio_buffer.stopped event clears sooner when available.
      scheduleCaptionDismiss(5_000);
      setStatus(micHeld ? "listening" : "ready", true);
    });
    candidate.on("audio_interrupted", () => {
      clearLiveCaption();
      setStatus(micHeld ? "listening" : "ready", true);
    });
    await candidate.connect({ apiKey: value });
    candidate.mute(true);
    session = candidate;
    micHeld = false;
    setStatus("ready", true);
    elements.voiceButton.classList.add("active", "connected");
    elements.voiceButtonText.textContent = "Hold to talk";
    elements.voiceButton.setAttribute("aria-label", "Hold to talk");
    elements.voiceButton.blur();
    elements.sessionControls.hidden = false;
  } catch (error) {
    candidate?.close();
    microphoneStream?.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
    session = null;
    throw error;
  } finally {
    elements.voiceButton.disabled = false;
  }
}

function stopSession() {
  session?.close(); session = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  micHeld = false;
  speakerMuted = false;
  clearLiveCaption();
  elements.agentAudio.muted = false;
  elements.agentAudio.srcObject = null;
  setStatus("offline");
  elements.voiceButton.classList.remove("active", "connected", "speaking");
  elements.voiceButtonText.textContent = "Start voice";
  elements.voiceButton.setAttribute("aria-label", "Start voice");
  elements.speakerButton.textContent = "Mute agent";
  elements.speakerButton.classList.remove("muted");
  elements.sessionControls.hidden = true;
}

elements.voiceButton.addEventListener("click", async () => {
  if (session) return;
  try { await startSession(); } catch (error) { console.error(error); setStatus("error"); elements.setupNote.textContent = error.message; }
});

function beginTalk() {
  if (!session || micHeld) return;
  clearLiveCaption();
  micHeld = true;
  session.mute(false);
  elements.voiceButton.classList.add("speaking");
  setStatus("listening", true);
}

function endTalk() {
  if (!session || !micHeld) return;
  micHeld = false;
  session.mute(true);
  clearLiveCaption();
  elements.voiceButton.classList.remove("speaking");
  setStatus("working", true);
}

elements.voiceButton.addEventListener("pointerdown", (event) => {
  if (!session) return;
  event.preventDefault();
  elements.voiceButton.setPointerCapture?.(event.pointerId);
  beginTalk();
});
elements.voiceButton.addEventListener("pointerup", endTalk);
elements.voiceButton.addEventListener("pointercancel", endTalk);

elements.speakerButton.addEventListener("click", () => {
  speakerMuted = !speakerMuted;
  elements.agentAudio.muted = speakerMuted;
  elements.speakerButton.textContent = speakerMuted ? "Unmute agent" : "Mute agent";
  elements.speakerButton.classList.toggle("muted", speakerMuted);
});

elements.endButton.addEventListener("click", stopSession);

window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || !session) return;
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(document.activeElement?.tagName) && document.activeElement !== elements.voiceButton) return;
  event.preventDefault();
  beginTalk();
});
window.addEventListener("keyup", (event) => {
  if (event.code !== "Space" || !session) return;
  event.preventDefault();
  endTalk();
});

async function init() {
  appConfig = await requestJson("/api/config");
  const missing = [];
  if (!appConfig.readiness.openAi) missing.push("OPENAI_API_KEY");
  if (!appConfig.readiness.exa) missing.push("EXA_API_KEY");
  if (!appConfig.readiness.coinbase) missing.push("COINBASE_KEY_ID and COINBASE_KEY_SECRET");
  elements.setupNote.textContent = missing.length ? `Missing: ${missing.join(", ")}` : "";
}

init().catch((error) => { elements.setupNote.textContent = error.message; });
