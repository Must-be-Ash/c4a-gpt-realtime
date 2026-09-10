// Shared artifact + chart renderers, used by both the local voice app
// (public/app.js) and the hosted dashboard (dashboard/dashboard.js) so the two
// surfaces render identical visuals from the same CSS (public/styles.css).
//
// These are pure DOM builders: given a container/spec/payload they produce nodes.
// They hold no session state and do not touch the page's live-caption or queue.

const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const compact = (value) => compactFormatter.format(value ?? 0);
export const percent = (value) => value == null ? "—" : `${value >= 0 ? "+" : ""}${Number(value).toFixed(1)}%`;
export const append = (parent, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  parent.append(node);
  return node;
};

const SVG_NS = "http://www.w3.org/2000/svg";
export const svgNode = (tag, attributes = {}, text = null) => {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  if (text != null) node.textContent = text;
  return node;
};

export const chartFrame = (container, {
  width = 960,
  height = 360,
  margin = { top: 24, right: 22, bottom: 38, left: 64 },
} = {}) => {
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  container.replaceChildren(svg);
  return { svg, width, height, margin, innerWidth: width - margin.left - margin.right, innerHeight: height - margin.top - margin.bottom };
};

export function renderCandles(container, payload) {
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

export function renderDepth(container, payload) {
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

export function renderPolymarketArtifact(container, payload) {
  container.classList.add("polymarket-artifact");
  const cards = append(container, "div", "cards");
  payload.markets.forEach((item) => {
    const card = document.querySelector("#polyCardTemplate").content.firstElementChild.cloneNode(true);
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

export function renderGenericChart(container, block) {
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

export function renderGenericBlock(parent, block) {
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

export function populateGenericArtifact(artifact, spec, { variant = null, timestamp = new Date() } = {}) {
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
