import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("voice guidance routes each trader insight explicitly without bundling unrelated tools", async () => {
  const [instructions, browser] = await Promise.all([
    readFile(new URL("../AGENT.md", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  for (const name of [
    "show_derivatives_positioning",
    "show_position_risk",
    "show_trade_impact",
    "show_onchain_flows",
    "show_catalyst_calendar",
  ]) {
    assert.match(instructions, new RegExp(name));
    assert.match(browser, new RegExp(`name: ["']${name}["']`));
  }
  assert.match(instructions, /Call only the tools needed for the user's explicit request/i);
  assert.match(instructions, /Never add news, Polymarket, derivatives, on-chain flows, catalysts, or portfolio analysis/i);
});
