import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent sends quote-denominated buys and leaves increment handling to the server", async () => {
  const [instructions, browserTool] = await Promise.all([
    readFile(new URL("../AGENT.md", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  for (const content of [instructions, browserTool]) {
    assert.match(content, /quote-currency amount/i);
    assert.match(content, /server/i);
    assert.match(content, /(?:quantiz|increment)/i);
    assert.match(content, /do not (?:calculate|convert).*base size/i);
  }
});

test("agent can discover and safely preview equities and futures", async () => {
  const [instructions, browserTool] = await Promise.all([
    readFile(new URL("../AGENT.md", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  for (const content of [instructions, browserTool]) {
    assert.match(content, /equities/i);
    assert.match(content, /futures/i);
    assert.match(content, /equity_trading_session|equityTradingSession/);
    assert.match(content, /PRE_MARKET/);
    assert.match(content, /whole-share/i);
  }
  assert.match(instructions, /products_(?:list|get)/i);
  assert.match(instructions, /market data.*(?:isn't|is not|unavailable).*equities/is);
  assert.match(browserTool, /baseSize} contracts/);
  assert.match(browserTool, /equityTradingSession\.replaceAll/);
  assert.match(browserTool, /predicted_liquidation_price/);
  assert.match(browserTool, /cryptoProductIdSchema/);
  assert.match(browserTool, /not an equity or futures product/);
});
