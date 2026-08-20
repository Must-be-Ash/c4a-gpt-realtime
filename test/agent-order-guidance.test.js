import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent sends dollar-denominated buys and leaves increment handling to the server", async () => {
  const [instructions, browserTool] = await Promise.all([
    readFile(new URL("../AGENT.md", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  for (const content of [instructions, browserTool]) {
    assert.match(content, /every BUY amount is (?:in )?dollars/i);
    assert.match(content, /server/i);
    assert.match(content, /(?:quantiz|increment)/i);
    assert.match(content, /do not (?:calculate|convert).*base size/i);
  }
});
