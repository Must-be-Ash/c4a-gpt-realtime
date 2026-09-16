// Read-only live dashboard. Artifacts-first: charts/research/trades render into the
// same artifact feed the local app uses, with the same visuals (public/styles.css +
// shared renderers). Spoken text passes along the bottom as captions (subtitles),
// mirroring the local app's live captions — it is not a chat log.

import {
  append,
  renderCandles,
  renderDepth,
  renderPolymarketArtifact,
  populateGenericArtifact,
} from "../public/artifact-render.js";
import { buildToolResultArtifact, buildSmartMoneyArtifact } from "../public/tool-result-artifact.js";
import { captionWindow } from "../public/caption-window.js";
import { describePitchState, describeRunResult, pitchBriefSpec } from "./pitch-brief.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  themeToggle: $("#themeToggle"),
  themeColor: $('meta[name="theme-color"]'),
  callPill: $("#callPill"),
  connDot: $("#connDot"),
  idleNote: $("#idleNote"),
  artifacts: $("#artifacts"),
  captions: $("#captions"),
  tradeTemplate: $("#tradeTemplate"),
  agentSelect: $("#agentSelect"),
  agentHint: $("#agentHint"),
  pitchControls: $("#pitchControls"),
  pitchNow: $("#pitchNow"),
  pitchToggle: $("#pitchToggle"),
  pitchStatus: $("#pitchStatus"),
  pitchEngine: $("#pitchEngine"),
};

// ── Theme (same behavior as the local app) ──
function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  elements.themeColor.content = next === "dark" ? "#080a0f" : "#f6f8fc";
}
applyTheme(document.documentElement.dataset.theme);
elements.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("coinbase-agents-theme", next); } catch { /* still applies this page */ }
});

// ── Call status ──
function setCall(state, label) {
  elements.callPill.className = `call-pill ${state}`;
  elements.callPill.textContent = label;
  if (state === "incoming" || state === "active") elements.idleNote.hidden = true;
}

// ── Artifact feed ──
function appendArtifact(node) {
  elements.idleNote.hidden = true;
  elements.artifacts.hidden = false;
  elements.artifacts.append(node);
  node.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function genericArtifact(spec, variant = null) {
  const article = document.createElement("article");
  populateGenericArtifact(article, spec, { variant });
  appendArtifact(article);
}

function chartArtifact(title, sourceLabel, data, renderer, variant) {
  const article = document.createElement("article");
  article.className = variant ? `artifact ${variant}-artifact` : "artifact";
  const header = append(article, "header", "artifact-header");
  append(header, "h2", null, title);
  append(header, "span", "artifact-state done", "ready");
  const chart = append(article, "div", "chart");
  const footer = append(article, "footer", "artifact-footer");
  append(footer, "span", null, sourceLabel);
  append(footer, "span", null, new Date().toLocaleTimeString());
  appendArtifact(article);
  try {
    renderer(chart, data);
  } catch (error) {
    chart.replaceChildren();
    append(chart, "p", "artifact-error", error.message);
  }
}

function renderReport(event) {
  const report = event.report;
  const title = event.title || (report?.asset?.productId ? `${report.asset.productId} · research` : "Research");
  const source = report?.mode === "news" ? "Exa news" : "Exa research + Coinbase";
  const spec = buildToolResultArtifact({ title, source, result: report ?? {} });
  if (event.reportUrl) {
    spec.blocks.push({ type: "links", title: "Report", items: [{ label: "Open full report", url: new URL(event.reportUrl, location.origin).href, detail: null }] });
  }
  genericArtifact(spec, "report");
}

function renderTrade(event) {
  const executed = event.kind === "execution";
  const data = event.data || {};
  const panel = elements.tradeTemplate.content.firstElementChild.cloneNode(true);
  const order = data.order || {};
  const quoteCurrency = (order.productId || "").split("-").at(-1);
  const amount = order.quoteSize != null ? `${order.quoteSize} ${quoteCurrency}`
    : order.baseSize != null ? `${order.baseSize} ${(order.productId || "").split("-")[0]}`
    : "";
  const type = order.type === "stop_limit" ? "STOP LIMIT" : (order.type || "").toUpperCase();
  panel.querySelector(".meta").textContent = executed ? "Coinbase order executed" : "Coinbase order preview";
  panel.querySelector(".trade-title").textContent = `${order.side || ""} ${amount} of ${order.productId || ""} · ${type}`.trim();
  const preview = data.preview || {};
  panel.querySelector(".trade-details").textContent = [
    order.limitPrice && `limit $${order.limitPrice}`,
    preview.est_average_filled_price && (preview.estimated ? `estimate ~$${preview.est_average_filled_price} (live price)` : `est fill $${preview.est_average_filled_price}`),
    preview.commission_total && `fee $${preview.commission_total}`,
    data.expiresAt && !executed && `expires ${new Date(data.expiresAt).toLocaleTimeString()}`,
  ].filter(Boolean).join(" · ");
  const status = panel.querySelector(".trade-status");
  if (executed) {
    const id = data.result?.order_id || data.result?.client_order_id || "submitted";
    status.textContent = `Executed · ${id}`;
    status.classList.add("executed");
  }
  appendArtifact(panel);
}

// ── Passing captions (subtitles) ──
let captionTimer = null;
function showCaption(role, text) {
  const windowed = captionWindow(String(text || ""));
  if (!windowed) return;
  elements.idleNote.hidden = true;
  const who = role === "user" ? "user" : "model";
  elements.captions.replaceChildren();
  const caption = append(elements.captions, "div", `caption caption-${who}`);
  append(caption, "span", "caption-label", who === "user" ? "YOU" : "AGENT");
  append(caption, "strong", "caption-text", windowed);
  elements.captions.hidden = false;
  if (captionTimer) clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { elements.captions.hidden = true; }, 5000);
}

// ── Event dispatch ──
function handle(event) {
  switch (event.kind) {
    case "call":
      if (event.type === "incoming" && event.direction === "outbound") setCall("incoming", `Calling you · ${event.title || "Jordan"}`);
      else if (event.type === "incoming") setCall("incoming", event.title || (event.caller ? `Incoming · ${event.caller}` : "Incoming"));
      else if (event.type === "rejected") setCall("rejected", "Rejected");
      break;
    case "status-update":
      if (event.status === "in-progress") setCall("active", "On call");
      else if (event.status === "ended") setCall("ended", "Call ended");
      break;
    case "transcript":
      if (event.transcriptType === "final" || !event.transcriptType) showCaption(event.role, event.text);
      break;
    case "report":
      renderReport(event);
      break;
    case "artifact": {
      const data = event.data || {};
      const variant = event.variant || null;
      if (variant === "candles") chartArtifact(event.title || "Candles", "Coinbase live market data", data, renderCandles, variant);
      else if (variant === "order-book") chartArtifact(event.title || "Order book", "Coinbase live market data", data, renderDepth, variant);
      else if (variant === "polymarket") chartArtifact(event.title || "Polymarket", "Polymarket live markets", data, renderPolymarketArtifact, variant);
      else if (variant === "smart-money") genericArtifact(buildSmartMoneyArtifact(data), variant);
      else if (data.spec) genericArtifact(data.spec, variant);
      else genericArtifact(buildToolResultArtifact({ title: event.title || "Result", source: null, result: data }), variant);
      break;
    }
    case "balance":
      genericArtifact(buildToolResultArtifact({ title: event.title || "Coinbase balances", source: "Coinbase", result: event.data || {} }), "balance");
      break;
    case "preview":
      renderTrade(event);
      break;
    case "execution":
      renderTrade(event);
      break;
    case "latency":
      if (event.type === "turn") elements.callPill.title = `last reply gap ${event.ms} ms`;
      else if (event.type === "summary" && event.medianTurnMs != null) setCall("ended", `Ended · median reply ${event.medianTurnMs} ms`);
      break;
    case "pitch":
      if (event.type === "dialed" && event.facts) genericArtifact(pitchBriefSpec(event), "pitch");
      if (event.type === "outcome" || event.type === "ended") loadPitchState();
      break;
    case "end-of-call-report":
      if (!elements.callPill.textContent.startsWith("Ended")) setCall("ended", "Call ended");
      elements.captions.hidden = true;
      break;
    default:
      break;
  }
}

// ── Agent number (the number to call) ──
function formatPhone(number) {
  const digits = String(number || "").replace(/[^\d+]/g, "");
  const us = digits.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return us ? `+1 (${us[1]}) ${us[2]}-${us[3]}` : (number || "");
}
function renderAgentState(state) {
  const selected = state.agents.find((a) => a.id === state.selectedAgent) || state.agents[0];
  elements.agentSelect.value = selected.id;
  if (selected.number) {
    $("#agentNumberText").textContent = formatPhone(selected.number);
    $("#agentNumber").href = `tel:${selected.number}`;
  } else {
    $("#agentNumberText").textContent = "no number set";
    $("#agentNumber").removeAttribute("href");
  }
  elements.agentHint.className = "agent-hint";
  elements.agentHint.textContent = selected.armable
    ? (state.activeSipAgent === selected.id ? "armed on this number" : `number is armed to ${state.activeSipAgent}`)
    : "Vapi number";
}
async function loadAgentNumber() {
  try {
    const response = await fetch("/api/agent");
    if (!response.ok) return;
    renderAgentState(await response.json());
  } catch { /* leave placeholder */ }
}
elements.agentSelect.addEventListener("change", async () => {
  const agent = elements.agentSelect.value;
  elements.agentHint.className = "agent-hint";
  elements.agentHint.textContent = "switching…";
  try {
    const response = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderAgentState(await response.json());
  } catch (error) {
    elements.agentHint.className = "agent-hint error";
    elements.agentHint.textContent = `switch failed: ${error.message}`;
    loadAgentNumber();
  }
});

// ── Pitch calls ("Jordan") ──
let pitchMessageTimer = null;
function showPitchMessage(text, isError = false) {
  elements.pitchStatus.textContent = text;
  elements.pitchStatus.classList.toggle("error", isError);
  if (pitchMessageTimer) clearTimeout(pitchMessageTimer);
  pitchMessageTimer = setTimeout(loadPitchState, 12_000);
}
function renderPitchState(state) {
  elements.pitchControls.hidden = false;
  elements.pitchToggle.checked = !state.paused;
  elements.pitchToggle.disabled = !state.enabled;
  elements.pitchNow.disabled = !state.enabled || state.paused;
  for (const option of elements.pitchEngine.options) {
    const engine = state.engines?.find((e) => e.id === option.value);
    option.disabled = engine ? !engine.available : false;
    if (engine) option.textContent = `Jordan · ${engine.label}`;
  }
  elements.pitchEngine.value = state.engine || "elevenlabs";
  elements.pitchStatus.classList.remove("error");
  elements.pitchStatus.textContent = describePitchState(state);
}
async function loadPitchState() {
  try {
    const response = await fetch("/api/pitch/state");
    if (!response.ok) return;
    renderPitchState(await response.json());
  } catch { /* controls stay hidden */ }
}
elements.pitchNow.addEventListener("click", async () => {
  elements.pitchNow.disabled = true;
  elements.pitchNow.classList.add("busy");
  elements.pitchStatus.classList.remove("error");
  elements.pitchStatus.textContent = "Scanning the desk…";
  try {
    const response = await fetch("/api/pitch/run", { method: "POST" });
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (result.state) renderPitchState(result.state);
    showPitchMessage(describeRunResult(result), !response.ok || result.action === "failed");
  } catch (error) {
    showPitchMessage(`Scan failed: ${error.message}`, true);
  } finally {
    elements.pitchNow.classList.remove("busy");
    elements.pitchNow.disabled = elements.pitchToggle.disabled || !elements.pitchToggle.checked;
  }
});
elements.pitchEngine.addEventListener("change", async () => {
  const engine = elements.pitchEngine.value;
  try {
    const response = await fetch("/api/pitch/engine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    renderPitchState(body);
    showPitchMessage(`Jordan will call on ${engine === "realtime" ? "gpt-realtime-2.1" : "ElevenLabs"}`);
  } catch (error) {
    showPitchMessage(`Couldn't switch: ${error.message}`, true);
    loadPitchState();
  }
});
elements.pitchToggle.addEventListener("change", async () => {
  const paused = !elements.pitchToggle.checked;
  try {
    const response = await fetch("/api/pitch/pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderPitchState(await response.json());
  } catch (error) {
    elements.pitchToggle.checked = paused;
    showPitchMessage(`Couldn't update: ${error.message}`, true);
  }
});

// ── SSE ──
function connect() {
  const source = new EventSource("/api/stream");
  source.onopen = () => { elements.connDot.className = "conn-dot connected"; };
  source.onmessage = (message) => {
    try { handle(JSON.parse(message.data)); } catch { /* ignore malformed frames */ }
  };
  source.onerror = () => { elements.connDot.className = "conn-dot reconnecting"; }; // auto-reconnects
}
loadAgentNumber();
loadPitchState();
setInterval(loadPitchState, 60_000);
connect();
