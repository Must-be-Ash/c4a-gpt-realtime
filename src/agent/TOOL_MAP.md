# Tool → service map (for the shared server-side registry)

The browser (`public/app.js`) defines the agent's tools; each `execute()` calls a
server REST endpoint. The hosted phone path reuses the **same** endpoints via the
shared registry in `src/agent/tools.js`. This table is the source of truth for M1.

| Tool name | Params (from zod) | Server endpoint | Dashboard effect |
|---|---|---|---|
| `research_crypto` | productId (crypto), focusQuery, timeframe | `POST /api/research` | report (markdown) |
| `search_crypto_news` | productId (crypto), focusQuery, timeframe | `POST /api/news` | report (markdown) |
| `show_polymarket` | productId (crypto) | `POST /api/artifacts/polymarket` | polymarket artifact |
| `show_candle_chart` | productId (crypto) | `POST /api/artifacts/candles` | candles artifact |
| `show_order_book_depth` | productId (crypto) | `POST /api/artifacts/order-book` | depth artifact |
| `check_balance` | — | `GET /api/balance` | balances |
| `check_smart_money` | symbol (ticker) | `POST /api/smart-money` | smart-money artifact |
| `show_derivatives_positioning` | productId (crypto) | `POST /api/artifacts/derivatives-positioning` | derivatives artifact (`spec`) |
| `show_position_risk` | — | `POST /api/artifacts/position-risk` | portfolio-risk artifact (`spec`) |
| `show_trade_impact` | productId (crypto), quoteSize | `POST /api/artifacts/trade-impact` | trade-impact artifact (`spec`) |
| `show_onchain_flows` | productId (crypto), chain?, tokenAddress? | `POST /api/artifacts/onchain-flows` | onchain-flows artifact (`spec`) |
| `show_catalyst_calendar` | productId (crypto), horizonDays | `POST /api/artifacts/catalysts` | catalysts artifact (`spec`) |
| `present_artifact` | artifactSpecSchema | (no endpoint; render spec) | generic artifact |
| `use_agentcash` | toolName, arguments, intent | `POST /api/agentcash/call` (+ `/api/agentcash/tools`, `/api/orthogonal/discover`) | tool result |
| `use_orthogonal_catalog` | action, arguments | `POST /api/orthogonal/discover` | internal (no display) |
| `preview_order` | productId, side, type, amount, amountType, limitPrice?, stopPrice?, stopDirection?, equityTradingSession? | `POST /api/orders/preview` | trade preview |
| `execute_order` | previewId (uuid) | `POST /api/orders/execute` | trade execution |
| dynamic `coinbase_*` | from `/api/coinbase/tools` | `POST /api/coinbase/call` | tool result |

## Shared schema fragments (from `public/app.js`)
- **cryptoProductIdSchema**: `^[A-Z0-9]{2,15}-(?:USD|USDC)$`, not `-CDE`. e.g. `BTC-USD`.
- **productIdSchema** (orders): `^[A-Z0-9]+(?:-[A-Z0-9]+)+$`, max 64. e.g. `AAPL-USD`, `BIT-28AUG26-CDE`.
- **newsFocusSchema**: string 3–500.
- **newsTimeframeSchema**: `today | yesterday | today_and_yesterday | last_7_days | last_30_days`.

## Registry design (M1)
`buildToolRegistry({ baseUrl, fetchImpl })` returns:
- `definitions`: `[{ name, description, parameters (JSON schema) }]` for the Vapi assistant.
- `execute(name, args, ctx)`: runs the tool. For data/artifact tools it calls the
  endpoint over local HTTP (`baseUrl` = `http://127.0.0.1:${PORT}`), emits any
  artifact/report to `ctx.emit(...)` (dashboard), and returns a compact string for
  the realtime model to speak. Endpoints stay the single source of validation.
- Static tools carry hand-written JSON schemas (mirroring the zod above). Dynamic
  Coinbase (and AgentCash router) tools are fetched at build time from their
  discovery endpoints and appended.

## AgentCash wallet in prod (M8)
AgentCash MCP reads a **wallet file** at `~/.agentcash/wallet.json` (EVM:
`privateKey`,`address`) and `~/.agentcash/solana-wallet.json` — **not** the
`SOLANA_*`/`ETH_*` env vars. Prod plan: stage the wallet file contents as Fly
secrets and have the container entrypoint write them to `~/.agentcash/` before the
server starts.

## Persistence decision (M6)
Use **JSONL on the Fly volume** (`runtime/calls/<callId>.jsonl` + an index file) —
zero native modules, clean Docker build, sufficient for single-user history/replay.
