import assert from "node:assert/strict";
import test from "node:test";

import { tool } from "@openai/agents/realtime";
import { artifactSpecSchema } from "../src/shared/artifact-schema.js";

const example = {
  title: "Account snapshot",
  subtitle: "Live Coinbase result",
  source: "Coinbase",
  blocks: [
    {
      type: "metrics",
      title: "Balances",
      items: [{ label: "USDC available", value: "$42.10", detail: null, tone: "positive" }],
    },
    {
      type: "table",
      title: "Recent fills",
      columns: ["Market", "Side", "Amount"],
      rows: [["HYPE-USD", "BUY", "$15.00"]],
    },
    {
      type: "list",
      title: "Highlights",
      items: [{ title: "One fill", detail: "Completed", tag: "filled", tone: "neutral" }],
    },
    {
      type: "key_value",
      title: "Details",
      items: [{ label: "Portfolio", value: "Default" }],
    },
    {
      type: "text",
      title: "Summary",
      body: "The returned Coinbase data shows one completed fill.",
      tone: "neutral",
    },
    {
      type: "links",
      title: "Sources",
      items: [{ label: "Coinbase", url: "https://www.coinbase.com", detail: null }],
    },
    {
      type: "cards",
      title: "Candidates",
      items: [{
        title: "Ada Lovelace",
        subtitle: "Protocol engineer",
        detail: "Built production trading infrastructure.",
        imageUrl: "https://example.com/ada.jpg",
        links: [
          { label: "Email", url: "mailto:ada@example.com" },
          { label: "LinkedIn", url: "https://linkedin.com/in/ada" },
        ],
      }],
    },
    {
      type: "chart",
      title: "Balance history",
      chartType: "line",
      xLabel: "Date",
      yLabel: "USD",
      series: [{
        name: "Balance",
        tone: "positive",
        points: [{ label: "Aug 18", value: 40 }, { label: "Aug 19", value: 42.1 }],
      }],
    },
  ],
};

test("the generic artifact schema accepts the supported visual vocabulary", () => {
  assert.deepEqual(artifactSpecSchema.parse(example), example);
});

test("the generic artifact schema can register as a strict Realtime tool", () => {
  assert.doesNotThrow(() => tool({
    name: "present_artifact",
    description: "Present grounded tool results.",
    parameters: artifactSpecSchema,
    execute: async () => "{}",
  }));
});

test("the generic artifact schema rejects unsafe source links", () => {
  const invalid = structuredClone(example);
  invalid.blocks[5].items[0].url = "javascript:alert(1)";
  assert.equal(artifactSpecSchema.safeParse(invalid).success, false);
});
