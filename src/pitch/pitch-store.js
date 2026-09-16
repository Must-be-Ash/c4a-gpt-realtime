// Pitch records + scheduler state, persisted as one JSON file on the Fly volume
// (runtime/pitches.json). Small by design: we keep the last 200 pitches.
//
// status: queued | skipped | dry_run | dialing | in_call | voicemail |
//         no_answer | declined | bought | no_decision | failed | expired

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { etDateKey } from "./market-hours.js";

const MAX_PITCHES = 200;
const UNRESOLVED = new Set(["voicemail", "no_answer", "no_decision"]);
const NOT_PITCHED = new Set(["skipped", "dry_run", "failed"]);
const CALLBACK_WINDOW_MS = 24 * 3_600_000;

export function createPitchStore({ dir, now = () => Date.now() }) {
  const filePath = join(dir, "pitches.json");
  let state = { lastDialAt: null, dials: {}, pitches: [] };
  let writing = Promise.resolve();

  const ready = (async () => {
    await mkdir(dir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(filePath, "utf8"));
      state = { ...state, ...saved, pitches: Array.isArray(saved.pitches) ? saved.pitches : [] };
    } catch {
      /* first boot */
    }
  })();

  function persist() {
    // Serialize writes; atomic rename so a crash never leaves half a file.
    writing = writing.then(async () => {
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2));
      await rename(tmp, filePath);
    }).catch(() => {});
    return writing;
  }

  const find = (id) => state.pitches.find((p) => p.id === id) ?? null;

  return {
    ready,

    async hasPitched(ledgerId) {
      await ready;
      // Dry runs and failed dials don't use up the idea.
      return state.pitches.some((p) => p.deskLedgerId === String(ledgerId) && !NOT_PITCHED.has(p.status));
    },

    async lastPitchOfSymbol(symbol) {
      await ready;
      const hits = state.pitches.filter((p) => p.symbol === symbol && p.calledAt).map((p) => Date.parse(p.calledAt));
      return hits.length ? Math.max(...hits) : null;
    },

    async dialState() {
      await ready;
      return { callsToday: state.dials[etDateKey(now())] ?? 0, lastDialAt: state.lastDialAt };
    },

    // Count a dial against today's cap (voicemails count too).
    async recordDial() {
      await ready;
      const key = etDateKey(now());
      state.dials = { [key]: (state.dials[key] ?? 0) + 1 };
      state.lastDialAt = now();
      await persist();
    },

    async create(fields) {
      await ready;
      const pitch = {
        id: randomUUID(),
        createdAt: new Date(now()).toISOString(),
        status: "queued",
        reasons: [],
        calledAt: null,
        vapiCallId: null,
        outcome: null,
        orderId: null,
        ...fields,
      };
      state.pitches.push(pitch);
      if (state.pitches.length > MAX_PITCHES) state.pitches = state.pitches.slice(-MAX_PITCHES);
      await persist();
      return pitch;
    },

    async update(id, patch) {
      await ready;
      const pitch = find(id);
      if (!pitch) return null;
      Object.assign(pitch, patch, { updatedAt: new Date(now()).toISOString() });
      await persist();
      return pitch;
    },

    async get(id) { await ready; return find(id); },

    async byCallId(callId) {
      await ready;
      return callId ? state.pitches.find((p) => p.vapiCallId === callId) ?? null : null;
    },

    // Inbound callbacks on the pitch number are linked to the pitch they resumed.
    async byCallbackId(callId) {
      await ready;
      return callId ? state.pitches.find((p) => (p.callbackCallIds ?? []).includes(callId)) ?? null : null;
    },

    // Latest pitch the owner hasn't decided on, from the last 24h (callbacks).
    async latestUnresolved() {
      await ready;
      const cutoff = now() - CALLBACK_WINDOW_MS;
      return [...state.pitches].reverse().find((p) => UNRESOLVED.has(p.status) && Date.parse(p.calledAt ?? p.createdAt) >= cutoff) ?? null;
    },

    async list({ limit = 50 } = {}) {
      await ready;
      return state.pitches.slice(-limit).reverse();
    },

    // What Jordan gets from get_active_pitch: the brief, minus bulky source text.
    briefForAgent(pitch) {
      const vars = pitch.vapi?.variableValues ?? {};
      return { asset: vars.asset, productId: pitch.productId, status: pitch.status, calledAt: pitch.calledAt, ...vars };
    },
  };
}
