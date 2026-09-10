# Web + Phone Capability — Technical Specification & Build Checklist

**Project:** Add a hosted **web dashboard** and **inbound phone-call** capability to *Coinbase for Agents*, without changing the existing local app.

**Status:** Draft for execution. Work through the checklist top-to-bottom; check items off as they're completed.

---

## 1. Goal (what we're building)

Today the agent only runs **locally in the browser**: you open `localhost:4173/app/`, talk to it over your mic (OpenAI Realtime / WebRTC), and the Node server proxies Coinbase/Exa/AgentCash.

We are **adding a new capability** so that, without being at your laptop:

1. You can **phone a number and have a real-time, two-way voice conversation** with your agent (inbound), including placing real trades after spoken confirmation.
2. You can **visit a private website** and watch, in real time, what the agent is saying/doing on a call — transcripts, charts/artifacts, order previews, and portfolio — as a **read-only viewer**.
3. The whole thing runs **hosted on Fly.io**, always-on, reachable from your phone/browser.

### Locked decisions (from planning)

| Decision | Choice |
|---|---|
| Local app | **Unchanged.** Keep browser WebRTC voice + terminal dev flow exactly as-is. New capability is *additive*, in the **same repo**. |
| Web app role | **Read-only viewer** — live transcript, artifacts/charts, portfolio. No browser mic needed for the hosted version. |
| Phone service | **Vapi**, using its **native OpenAI Realtime (speech-to-speech)** mode — same feel as local. |
| Phone brain | **OpenAI Realtime** (`gpt-realtime`), **the same model as local**. Vapi hosts the realtime session; **BYOK OpenAI key** added in Vapi → Integrations → Model Providers → OpenAI. |
| Tools on phone | Registered on the Vapi assistant, **executed via a webhook to our Fly server**, which runs the existing `src/services/*`. |
| Hosting | **Fly.io** (always-on machine; `FLY_API_KEY` in `.env`). |
| Access | **Private.** Website behind a password; phone only answers **your caller ID** (`PHONE_NUMBER`). |
| Phone powers | **Full**, including trade execution after spoken confirmation. |

> **Why speech-to-speech (not a custom text LLM):** Vapi natively integrates OpenAI's Realtime API and its docs confirm **function/tool calling works unchanged** with the realtime model. This keeps the phone experience identical in engine/model to the local app (natural, low-latency speech-to-speech) and lets us reuse every existing tool. The only trade-offs: the brain must be OpenAI Realtime (can't swap in a different text model), and a few Vapi extras are off in realtime mode (knowledge bases, custom voice cloning). Neither matters here. A custom-LLM text pipeline (`/chat/completions` on our server) remains a documented fallback in §8.

---

## 2. Architecture

Both engines use **OpenAI Realtime as the brain** and **the same tool layer**. The only differences are *who hosts the realtime session* and *how tools get executed*.

```
LOCAL (unchanged)                          HOSTED PHONE (new)
─────────────────                          ───────────────────────────────
Browser mic ──WebRTC──► OpenAI Realtime     Your phone ──call──► Vapi
   │  (brain, in browser)                          │   Vapi hosts OpenAI Realtime
   │  tools execute in browser                     │   (BYOK OpenAI key), does
   │  (fetch → local server)                       │   audio in/out speech-to-speech
   ▼                                               ▼
localhost Express server  ◄──── same repo ────►  Fly.io Express server
   │                                               │
   └──────────────► src/services/* ◄───────────────┘  (Coinbase, Exa, AgentCash,
                   (SHARED TOOL LAYER)                  orders, artifacts, research)
                                                   │
                       Vapi tool-call ───────────► /vapi/webhook  (executes tool via
                                                   │   src/services/*, returns result)
                       Vapi transcript/status ───► /vapi/webhook ─► event bus ─► SSE
                                                                    │
                                                        Web dashboard (private viewer)
```

**How a phone call flows:**
1. You call the Vapi number. Vapi hits `/vapi/webhook` with an `assistant-request` → our server checks caller ID against `PHONE_NUMBER` (allowlist) and returns the assistant config (or rejects).
2. Vapi opens an OpenAI Realtime session (your BYOK key), using `AGENT.md` as system instructions and our registered tool list.
3. You talk. When the model calls a tool, Vapi POSTs a `tool-calls` message to `/vapi/webhook`; our server executes it via `src/services/*` and returns the result synchronously; the model speaks the answer.
4. Vapi streams `transcript` / `status-update` / `end-of-call-report` messages to `/vapi/webhook`; we fan them (plus tool activity + artifacts) onto an event bus → SSE → the dashboard.

**What is reused vs. new:**
- **Reused as-is:** every `src/services/*` module, `AGENT.md`, `.env` provider keys, all artifact builders.
- **New:** shared tool registry, `/vapi/webhook` (tool execution + events + caller allowlist), event bus + SSE, dashboard viewer, auth, persistence, Fly deploy config, a Vapi-configuration script.
- **Untouched:** `public/app.js` browser voice path, `/api/realtime-token`, local `npm run dev`.

---

## 3. Guardrails (do not break local)

- [ ] New routes are **additive**; no existing route/behavior changes.
- [ ] New capability gated behind `ENABLE_WEB_PHONE` (default off locally) so `npm run dev` is byte-for-byte the same experience.
- [ ] `npm test` and `npm run check` still pass unchanged before and after each milestone.
- [ ] No secrets committed. New keys go to `.env` (local) and `fly secrets` (prod), and to `.env.example` as **names only**.
- [ ] Local browser voice still works after every milestone (manual smoke test).

---

## 4. Build checklist

### M0 — Prep & inventory ✅
- [x] Confirm the tool inventory the browser exposes (in `public/app.js`): `research_crypto`, `search_crypto_news`, `show_polymarket`, `show_candle_chart`, `show_order_book_depth`, `check_balance`, `check_smart_money`, `show_derivatives_positioning`, `show_position_risk`, `show_trade_impact`, `show_onchain_flows`, `show_catalyst_calendar`, `present_artifact`, `use_agentcash`, `use_orthogonal_catalog`, dynamic `coinbaseTools`, `preview_order`, `execute_order`.
- [x] Map each tool → the server function/route that actually does the work → recorded in **`src/agent/TOOL_MAP.md`**.
- [x] Add new env var names to `.env.example` (see §5).
- [x] Decide persistence + AgentCash-wallet strategy on Fly → **JSONL on Fly volume** (no native deps); **AgentCash uses a wallet file** (`~/.agentcash/wallet.json` + `solana-wallet.json`), staged as Fly secrets and written at container boot. Both recorded in `TOOL_MAP.md`.
- Verified: `npm run check` green (112 tests) — no code changed, local untouched.

### M1 — Shared server-side tool registry ✅
One source of truth for tool definitions, usable by the Vapi webhook (and reusable elsewhere).
- [x] Create `src/agent/tools.js`: `buildToolRegistry({ baseUrl, fetchImpl })` → `{ execute(name,args,ctx), listDefinitions(), staticDefinitions, byName, call }`; `STATIC_TOOLS` holds `{ name, description, parameters (JSON schema), run }` per tool.
- [x] `execute()` reuses the **existing REST endpoints** over local HTTP (`baseUrl` = the app's own origin) — zero refactor risk, endpoints stay the single source of validation. Dynamic `coinbase_*` tools proxy to `/api/coinbase/call`; `listDefinitions()` merges live Coinbase MCP tools for the Vapi assistant.
- [x] JSON schemas hand-written to mirror the zod schemas in `public/app.js`; reused `x402RouterParameters` and `artifactSpecSchema` directly.
- [x] `ctx` carries `emit(event)` (dashboard bus) and is where `channel`/policy will attach; handlers emit `report`/`artifact`/`balance`/`preview`/`execution` events.
- [x] Phone policy: **full powers incl. trades**; `execute_order` runs against a real `previewId` (spoken-confirmation gate applied by the model via AGENT.md + phone addendum in M2), mirroring the web flow.
- [x] Unit tests (`test/agent-tool-registry.test.js`, 6 tests): every schema well-formed, happy-path `execute` returns serializable strings hitting the mapped endpoint, quote→quoteSize mapping, present_artifact validation, dynamic coinbase proxy, unknown-tool + error propagation.
- Verified: `npm run check` green (118 tests).

### M2 — Vapi assistant configuration (speech-to-speech) ✅ (script ready; live run in M9)
No custom brain to build — we configure Vapi's realtime assistant and point its tools at our webhook.
- [x] Wrote `scripts/configure-vapi.mjs` (uses `VAPI_PRIVATE_KEY`; supports `--dry-run`) that PATCHes assistant `VAPI_AGENT_ID` with:
  - `model.provider = "openai"`, `model.model = OPENAI_REALTIME_MODEL` (realtime speech-to-speech).
  - `model.messages = [{ role:"system", content: AGENT.md + phone addendum }]` (spoken style, confirm trades verbally, don't read JSON aloud).
  - realtime-compatible `voice` (validated against alloy/echo/shimmer/marin/cedar; default marin).
  - `model.tools = [...]` from `registry.listDefinitions()` (17 static + live Coinbase MCP), each a `function` tool with `server.url = <PUBLIC_BASE_URL>/vapi/webhook` + secret.
  - assistant-level `server.url/secret` for transcript/status/end-of-call + tool calls; `firstMessage` greeting.
- [x] Routes `VAPI_PHONE_NUMBER` **through the webhook** (sets phone-number `server.url`, clears fixed `assistantId`) so inbound triggers `assistant-request` → caller allowlist. Verified: `node --check` + `--dry-run` prints correct payload (17 tools, realtime model/voice/server).
- [x] Realtime-mode limits noted (no knowledge bases / custom voice cloning; transcripts may differ).
- [ ] **USER ACTION before M9:** In Vapi dashboard → Integrations → Model Providers → OpenAI, add the **BYOK OpenAI key** (realtime billing on your OpenAI account).
- [ ] **Deferred to M9 (needs live deploy):** run `node scripts/configure-vapi.mjs` (no `--dry-run`) so tools resolve against the deployed server and the assistant/number are updated. Note: confirm Vapi accepts `OPENAI_REALTIME_MODEL` (`gpt-realtime-2.1`); fall back to `gpt-realtime-2025-08-28` if rejected.

### M3 — `/vapi/webhook` (single server endpoint) ✅
One authenticated endpoint handling every Vapi message type, branching on `message.type`. Implemented in `src/agent/vapi-webhook.js`, mounted additively in `src/server.js` (gated by `ENABLE_WEB_PHONE`, before the global JSON parser with a 5 MB limit for call reports).
- [x] **Verify** `x-vapi-secret` == `VAPI_WEBHOOK_SECRET` (constant-time compare); reject 401 otherwise. Verified live (wrong secret → 401).
- [x] `assistant-request` → **caller allowlist** (`config.allowedCallers` from `PHONE_NUMBER`): allowed → `{ assistantId }`; else `{ error }`. Verified live (allowed → assistantId, other → error).
- [x] `tool-calls` → run via the M1 registry, return `{ results: [{ toolCallId, result }] }` synchronously; emits tool start/done/error. Verified live end-to-end (`show_candle_chart` → real Coinbase endpoint → spoken result).
- [x] `transcript` (user + assistant) → event bus (role, type, text).
- [x] `status-update`, `speech-update`, `conversation-update`, `hang` → event bus.
- [x] `end-of-call-report` → event bus + `onCallEnd` persistence hook (M6 wires the impl).
- [x] Handled both Vapi tool-call shapes (`toolCallList` / `toolCalls`, string or object args). Unit tests: `test/vapi-webhook.test.js` (6). Verified: `npm run check` green (124 tests); **local unaffected** (route 404s without the flag, `/api/config` still 200).

### M4 — Live event bus + SSE ✅
- [x] `src/agent/event-bus.js`: in-process pub/sub with a bounded ring buffer, monotonic ids, a `currentCallId` pointer, and `since()` replay. Unit tests: `test/event-bus.test.js` (5).
- [x] `GET /api/stream` SSE feed mounted in `server.js` (gated by `ENABLE_WEB_PHONE`; auth wraps it in M7). Streams every call event (transcript, tool activity, artifacts, preview/exec, call lifecycle).
- [x] `/vapi/webhook` publishes to the bus (tool `run(ctx.emit)` events flow through the same `emit`). Verified live: connected to `/api/stream`, fired a webhook transcript, received it with correct `id`/`event`/`data` framing.
- [x] Robustness: 15 s heartbeat pings, `retry: 3000`, and `Last-Event-ID` (+`?lastEventId`) reconnect replay via `since()`.
- [x] Hardened (added during M5): each subscriber's write is isolated so a dead/slow connection self-removes instead of breaking fan-out to other dashboards; fresh mid-call open replays the active call's buffered events (snapshot-on-connect) so the dashboard isn't blank.
- Verified: `npm run check` green (129 tests).

### M5 — Web dashboard (read-only viewer) ✅
Design note (per user): reuse the **existing app aesthetic** (light/dark via `styles.css`), be **artifacts-first**, and show speech as **passing subtitle-style captions**, not a chat log.
- [x] New page under `dashboard/` (served gated at `/dashboard`, outside the local static tree). Header status bar + `#artifacts.artifact-feed` (main) + `#captions` overlay. Idle state message.
- [x] **Factored shared renderers into `public/artifact-render.js`** (candles, order-book depth, polymarket, generic-spec blocks + chart, helpers) — imported by **both** `public/app.js` and the dashboard, so visuals are identical. `app.js` refactored to import them (verified: local app loads clean, no console errors, bundle builds, 129 tests pass). Dashboard also reuses `tool-result-artifact.js` (spec builders) and `caption-window.js` (subtitle trimming).
- [x] Subscribes to `/api/stream`; renders live: candle/depth/polymarket charts, generic-spec artifacts (derivatives, portfolio-risk, trade-impact, on-chain, catalysts, present_artifact), reports, smart-money, balances, trade preview/execution; call status pill; passing captions. Verified live in-browser (BTC candle + Coinbase portfolio-risk metrics rendered from real data, "On call", light mode).
- [x] Reuses the app's theme toggle + `styles.css`; artifacts-first with captions passing along the bottom (subtitles), matching the local app.
- [x] Bundled via esbuild (`dashboard/dashboard.bundle.js`), added to `npm run build`.
- Verified: `npm run check` green (129 tests); local `/app/` unaffected.

### M6 — Persistence (call history) ✅
- [x] `src/agent/call-store.js` — JSONL store (zero native deps): per-call `runtime/calls/<callId>.jsonl` event streams + a `runtime/calls/index.json` summary index (caller, start/end, endedReason, counts). Unit tests: `test/call-store.test.js` (4), incl. restart persistence.
- [x] Every dashboard event is persisted (`emitEvent` → `callStore.record`); `end-of-call-report` finalizes the summary. Fixed a real bug: tool-originated artifact/report/preview events now get the active `callId` stamped by the webhook's `ctx.emit`, so they persist and associate with the call (also fixes snapshot-on-connect replay).
- [x] `GET /api/calls` (summaries, newest-first) and `GET /api/calls/:id` (full event stream) — mounted gated; auth wraps in M7. Verified live end-to-end (counts correct, event stream complete, 404 for missing, files on disk, survives restart).
- [x] Existing `runtime/events.jsonl` diagnostic logging untouched.
- Verified: `npm run check` green (133 tests).

### M7 — Auth (private access) ✅
- [x] `src/agent/auth.js`: `POST /login` checks `DASHBOARD_PASSWORD` (constant-time), sets a signed, httpOnly, SameSite=Lax session cookie (HMAC of `SESSION_SECRET`, 7-day expiry; `Secure` behind HTTPS). Styled `GET /login` page reusing `styles.css`.
- [x] Gates the **whole app** (not just the dashboard) behind the session — `/dashboard`, `/api/stream`, `/api/calls*`, `/api/balance`, all provider `/api/*`, and `/app` — so nothing leaks in the private deployment. Open paths: `/healthz`, `/login`, `/vapi/*`, landing page + `/styles.css` (needed pre-login).
- [x] Resolved the internal-call problem: the tool registry's own localhost fetches carry an `x-internal-token` (= `SESSION_SECRET`) that auth accepts, so phone tools work without a cookie. `/vapi/webhook` stays cookie-free (secret + allowlist).
- [x] Local dev unaffected: gating only mounts when a password is configured **and** `ENABLE_WEB_PHONE` is on; with no `DASHBOARD_PASSWORD`, auth is disabled and everything passes.
- Verified live (11 checks): unauth `/dashboard`→302, `/api/calls`→401, wrong pw→401, correct→302+cookie, cookie→200, webhook secret-only→200, tool-call internal fetch passed auth. `npm run check` green (133 tests).

### M8 — Fly.io deployment ✅
- [x] `Dockerfile` (Node 22 bookworm-slim, `npm ci` incl. esbuild, `npm run build`, non-root `appuser` with writable `$HOME` for the AgentCash wallet). Image 171 MB. `.dockerignore` excludes secrets/node_modules/runtime.
- [x] `fly.toml`: `internal_port = 4173`, `min_machines_running = 1` + `auto_stop_machines = off` (webhooks must not cold-start), `/healthz` check, `[mounts]` volume `data` → `/app/runtime` (call history + events.jsonl).
- [x] **AgentCash in prod:** discovered it needs the on-disk **wallet file** (`~/.agentcash/wallet.json` + `solana-wallet.json`), not env keys. Wallet files staged as base64 Fly secrets (`AGENTCASH_WALLET_JSON_B64`, `_SOLANA_`, `_STATE_`); `scripts/docker-entrypoint.sh` writes them to `~/.agentcash/` at boot. No wallet errors in prod logs.
- [x] `fly secrets` for every key (30 total) — never baked into the image.
- [x] Deployed to **https://coinbase-for-agents-phone.fly.dev** (volume in sjc, single machine, `--ha=false`). Verified live: `/healthz` ok, `/dashboard` gated (302→login), login→cookie→200, **live Coinbase `/api/balance` 200 in-container**, health check passing, volume mounted at `/app/runtime`.
- [ ] (Optional) custom domain — skipped.

### M9 — End-to-end verification ⏳ (all automated checks pass; real phone call needs you)
Also done here: ran `scripts/configure-vapi.mjs` **live** — assistant `e91b6995…` set to `gpt-realtime-2025-08-28` + voice marin + **36 tools** (17 static + 19 Coinbase MCP), assistant & phone `+15713860189` routed to `https://coinbase-for-agents-phone.fly.dev/vapi/webhook`. (Fixes made live: Vapi rejects `gpt-realtime-2.1` → use `gpt-realtime-2025-08-28`; rejects `null` in enums and non-standard schema keywords → dropped null enums in `tools.js` + deep-sanitize in the config script. Set a known `VAPI_WEBHOOK_SECRET` on Fly so the assistant matches.)
- [x] `npm run dev` locally still gives the original browser-voice experience (loads clean, no console errors, 133 tests pass).
- [x] Website: log in (prod) → dashboard. Verified in-browser: styled login, cookie, redirect.
- [x] Allowed vs disallowed caller — simulated real Vapi `assistant-request` against **prod**: your number → `{assistantId}`, other → rejection; no secret → 401.
- [x] Artifact renders live on the dashboard — simulated a prod tool-call; **snapshot-on-connect** replayed the active call (pill "Incoming · +12368670354" + BTC candle chart) in-browser over the internet.
- [x] End-of-call persisted + history — verified locally and on prod (`/api/calls` shows the calls with counts, stored on the Fly volume).
- [x] Webhook-secret rejection (401) and unauthenticated dashboard rejection (302) — verified local + prod.
- [ ] **NEEDS YOU:** add the **BYOK OpenAI key** in Vapi → Integrations → Model Providers → OpenAI (required for the realtime model to run on a call).
- [ ] **NEEDS YOU:** call **+15713860189** from **+12368670354** → hear the agent; ask for a BTC chart/news/balance and watch the dashboard; try a small spoken-confirmed trade on a limited-funds portfolio.

### M10 — Docs & handoff ✅
- [x] `README.md` has a "Hosted: web dashboard + phone" section (what it is, Fly deploy steps, Vapi wiring, model/voice notes, costs) — framed as an additive capability that leaves local untouched.
- [x] `scripts/configure-vapi.mjs` usage documented (incl. `TOOLS_BASE_URL` enumeration trick and `--dry-run`).
- [x] Costs noted: Vapi per-minute + OpenAI realtime tokens + Fly machine + AgentCash paid calls.

---

## 5. Environment variables

**Already in `.env`:** `OPENAI_API_KEY`, `EXA_API_KEY`, `COINBASE_KEY_ID`, `COINBASE_KEY_SECRET`, `COINBASE_MODE`, `COINBASE_ENV`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`, `DEFAULT_PRODUCT`, `PORT`, `NANSEN_*`, `SPONGE_API_KEY`, `ORTHOGONAL_API_KEY`, `PHONE_NUMBER`, `FLY_API_KEY`, `VAPI_PRIVATE_KEY`, `VAPI_PUBLIC_KEY`, `VAPI_AGENT_ID`, `VAPI_PHONE_NUMBER`, `SOLANA_ADDRESS`, `SOLANA_PRIVATE_KEY`, `ETH_ADDRESS`, `ETH_PRIVATE_KEY` (AgentCash wallet).

**New to add:**
| Var | Purpose |
|---|---|
| `ENABLE_WEB_PHONE` | Feature flag; enables new routes (off locally by default). |
| `PUBLIC_BASE_URL` | The Fly URL, used when configuring Vapi. |
| `VAPI_WEBHOOK_SECRET` | Shared secret to verify `/vapi/webhook` requests (`server.secret`). |
| `DASHBOARD_PASSWORD` | Website login password. |
| `SESSION_SECRET` | Signs the session cookie. |

`PHONE_NUMBER` doubles as the **inbound caller allowlist**. The **OpenAI BYOK key for realtime lives inside Vapi** (Integrations), not as a server env var.

---

## 6. Open items / defaults (change if you disagree)
- **Persistence:** default SQLite on a Fly volume; JSONL fallback if we want zero native modules.
- **Realtime voice:** default to a realtime-compatible voice (e.g. `marin`, matching local); tune later.
- **Single machine, min 1 running:** cheap and always-on for webhooks.

## 7. Risks / notes
- **Real money over the phone.** Mitigated by caller-ID allowlist + spoken confirmation + a dedicated limited-funds portfolio. Consider a spoken PIN later if access ever widens.
- **Tool-call latency:** tool webhooks round-trip to Fly mid-conversation (same as local's fetch to localhost). Keep the machine warm; consider Vapi filler audio.
- **One brain style, two hosts:** local hosts the realtime session in the browser; phone hosts it in Vapi. Behavior stays consistent via shared `AGENT.md` + shared tool layer.
- **Realtime-mode limits:** no knowledge bases / custom voice cloning; transcripts may differ slightly from STT pipelines.

## 8. Fallback: custom-LLM text pipeline (not chosen)
If speech-to-speech ever proves limiting, Vapi can instead call a server-side OpenAI-compatible `/chat/completions` brain (STT→LLM→TTS). Same tool layer (M1), different `model.provider = "custom-llm"`. Documented so the option isn't lost.

---

## Progress log
- **2026-09-10:** Spec revised to **OpenAI Realtime speech-to-speech via Vapi** (was custom-LLM).
- **2026-09-10:** Fly set up — `flyctl` installed, authed to personal org "Ash". App **`coinbase-for-agents-phone`** created → **`https://coinbase-for-agents-phone.fly.dev`** (this is `PUBLIC_BASE_URL` for Vapi config). **27 secrets staged** (verified `Staged`, not yet deployed — no code/`fly.toml` yet). Generated `DASHBOARD_PASSWORD` was reported to you in the terminal — save it; rotate anytime with `fly secrets set DASHBOARD_PASSWORD=... -a coinbase-for-agents-phone`.
- **Next up:** M0/M1 (map tools → services, build `src/agent/tools.js`), then M8 `Dockerfile` + `fly.toml` for the first deploy.
