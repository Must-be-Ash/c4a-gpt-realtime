import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the voice agent presents otherwise-unrendered tool results without duplicating specialized artifacts", async () => {
  const [instructions, browserTools] = await Promise.all([
    readFile(new URL("../AGENT.md", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  for (const content of [instructions, browserTools]) {
    assert.match(content, /present_artifact/);
    assert.match(content, /tool result/i);
  }
  assert.match(instructions, /do not.*duplicat/i);
  assert.match(instructions, /only.*returned/i);
  assert.match(browserTools, /buildSmartMoneyArtifact/);
  assert.match(browserTools, /const balanceTool[\s\S]*?displayToolResult/);
  assert.match(browserTools, /const smartMoneyTool[\s\S]*?displayToolResult/);
  assert.match(browserTools, /async function loadAgentCashTool[\s\S]*?displayToolResult/);
  assert.match(browserTools, /function loadCoinbaseTools[\s\S]*?displayToolResult/);
  assert.match(instructions, /automatically.*display/i);
});

test("routes long-short requests directly and keeps AgentCash navigation internal", async () => {
  const instructions = await readFile(new URL("../AGENT.md", import.meta.url), "utf8");

  assert.match(instructions, /longs? versus shorts?[\s\S]*check_smart_money/i);
  assert.match(instructions, /available services[\s\S]*present_artifact[\s\S]*list/i);
  assert.match(instructions, /discover the origin[\s\S]*check the exact endpoint schema[\s\S]*fetch/i);
  assert.match(instructions, /stableenrich\.dev/i);
});
