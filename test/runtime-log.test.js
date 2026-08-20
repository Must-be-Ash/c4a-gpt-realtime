import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntimeLogger } from "../src/services/runtime-log.js";

test("persists tool diagnostics while redacting credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-log-"));
  const filePath = join(directory, "events.jsonl");
  const logger = createRuntimeLogger({ filePath, consoleWriter: () => {} });

  logger.log("agentcash.tool.completed", {
    toolName: "fetch",
    arguments: { url: "https://example.com", authorization: "Bearer secret" },
    result: { ok: false, privateKey: "do-not-log", message: "failed" },
  });
  await logger.flush();

  const entry = JSON.parse((await readFile(filePath, "utf8")).trim());
  assert.equal(entry.event, "agentcash.tool.completed");
  assert.equal(entry.arguments.url, "https://example.com");
  assert.equal(entry.arguments.authorization, "[REDACTED]");
  assert.equal(entry.result.privateKey, "[REDACTED]");
  await rm(directory, { recursive: true, force: true });
});
