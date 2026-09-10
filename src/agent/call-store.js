// Lightweight call history store (JSONL — no native deps, clean Docker build).
// Each call's events stream to runtime/calls/<callId>.jsonl; a summary index
// lives in runtime/calls/index.json for the dashboard's history/replay.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);

export function createCallStore({ dir }) {
  const indexPath = join(dir, "index.json");
  let index = [];
  const byId = new Map();

  const ready = (async () => {
    await mkdir(dir, { recursive: true });
    try {
      index = JSON.parse(await readFile(indexPath, "utf8"));
      for (const summary of index) byId.set(summary.id, summary);
    } catch {
      index = [];
    }
  })();

  const persistIndex = () => writeFile(indexPath, JSON.stringify(index, null, 2)).catch(() => {});

  function summaryFor(callId) {
    let summary = byId.get(callId);
    if (!summary) {
      summary = {
        id: callId,
        caller: null,
        startedAt: Date.now(),
        endedAt: null,
        endedReason: null,
        counts: { transcript: 0, artifact: 0, tool: 0, order: 0 },
      };
      byId.set(callId, summary);
      index.push(summary);
    }
    return summary;
  }

  async function record(event) {
    await ready;
    if (!event?.callId) return;
    const summary = summaryFor(event.callId);
    if (event.kind === "call" && event.type === "incoming") {
      summary.caller = event.caller ?? summary.caller;
      summary.startedAt = event.ts ?? summary.startedAt;
    }
    if (event.kind === "transcript") summary.counts.transcript += 1;
    else if (event.kind === "artifact" || event.kind === "report") summary.counts.artifact += 1;
    else if (event.kind === "tool" && event.type === "start") summary.counts.tool += 1;
    else if (event.kind === "preview" || event.kind === "execution") summary.counts.order += 1;

    await appendFile(join(dir, `${safeId(event.callId)}.jsonl`), `${JSON.stringify(event)}\n`).catch(() => {});
    if (event.kind === "call" && event.type === "incoming") await persistIndex();
  }

  async function finalize(report) {
    await ready;
    const callId = report?.call?.id ?? report?.callId;
    if (!callId) return;
    const summary = summaryFor(callId);
    summary.endedAt = Date.now();
    summary.endedReason = report?.endedReason ?? null;
    await persistIndex();
  }

  async function listCalls() {
    await ready;
    return [...index].reverse(); // newest first
  }

  async function getCall(id) {
    await ready;
    try {
      const raw = await readFile(join(dir, `${safeId(id)}.jsonl`), "utf8");
      const events = raw.split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      return { summary: byId.get(id) ?? null, events };
    } catch {
      return null;
    }
  }

  return { record, finalize, listCalls, getCall, ready };
}
