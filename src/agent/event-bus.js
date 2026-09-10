// In-process pub/sub for live dashboard updates. The Vapi webhook and tool
// registry publish call events here; the /api/stream SSE endpoint fans them to
// connected dashboards. A ring buffer supports Last-Event-ID reconnection.

import { EventEmitter } from "node:events";

export function createEventBus({ bufferSize = 1000 } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  let nextId = 1;
  const buffer = [];
  let currentCallId = null;

  function publish(event = {}) {
    const enriched = { ...event, id: nextId++, ts: event.at ?? Date.now() };
    // Track the active call so a freshly-connected dashboard knows what's live.
    if (event.callId) {
      if (event.kind === "call" && event.type === "incoming") currentCallId = event.callId;
      if (event.kind === "end-of-call-report" && currentCallId === event.callId) currentCallId = null;
    }
    buffer.push(enriched);
    if (buffer.length > bufferSize) buffer.shift();
    emitter.emit("event", enriched);
    return enriched;
  }

  // Buffered events with id strictly greater than sinceId (for SSE replay).
  function since(sinceId) {
    const threshold = Number(sinceId) || 0;
    if (!threshold) return [];
    return buffer.filter((event) => event.id > threshold);
  }

  function subscribe(listener) {
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  }

  return {
    publish,
    subscribe,
    since,
    snapshot: () => buffer.slice(),
    get currentCallId() { return currentCallId; },
    get lastId() { return nextId - 1; },
  };
}
