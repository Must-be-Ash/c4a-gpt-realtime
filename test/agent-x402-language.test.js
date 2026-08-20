import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("agent-facing paid tools use AgentCash while keeping Sponge disconnected", async () => {
  const [instructions, browserTool, server] = await Promise.all([
    readFile(new URL("../AGENT.md", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(instructions, /sponge/i);
  assert.doesNotMatch(browserTool, /sponge/i);
  assert.match(instructions, /use_agentcash/);
  assert.match(browserTool, /name: "use_agentcash"/);
  assert.match(browserTool, /\/api\/agentcash\/tools/);
  assert.match(browserTool, /\/api\/agentcash\/call/);
  assert.match(server, /createAgentCashMcpClient/);
  assert.match(server, /createSpongeMcpClient/);
  assert.match(instructions, /Never use Coinbase for paid endpoints/);
  assert.match(instructions, /Never repeat an identical failed fetch/);
  assert.match(instructions, /materially different attempts/);
  assert.match(instructions, /different suitable endpoint\/provider/);
  assert.match(instructions, /keep intermediate failures internal/);
  assert.doesNotMatch(browserTool, /coinbase_x402/);
});
