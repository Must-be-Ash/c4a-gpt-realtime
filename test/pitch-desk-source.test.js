import assert from "node:assert/strict";
import test from "node:test";

import { createDeskSource } from "../src/pitch/desk-source.js";

// Fake postgres tagged-template client: routes by query text.
function fakeSql(handlers) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join("?");
    calls.push({ text, values });
    for (const [pattern, handler] of handlers) {
      if (pattern.test(text)) return Promise.resolve(handler(values));
    }
    return Promise.reject(new Error(`unexpected query: ${text}`));
  };
  sql.calls = calls;
  return sql;
}

const row = {
  ledger_id: "34", owner_agent: "nadia", trader_name: "Mara Voss", symbol: "NKE", name: "Nike",
  size: "5000", entry_price: "36.96", stop: "34.9", target: "40.5", opened_at: "2026-09-10T13:30:29.016Z",
  thesis_id: "50", title: "NKE: buy the flush", stance: "bullish", summary: "s", body: "b", interpretation: "i",
  key_points: ["k1"], sources: [{ url: "https://x", title: "t", source: "reuters.com" }], conviction: 7,
  thesis_ts: "2026-09-10T13:30:00Z",
};

test("listNewLongOpens maps rows to ideas with numbers and thesis", async () => {
  const sql = fakeSql([[/from ledger l/, () => [row]]]);
  const desk = createDeskSource({ sql });
  const [idea] = await desk.listNewLongOpens({ since: 0 });
  assert.equal(idea.ledgerId, "34");
  assert.equal(idea.traderName, "Mara Voss");
  assert.equal(idea.entry, 36.96);
  assert.equal(idea.stop, 34.9);
  assert.equal(idea.target, 40.5);
  assert.equal(idea.thesis.conviction, 7);
  assert.equal(idea.thesis.sources[0].source, "reuters.com");
  assert.match(sql.calls[0].text, /side = 'long'/);
  assert.match(sql.calls[0].text, /closed_at is null/);
});

test("ideas without a linked thesis keep thesis null", async () => {
  const desk = createDeskSource({ sql: fakeSql([[/from ledger l/, () => [{ ...row, thesis_id: null, trader_name: null }]]]) });
  const [idea] = await desk.listNewLongOpens({ since: 0 });
  assert.equal(idea.thesis, null);
  assert.equal(idea.traderName, "nadia");
});

test("traderRecord computes hit rate in code", async () => {
  const desk = createDeskSource({ sql: fakeSql([[/filter \(where realized_pnl > 0\)/, () => [{ closed: 4, wins: 3, realized_pnl: 812.4 }]]]) });
  assert.deepEqual(await desk.traderRecord("nadia"), { closedTrades: 4, wins: 3, hitRatePct: 75, realizedPnlUsd: 812 });
});

test("traderRecord with no closed trades has null hit rate", async () => {
  const desk = createDeskSource({ sql: fakeSql([[/realized_pnl/, () => [{ closed: 0, wins: 0, realized_pnl: 0 }]]]) });
  assert.equal((await desk.traderRecord("x")).hitRatePct, null);
});

test("isStillOpen reflects the ledger", async () => {
  const desk = createDeskSource({ sql: fakeSql([[/select 1 from ledger/, ([id]) => (id === "34" ? [{ "?column?": 1 }] : [])]]) });
  assert.equal(await desk.isStillOpen("34"), true);
  assert.equal(await desk.isStillOpen("35"), false);
});

test("DB failures fail soft and are logged", async () => {
  const logged = [];
  const desk = createDeskSource({ sql: fakeSql([]), log: (event, data) => logged.push({ event, data }) });
  assert.deepEqual(await desk.listNewLongOpens({ since: 0 }), []);
  assert.equal(await desk.traderRecord("x"), null);
  assert.equal(await desk.isStillOpen("1"), false);
  assert.equal(logged.length, 3);
  assert.equal(logged[0].event, "pitch.desk.error");
});

test("unconfigured source returns empty results", async () => {
  const desk = createDeskSource({});
  assert.equal(desk.configured, false);
  assert.deepEqual(await desk.listNewLongOpens({ since: 0 }), []);
});
