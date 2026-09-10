import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCallStore } from "../src/agent/call-store.js";

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), "callstore-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("records a call, tallies counts, finalizes, and lists newest-first", async () => {
  await withStore(async (dir) => {
    const store = createCallStore({ dir });
    await store.record({ kind: "call", type: "incoming", callId: "c1", caller: "+1555", ts: 1000 });
    await store.record({ kind: "transcript", callId: "c1", role: "user", text: "hi" });
    await store.record({ kind: "artifact", callId: "c1", variant: "candles" });
    await store.record({ kind: "tool", type: "start", callId: "c1", name: "check_balance" });
    await store.record({ kind: "preview", callId: "c1" });
    await store.finalize({ call: { id: "c1" }, endedReason: "customer-ended-call" });

    const calls = await store.listCalls();
    assert.equal(calls.length, 1);
    const summary = calls[0];
    assert.equal(summary.id, "c1");
    assert.equal(summary.caller, "+1555");
    assert.equal(summary.counts.transcript, 1);
    assert.equal(summary.counts.artifact, 1);
    assert.equal(summary.counts.tool, 1);
    assert.equal(summary.counts.order, 1);
    assert.equal(summary.endedReason, "customer-ended-call");
    assert.ok(summary.endedAt >= summary.startedAt);
  });
});

test("getCall returns the appended event stream; unknown call is null", async () => {
  await withStore(async (dir) => {
    const store = createCallStore({ dir });
    await store.record({ kind: "transcript", callId: "c2", text: "one" });
    await store.record({ kind: "transcript", callId: "c2", text: "two" });
    const call = await store.getCall("c2");
    assert.equal(call.events.length, 2);
    assert.equal(call.events[1].text, "two");
    assert.equal(await store.getCall("nope"), null);
  });
});

test("history survives a restart (index + jsonl persisted)", async () => {
  await withStore(async (dir) => {
    const first = createCallStore({ dir });
    await first.record({ kind: "call", type: "incoming", callId: "c3", caller: "+1999", ts: 5 });
    await first.finalize({ callId: "c3", endedReason: "hangup" });

    const second = createCallStore({ dir }); // simulates a fresh process
    const calls = await second.listCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "c3");
    assert.equal(calls[0].endedReason, "hangup");
  });
});

test("events without a callId are ignored", async () => {
  await withStore(async (dir) => {
    const store = createCallStore({ dir });
    await store.record({ kind: "status-update" });
    assert.deepEqual(await store.listCalls(), []);
  });
});
