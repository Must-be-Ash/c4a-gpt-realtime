import assert from "node:assert/strict";
import test from "node:test";

import { createEventBus } from "../src/agent/event-bus.js";

test("publish assigns increasing ids and a timestamp", () => {
  const bus = createEventBus();
  const a = bus.publish({ kind: "transcript", text: "hi" });
  const b = bus.publish({ kind: "transcript", text: "there" });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.ok(typeof a.ts === "number");
  assert.equal(bus.lastId, 2);
});

test("since() replays only events after the given id", () => {
  const bus = createEventBus();
  bus.publish({ kind: "a" });
  bus.publish({ kind: "b" });
  bus.publish({ kind: "c" });
  assert.deepEqual(bus.since(1).map((e) => e.kind), ["b", "c"]);
  assert.deepEqual(bus.since(0), []);
  assert.deepEqual(bus.since(3), []);
});

test("subscribers receive live events until they unsubscribe", () => {
  const bus = createEventBus();
  const received = [];
  const off = bus.subscribe((event) => received.push(event.kind));
  bus.publish({ kind: "x" });
  off();
  bus.publish({ kind: "y" });
  assert.deepEqual(received, ["x"]);
});

test("currentCallId tracks incoming and end-of-call", () => {
  const bus = createEventBus();
  assert.equal(bus.currentCallId, null);
  bus.publish({ kind: "call", type: "incoming", callId: "c1" });
  assert.equal(bus.currentCallId, "c1");
  bus.publish({ kind: "end-of-call-report", callId: "c1" });
  assert.equal(bus.currentCallId, null);
});

test("ring buffer is bounded", () => {
  const bus = createEventBus({ bufferSize: 3 });
  for (let i = 0; i < 5; i += 1) bus.publish({ kind: String(i) });
  const snapshot = bus.snapshot();
  assert.equal(snapshot.length, 3);
  assert.deepEqual(snapshot.map((e) => e.kind), ["2", "3", "4"]);
});
