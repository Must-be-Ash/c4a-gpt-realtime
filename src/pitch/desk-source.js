// Read-only view of the desk (its-the-desk) Neon database: the idea source for
// outbound pitch calls. The trigger is a desk trader opening a new long, i.e.
// the desk put (simulated) money behind the idea. We only ever SELECT, through
// a SELECT-only role (DESK_DATABASE_URL), from ledger / theses / identity.
//
// Every call fails soft: a DB problem means "skip this scan", never a crash.

import postgres from "postgres";

const num = (value) => (value == null ? null : Number(value));

function toIdea(row) {
  return {
    ledgerId: String(row.ledger_id),
    agentId: row.owner_agent,
    traderName: row.trader_name || row.owner_agent,
    symbol: row.symbol,
    name: row.name || null,
    deskSize: num(row.size),
    entry: num(row.entry_price),
    stop: num(row.stop),
    target: num(row.target),
    openedAt: new Date(row.opened_at).toISOString(),
    thesis: row.thesis_id == null ? null : {
      id: String(row.thesis_id),
      title: row.title,
      stance: row.stance,
      summary: row.summary,
      body: row.body,
      interpretation: row.interpretation,
      keyPoints: row.key_points || [],
      sources: Array.isArray(row.sources) ? row.sources : [],
      conviction: num(row.conviction),
      publishedAt: row.thesis_ts ? new Date(row.thesis_ts).toISOString() : null,
    },
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.url]   SELECT-only connection string.
 * @param {Function} [opts.sql] Injected postgres tagged-template client (tests).
 * @param {(event:string, data:object)=>void} [opts.log]
 */
export function createDeskSource({ url, sql, log = () => {} } = {}) {
  const client = sql ?? (url
    ? postgres(url, { max: 2, idle_timeout: 30, connect_timeout: 10, connection: { statement_timeout: 5000 } })
    : null);

  async function safely(label, fallback, run) {
    if (!client) return fallback;
    try {
      return await run(client);
    } catch (error) {
      log("pitch.desk.error", { query: label, error: error.message });
      return fallback;
    }
  }

  return {
    get configured() { return Boolean(client); },

    // Open long desk positions opened after `since`, oldest first.
    listNewLongOpens({ since, limit = 50 }) {
      return safely("listNewLongOpens", [], async (db) => {
        const rows = await db`
          select l.id as ledger_id, l.owner_agent, l.symbol, l.name, l.size, l.entry_price,
                 l.stop, l.target, l.opened_at,
                 t.id as thesis_id, t.title, t.stance, t.summary, t.body, t.interpretation,
                 t.key_points, t.sources, t.conviction, t.ts as thesis_ts,
                 i.name as trader_name
          from ledger l
          left join theses t on t.id = l.thesis_id
          left join identity i on i.agent_id = l.owner_agent
          where l.closed_at is null and l.side = 'long' and l.opened_at > ${new Date(since)}
          order by l.opened_at asc
          limit ${limit}`;
        return rows.map(toIdea);
      });
    },

    // Closed-trade record for the credibility line. Computed here, never by an LLM.
    traderRecord(agentId) {
      return safely("traderRecord", null, async (db) => {
        const [row] = await db`
          select count(*)::int as closed,
                 count(*) filter (where realized_pnl > 0)::int as wins,
                 coalesce(sum(realized_pnl), 0)::float as realized_pnl
          from ledger
          where owner_agent = ${agentId} and closed_at is not null`;
        const closed = row?.closed ?? 0;
        return {
          closedTrades: closed,
          wins: row?.wins ?? 0,
          hitRatePct: closed ? Math.round((row.wins / closed) * 100) : null,
          realizedPnlUsd: Math.round(row?.realized_pnl ?? 0),
        };
      });
    },

    // Re-checked right before dialing. Unknown (DB error) counts as not open.
    isStillOpen(ledgerId) {
      return safely("isStillOpen", false, async (db) => {
        const rows = await db`select 1 from ledger where id = ${ledgerId} and closed_at is null`;
        return rows.length > 0;
      });
    },

    async close() {
      if (client?.end) await client.end({ timeout: 5 }).catch(() => {});
    },
  };
}
