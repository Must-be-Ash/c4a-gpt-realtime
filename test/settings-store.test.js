import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { agentCatalog, createSettingsStore } from "../src/agent/settings-store.js";

const freshDir = () => mkdtemp(join(tmpdir(), "settings-"));

test("defaults to gpt-realtime-2.1 when nothing is saved", async () => {
  const store = createSettingsStore({ dir: await freshDir() });
  assert.deepEqual(await store.get(), { activeSipAgent: "gpt-realtime-2.1", selectedAgent: "gpt-realtime-2.1", pitchPaused: false });
});

test("env default is honored only if it is a SIP agent", async () => {
  assert.equal((await createSettingsStore({ dir: await freshDir(), defaultSipAgent: "gpt-live-1" }).get()).activeSipAgent, "gpt-live-1");
  assert.equal((await createSettingsStore({ dir: await freshDir(), defaultSipAgent: "vapi" }).get()).activeSipAgent, "gpt-realtime-2.1");
});

test("selecting an OpenAI agent arms it; selecting vapi leaves the armed agent alone", async () => {
  const store = createSettingsStore({ dir: await freshDir() });
  assert.deepEqual(await store.select("gpt-live-1"), { activeSipAgent: "gpt-live-1", selectedAgent: "gpt-live-1", pitchPaused: false });
  assert.deepEqual(await store.select("vapi"), { activeSipAgent: "gpt-live-1", selectedAgent: "vapi", pitchPaused: false });
  assert.equal(store.activeSipAgent(), "gpt-live-1");
});

test("persists across a fresh store instance (atomic file write)", async () => {
  const dir = await freshDir();
  await createSettingsStore({ dir }).select("gpt-live-1");
  const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  assert.equal(saved.activeSipAgent, "gpt-live-1");
  const again = createSettingsStore({ dir });
  assert.equal((await again.get()).activeSipAgent, "gpt-live-1");
});

test("pitch pause persists and survives agent selection", async () => {
  const dir = await freshDir();
  const store = createSettingsStore({ dir });
  assert.equal((await store.setPitchPaused(true)).pitchPaused, true);
  assert.equal(store.pitchPaused(), true);
  await store.select("gpt-live-1");
  assert.equal(store.pitchPaused(), true);
  const again = createSettingsStore({ dir });
  assert.equal((await again.get()).pitchPaused, true);
  assert.equal((await again.setPitchPaused(false)).pitchPaused, false);
});

test("rejects unknown agent ids with a 400-style error", async () => {
  const store = createSettingsStore({ dir: await freshDir() });
  await assert.rejects(() => store.select("gpt-5"), (error) => error.status === 400);
});

test("catalog maps the two OpenAI agents to the Telnyx number and Vapi to its own", () => {
  const agents = agentCatalog({ telnyxNumber: "+15550000001", vapiNumber: "+15550000002" });
  assert.equal(agents.length, 3);
  assert.equal(agents.find((a) => a.id === "gpt-live-1").number, "+15550000001");
  assert.equal(agents.find((a) => a.id === "vapi").number, "+15550000002");
  assert.equal(agents.find((a) => a.id === "vapi").armable, false);
});
