import assert from "node:assert/strict";
import test from "node:test";

import { artifactSpecSchema } from "../src/shared/artifact-schema.js";
import {
  buildSmartMoneyArtifact,
  buildToolResultArtifact,
  classifyX402Result,
  isEmptyToolResult,
  unwrapToolResult,
  x402FailureMessage,
} from "../public/tool-result-artifact.js";

test("keeps x402 navigation metadata hidden while displaying completed paid results", () => {
  assert.equal(classifyX402Result("discover_services").autoDisplay, false);
  assert.equal(classifyX402Result("get_service").autoDisplay, false);
  assert.equal(classifyX402Result("get_openapi_spec").autoDisplay, false);
  assert.equal(classifyX402Result("search").autoDisplay, false);
  assert.equal(classifyX402Result("discover_api_endpoints").autoDisplay, false);
  assert.equal(classifyX402Result("check_endpoint_schema").autoDisplay, false);
  assert.equal(classifyX402Result("paid_fetch", { data: [{ id: 1 }] }).autoDisplay, true);
  assert.equal(classifyX402Result("fetch", { data: [{ id: 1 }] }).autoDisplay, true);
});

test("keeps every failed x402 call out of the artifact feed and extracts a concise error", () => {
  const result = { status: 404, ok: false, data: { success: false, code: "route_not_found", error: "Route not found." } };
  assert.equal(classifyX402Result("paid_fetch", result).autoDisplay, false);
  assert.equal(classifyX402Result("custom_tool", result).autoDisplay, false);
  assert.equal(x402FailureMessage(result), "Route not found.");
});

test("keeps AgentCash before-payment failures out of the artifact feed", () => {
  const result = {
    cause: "insufficient_balance",
    message: "Current balance is 0 USDC.",
    type: "before_payment",
    surface: "fetch",
  };

  const classification = classifyX402Result("fetch", result);
  assert.equal(classification.autoDisplay, false);
  assert.equal(classification.failure, "The selected payment account has insufficient funds.");
});

test("keeps empty search results internal so the agent can try another source", () => {
  const result = {
    jobs: [],
    pagination: { page: 1, total_results: 0, has_more: false },
  };
  const classification = classifyX402Result("fetch", result);

  assert.equal(isEmptyToolResult(result), true);
  assert.equal(classification.empty, true);
  assert.equal(classification.autoDisplay, false);
  assert.equal(isEmptyToolResult({ data: { results: [] }, success: true }), true);
  assert.equal(isEmptyToolResult({}), true);
  assert.equal(isEmptyToolResult({ success: true }), true);
  assert.equal(isEmptyToolResult({ data: { people: [{ name: "Ada" }] }, success: true }), false);
});

test("keeps MCP isError results out of the artifact feed", () => {
  const result = {
    isError: true,
    content: [{ type: "text", text: "Error: paid_fetch requires a full URL." }],
  };
  const classification = classifyX402Result("paid_fetch", result);

  assert.equal(classification.autoDisplay, false);
  assert.equal(classification.failure, "paid_fetch requires a full URL.");

  for (const content of [undefined, [], [{ type: "text", text: "   " }], [{ type: "image", data: "ignored" }]]) {
    const emptyClassification = classifyX402Result("paid_fetch", { isError: true, content });
    assert.equal(emptyClassification.autoDisplay, false);
    assert.equal(emptyClassification.failure, "x402 tool call failed.");
  }
});

test("renders enriched people as candidate cards with real contact links and avatars", () => {
  const artifact = buildToolResultArtifact({
    title: "Candidate search",
    source: "x402",
    result: {
      candidates: [{
        full_name: "Ada Lovelace",
        headline: "Protocol engineer",
        summary: "Built production trading infrastructure.",
        email: "ada@example.com",
        linkedin_url: "https://linkedin.com/in/ada",
        avatar_url: "https://example.com/ada.jpg",
      }],
    },
  });
  const cards = artifact.blocks.find((block) => block.type === "cards");

  assert.equal(cards.items[0].title, "Ada Lovelace");
  assert.equal(cards.items[0].imageUrl, "https://example.com/ada.jpg");
  assert.deepEqual(cards.items[0].links, [
    { label: "Email", url: "mailto:ada@example.com" },
    { label: "Linkedin", url: "https://linkedin.com/in/ada" },
  ]);
  assert.deepEqual(artifactSpecSchema.parse(artifact), artifact);
});

test("renders researched LinkedIn people results as candidate cards", () => {
  const artifact = buildToolResultArtifact({
    title: "Developer Relations candidates",
    source: "Paid research",
    result: {
      results: [{
        title: "Anna Example",
        url: "https://www.linkedin.com/in/anna-example",
        summary: "Developer Advocate working on agentic payments.",
        image: "https://example.com/anna.jpg",
      }],
    },
  });
  const cards = artifact.blocks.find((block) => block.type === "cards");

  assert.equal(cards.items[0].title, "Anna Example");
  assert.equal(cards.items[0].detail, "Developer Advocate working on agentic payments.");
  assert.equal(cards.items[0].imageUrl, "https://example.com/anna.jpg");
  assert.deepEqual(cards.items[0].links, [
    { label: "Url", url: "https://www.linkedin.com/in/anna-example" },
  ]);
});

test("renders nested social profiles as cards but leaves generic service records as tables", () => {
  const peopleArtifact = buildToolResultArtifact({
    title: "Candidates",
    source: "x402",
    result: { people: [{ name: "Grace Hopper", company: "US Navy", socials: { linkedin: "https://linkedin.com/in/grace" } }] },
  });
  const serviceArtifact = buildToolResultArtifact({
    title: "Services",
    source: "x402",
    result: { services: [{ name: "Market Data", description: "Prices and order books", category: "crypto" }] },
  });

  assert.equal(peopleArtifact.blocks[0].type, "cards");
  assert.deepEqual(peopleArtifact.blocks[0].items[0].links, [
    { label: "Linkedin", url: "https://linkedin.com/in/grace" },
  ]);
  assert.equal(serviceArtifact.blocks[0].type, "table");
});

test("turns arbitrary Coinbase record arrays into a grounded table artifact", () => {
  const result = {
    orders: [
      { product_id: "HYPE-USD", side: "BUY", status: "OPEN", limit_price: "55.20" },
      { product_id: "BTC-USD", side: "SELL", status: "FILLED", limit_price: "64000" },
    ],
    cursor: "next-page",
  };

  const artifact = buildToolResultArtifact({
    title: "Coinbase orders list",
    source: "Coinbase",
    result,
  });

  assert.equal(artifact.blocks.some((block) => block.type === "table"), true);
  assert.equal(artifact.blocks.some((block) => block.type === "key_value"), true);
  assert.deepEqual(artifactSpecSchema.parse(artifact), artifact);
});

test("unwraps structured and text MCP results before building an artifact", () => {
  assert.deepEqual(unwrapToolResult({ structuredContent: { value: 12 } }), { value: 12 });
  assert.deepEqual(unwrapToolResult({ structuredContent: [] }), []);
  assert.equal(classifyX402Result("fetch", { structuredContent: [] }).empty, true);
  assert.deepEqual(unwrapToolResult({
    content: [{ type: "text", text: JSON.stringify({ records: [{ asset: "SOL", score: 8 }] }) }],
  }), { records: [{ asset: "SOL", score: 8 }] });
});

test("builds a decision-useful smart-money artifact from the paid Nansen result", () => {
  const artifact = buildSmartMoneyArtifact({
    source: "Nansen Smart Money Perp Trades",
    symbol: "HYPE",
    tradeCount: 2,
    bullishActivityUsd: 125_000,
    bearishActivityUsd: 45_000,
    netBiasUsd: 80_000,
    lean: "bullish",
    payment: { amount: "0.05", currency: "USDC" },
    topTrades: [
      {
        traderLabel: "Smart Trader",
        side: "Long",
        action: "Add",
        valueUsd: 100_000,
        signal: "bullish",
        timestamp: "2026-08-19T12:00:00Z",
      },
    ],
  });

  assert.match(artifact.title, /HYPE/);
  assert.equal(artifact.blocks[0].type, "metrics");
  assert.equal(artifact.blocks.some((block) => block.type === "table"), true);
  assert.equal(artifact.blocks.some((block) => block.type === "chart"), false);
  const tradeTable = artifact.blocks.find((block) => block.type === "table");
  assert.equal(tradeTable.rows[0][4], "Bullish");
  assert.match(tradeTable.rows[0][5], /Aug 19/);
  assert.deepEqual(artifactSpecSchema.parse(artifact), artifact);
});

test("always returns at least one visible block for scalar and empty results", () => {
  for (const result of ["completed", {}, []]) {
    const artifact = buildToolResultArtifact({ title: "Tool result", source: "Live API", result });
    assert.ok(artifact.blocks.length > 0);
    assert.deepEqual(artifactSpecSchema.parse(artifact), artifact);
  }
});

test("preserves scalar entries in mixed arrays instead of silently dropping them", () => {
  const artifact = buildToolResultArtifact({
    title: "Mixed result",
    source: "Live API",
    result: [{ asset: "SOL", score: 8 }, "unclassified"],
  });

  assert.equal(artifact.blocks[0].type, "list");
  assert.equal(artifact.blocks[0].items.length, 2);
});

test("does not turn missing smart-money values into invented zero activity", () => {
  const artifact = buildSmartMoneyArtifact({ symbol: "SOL", lean: "mixed", topTrades: [] });
  const metrics = artifact.blocks.find((block) => block.type === "metrics");

  assert.equal(metrics.items.find((item) => item.label === "Bullish activity").value, "—");
  assert.equal(artifact.blocks.some((block) => block.type === "chart"), false);
  assert.deepEqual(artifactSpecSchema.parse(artifact), artifact);
});
