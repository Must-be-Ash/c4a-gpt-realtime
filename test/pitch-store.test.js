import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPitchStore } from "../src/pitch/pitch-store.js";

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "pitchstore-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("create, update, lookups and persistence across restarts", async () => {
  await withDir(async (dir) => {
    let clock = Date.parse("2026-09-16T15:00:00Z");
    const store = createPitchStore({ dir, now: () => clock });
    const p = await store.create({ deskLedgerId: "34", symbol: "NKE", productId: "NKE-USD" });
    assert.equal(p.status, "queued");
    assert.equal(await store.hasPitched("34"), true);
    assert.equal(await store.hasPitched("35"), false);
    assert.equal(await store.lastPitchOfSymbol("NKE"), null); // never dialed

    await store.update(p.id, { status: "in_call", vapiCallId: "call-1", calledAt: new Date(clock).toISOString() });
    assert.equal((await store.byCallId("call-1")).id, p.id);
    assert.equal(await store.lastPitchOfSymbol("NKE"), clock);

    await store.recordDial();
    clock += 60_000;
    await store.recordDial();
    assert.deepEqual(await store.dialState(), { callsToday: 2, lastDialAt: clock });

    const reopened = createPitchStore({ dir, now: () => clock });
    assert.equal((await reopened.get(p.id)).vapiCallId, "call-1");
    assert.equal((await reopened.dialState()).callsToday, 2);
    JSON.parse(await readFile(join(dir, "pitches.json"), "utf8"));
  });
});

test("daily dial count resets on a new ET day", async () => {
  await withDir(async (dir) => {
    let clock = Date.parse("2026-09-16T20:00:00Z"); // 16:00 ET
    const store = createPitchStore({ dir, now: () => clock });
    await store.recordDial();
    await store.recordDial();
    clock = Date.parse("2026-09-17T03:59:00Z"); // 23:59 ET same day
    assert.equal((await store.dialState()).callsToday, 2);
    clock = Date.parse("2026-09-17T04:01:00Z"); // 00:01 ET next day
    assert.equal((await store.dialState()).callsToday, 0);
  });
});

test("latestUnresolved returns the newest undecided pitch within 24h", async () => {
  await withDir(async (dir) => {
    let clock = Date.parse("2026-09-16T15:00:00Z");
    const store = createPitchStore({ dir, now: () => clock });
    const at = (ms) => new Date(ms).toISOString();
    const a = await store.create({ symbol: "A", status: "voicemail", calledAt: at(clock - 3_600_000) });
    await store.create({ symbol: "B", status: "declined", calledAt: at(clock - 60_000) });
    assert.equal((await store.latestUnresolved()).id, a.id);
    const c = await store.create({ symbol: "C", status: "no_decision", calledAt: at(clock - 30_000) });
    assert.equal((await store.latestUnresolved()).id, c.id);
    clock += 25 * 3_600_000;
    assert.equal(await store.latestUnresolved(), null);
  });
});

test("briefForAgent flattens the rendered variables", async () => {
  await withDir(async (dir) => {
    const store = createPitchStore({ dir });
    const p = await store.create({ productId: "NKE-USD", vapi: { variableValues: { asset: "Nike", hook: "h" } } });
    assert.deepEqual(store.briefForAgent(p), { asset: "Nike", productId: "NKE-USD", status: "queued", calledAt: null, hook: "h" });
  });
});
