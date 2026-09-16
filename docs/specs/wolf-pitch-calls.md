# Spec: "Jordan" pitch calls — the agent calls you with a trade pitch

**Status:** planned · **Written:** 2026-09-16 · **Path:** web + phone via Vapi (hosted on Fly)

Today you call the agent. This feature flips that around. The server watches the trades the desk's AI traders actually open. When one of those ideas is still fresh, still fits the plan, and can be traded on Coinbase, the server calls your phone. The caller is "Jordan", a Wolf-of-Wall-Street-style closer speaking in an ElevenLabs voice. It pitches the trade with real context and real numbers, then takes your answer: "not interested" or "buy 2 shares of Nike". Every order still goes through the existing preview → spoken confirmation → execute flow, and a $500 cap enforced in server code sits on top of that.

No new research agent and no new research spend. The ideas come from the desk (its Neon DB, read-only). This app's existing Exa and Coinbase tools re-check each idea and add context before the call.

---

## 1. Decisions (locked with the owner)

| Topic | Decision |
|---|---|
| Idea source | Desk (`its-the-desk`) Neon DB via a **SELECT-only role**. No desk code change, no desk redeploy. Fund is out of scope. |
| Trigger | A desk agent **opens a new long** in `ledger` whose linked thesis has conviction ≥ 7. The pitch is only as real as the desk's own position: no open position, no call. |
| Call stack | **Vapi outbound** using a new *pitch assistant*: STT → LLM → **ElevenLabs voice `Ifu36BnEjjIY932etsqk`** ("Nate", professional, young American male; replaced "Matt" after the smoke call). The ElevenLabs plan is 10k characters a month, so the Vapi-voice fallback matters. **`backgroundSound: "off"`**: the smoke call had Vapi's default call-centre background. |
| Caller ID | **Buy a second Telnyx number** and import it into Vapi. The existing Telnyx number (OpenAI SIP inbound) and the free Vapi number (inbound) stay unchanged. The free Vapi number *cannot* place outbound calls. |
| Call limits | **Max 3 calls/day**, weekdays **9:30–16:00 ET** only, at least **60 min apart**, never the same idea twice. |
| Direction | **Long only.** Bearish or neutral theses are skipped. Only products Coinbase can trade: equities/ETFs, spot crypto, and long futures (gold, silver, platinum, copper, crude, natgas). |
| No real signal | **No call.** The agent never invents or pads an idea just to make a call. |
| No answer | **Leave a ~15 s voicemail teaser** (ticker + hook + "call me back on this number"). The idea is then marked `voicemail` and never re-dialed. |
| Callback | Calling the pitch number back reaches **Jordan, preloaded with the most recent unresolved pitch**. The caller allowlist (`PHONE_NUMBER`) still applies. |
| Sizing | The agent **suggests a starter size** (≤ cap, based on real buying power). What you say always wins. |
| Order cap | **`PITCH_MAX_ORDER_USD=500`**, enforced in server code at preview **and** execute, for any order placed on a pitch call. |
| Persona | Introduces himself as **"Jordan"**, a Belfort-style closer. Cool, confident, **serious about doing his job**: aggressive and persuasive, not soft or chatty. Humor only to needle you and fire you up; no small talk, no jokes for their own sake. **Mild swearing** (hell/damn, no F-bombs). Never "The Wolf". |
| Dashboard | **"Pitch me now" button** + **Pause toggle**. |

---

## 2. Architecture

```
          ┌─────────────── Fly machine (always on) ────────────────┐
 Desk     │  pitch scheduler (every 10 min, market hours)          │
 Neon DB ─┼─► desk-source  ──► qualify ──► brief ──► vapi-outbound ┼──► Vapi POST /call
 (RO role)│      (ledger opens,  (Coinbase price,   (LLM, grounded)│        │
          │       theses,         Exa news check,                   │        ▼
          │       identity)       caps, dedupe)                     │   Telnyx #2 ──► your phone
          │                                                         │        │
          │  /vapi/webhook  ◄── tool-calls / end-of-call-report ◄───┼────────┘
          │     └─ pitch-aware: cap-guarded preview/execute,        │
          │        record_pitch_outcome, assistant-request (callback)│
          │  runtime/pitches.json  ·  runtime/settings.json (pause) │
          │  /dashboard: Pitch me now · Pause · (existing call view)│
          └─────────────────────────────────────────────────────────┘
```

New code goes in `src/pitch/`, and the existing Vapi webhook, tool registry, and order flow are reused. Everything stays behind `ENABLE_WEB_PHONE=1` **and** a new `ENABLE_PITCH_CALLS=1`.

---

## 3. Checklist

### Phase 0: Accounts, keys, infrastructure

- [x] **0.1 Fix the ElevenLabs key.** The `ELEVENLABS_API_KEY` in `demo/.env` is a key *ID* (the API returns "API key ID used as API key"). Replace it with the secret `sk_…` key. The desk's `.env.local` key is valid and has access to voice `yr43K8H5LoTp6S1QFSGg`. *(The owner then put a valid `sk_` key in `demo/.env`.)*
- [x] **0.2 Owner: add ElevenLabs to Vapi.** Vapi → Settings → Integrations → **Voice Providers → ElevenLabs** → paste the `sk_…` key. If the key is restricted, it needs Text-to-Speech access and read access to Voices and User. Skip the "Transcriber Providers" ElevenLabs card; we use Deepgram.
- [x] **0.3 Owner: buy a second Telnyx number.** Bought `+12369627377` (Vancouver, CA; Canadian because the owner's phone is Canadian; the Default profile already allows CA). Voice, Local, left unassigned so Vapi could attach its own connection. Saved as `PITCH_PHONE_NUMBER`.
- [x] **0.4 Import the number into Vapi** (done: Vapi id in `VAPI_PITCH_PHONE_NUMBER_ID`, Telnyx credential `telnyx-pitch`; `server.url` still to be set once the code is deployed) (Claude, via the Vapi API with the existing `TELNYX_API_KEY`, or the owner via Dashboard → Phone Numbers → Create → Import Telnyx), following [Vapi: Import number from Telnyx](https://docs.vapi.ai/telnyx). Record its Vapi id as `VAPI_PITCH_PHONE_NUMBER_ID`. Set its `server.url` to `https://<app>.fly.dev/vapi/webhook` with the **existing** `VAPI_WEBHOOK_SECRET`, so callbacks hit our `assistant-request`. No new webhook is needed.
- [x] **0.5 Enable outbound on Telnyx** (done: Vapi created Telnyx call-control app "Vapi", now linked to the Default profile) (Claude, via the Telnyx API): add the connection Vapi created during import to the existing **"Default"** Outbound Voice Profile (US/CA allowed). Don't touch the existing number or its `voice-agent-openai-sip` TeXML app. If a test call fails on SIP auth, fall back to the BYO SIP-trunk setup in [Telnyx SIP integration](https://docs.vapi.ai/advanced/sip/telnyx) (use gateway **IPs**).
- [x] **0.5b Top up balances.** *(Owner deferred: top up when credits run out.)* Low Vapi/Telnyx balances cover only a handful of pipeline + ElevenLabs minutes.
- [x] **0.6 Smoke-test outbound:** *(Done 2026-09-16: a test call rang the owner from +12369627377, ended customer-ended-call, $0.024. Feedback: too soft, office background noise, change voice → handled in 4.x.)* one manual `POST https://api.vapi.ai/call` with a throwaway assistant to `PHONE_NUMBER`. Confirm your phone rings and shows the new caller ID.
- [x] **0.7 Create the read-only desk DB role.** *(Done: `pitch_reader` on the desk DB; `DESK_DATABASE_URL` in `.env`.)* Desk DB = the desk's Neon project.
  - [x] Create the role **with SQL, not the Neon API/Console**, because API-created roles join `neon_superuser`. Run it as the desk owner, using `DATABASE_URL_UNPOOLED` from `desk/.env.local`:
    ```sql
    CREATE ROLE pitch_reader WITH LOGIN PASSWORD '<generated>';
    ALTER ROLE pitch_reader SET default_transaction_read_only = on;
    GRANT CONNECT ON DATABASE <db> TO pitch_reader;
    GRANT USAGE ON SCHEMA public TO pitch_reader;
    GRANT SELECT ON ledger, theses, identity TO pitch_reader;
    ```
  - [x] Build `DESK_DATABASE_URL` (pooled host, `sslmode=require`).
  - [x] Verify: `SELECT` works ; `INSERT`/`UPDATE`/`CREATE` fail as read-only; `activity`/`agent_state` are denied; switching to read-write still gets "permission denied".
- [x] **0.8 New env vars:** *(Done: `.env.example` block + `config.pitch` in `src/config.js`; also added `PITCH_FALLBACK_VOICE=Elliot` and `PITCH_DRY_RUN`; `PITCH_LLM_MODEL` defaults to `gpt-4.1`, a fast non-reasoning model on Vapi's list.)* add them to `.env.example` (hosted block, with comments) and `src/config.js`:
  ```
  ENABLE_PITCH_CALLS=            # 1 to turn the outbound pitcher on
  DESK_DATABASE_URL=             # pitch_reader connection string
  VAPI_PITCH_ASSISTANT_ID=       # written by scripts/configure-vapi-pitch.mjs
  VAPI_PITCH_PHONE_NUMBER_ID=    # imported Telnyx number (Vapi id)
  PITCH_PHONE_NUMBER=            # E.164 of that number
  PITCH_CALL_TO=                 # defaults to first PHONE_NUMBER entry
  ELEVENLABS_VOICE_ID=Ifu36BnEjjIY932etsqk
  PITCH_MAX_ORDER_USD=500
  PITCH_MAX_CALLS_PER_DAY=3
  PITCH_MIN_SPACING_MIN=60
  PITCH_MIN_CONVICTION=7
  PITCH_MAX_IDEA_AGE_HOURS=6
  PITCH_MIN_REWARD_RISK=1.5
  PITCH_SCAN_INTERVAL_MIN=10
  PITCH_LLM_MODEL=               # a Vapi-supported OpenAI model (see 3.1)
  PITCH_FALLBACK_VOICE=Godfrey
  ```
- [x] **0.9 Add the `postgres` npm dependency** *(Done: postgres ^3.4.9; build still passes.)* (same client the desk uses). Nothing else new.

### Phase 1: Idea source (desk, read-only)

- [x] **1.1 `src/pitch/desk-source.js`** *(Done: verified live; 7 open longs came back with thesis + sources `{url,title,source,snippet,publishedDate}`; a bad DB returns `[]` and logs.)* (`createDeskSource({ url })`, injectable `sql` for tests):
  - [x] `listNewLongOpens({ since })`: open desk positions (`closed_at IS NULL`, `side='long'`, `opened_at > since`) joined to `theses` (title, summary, body, interpretation, key_points, sources, conviction, stance) and `identity` (the desk trader's `name`).
  - [x] `traderRecord(agentId)`: that trader's closed-trade hit rate and realized P&L from `ledger`, used for the "judge me on my losers" credibility line. Numbers must come from this query, never from the LLM.
  - [x] `isStillOpen(ledgerId)`: re-checked right before dialing.
  - [x] Pool max 2 connections, 5 s statement timeout. A DB failure means *skip this scan*, never *crash the server*.
- [x] **1.2 `src/pitch/symbol-map.js`** *(Done, plus `src/pitch/market-data.js`. Found: the public Coinbase API 404s on equities and the CLI has no equity prices/candles, so tradability = Coinbase CLI `products get`, and prices/trend = Yahoo chart (the desk's own mark source; crypto uses Coinbase). Contracts expiring within 7 days are skipped (NOL Sep-21 was front). Live check: NKE/OXY/LLY→equity, WTI→USO, GOLD→GLD, SILVER/COPPER/NATGAS→over_cap, BTC→spot, CORN→not_on_coinbase. The USD/USDC choice for crypto happens at sizing time (3.2).)*, mapping desk symbols to a Coinbase product:
  - [x] Equities (desk universe: NVDA, NKE, LLY, XOM, …) → the Coinbase equity product (`<SYM>-USD`, confirmed via product lookup). Unknown or not tradable → skip with reason `not_tradable`.
  - [x] `BTC`/`ETH`/`SOL` → spot product. Pick the USD/USDC quote from the portfolio balance, following the existing Coinbase MCP rule.
  - [x] `GOLD`, `SILVER`, `COPPER`, `WTI`, `NATGAS` → the **front-month `-CDE` futures contract**, resolved live from the products list (never hardcode expiries). Add PLATINUM if the desk ever emits it.
  - [x] **Futures cap fallback:** if one contract's notional exceeds `PITCH_MAX_ORDER_USD`, pitch the ETF proxy instead (`WTI→USO`, `GOLD→GLD`). If there is no proxy (SILVER, COPPER, NATGAS), skip with `over_cap`.
  - [x] `CORN`/`WHEAT`/`SOY`/`COFFEE`/`SUGAR` → skip (`not_on_coinbase`).
- [x] **1.3 Tests** *(Done: 19 passing. The full suite has 1 failure that was already on `main`: `landing page offers the agent-guided setup prompt`.)* (`test/pitch-desk-source.test.js`, `test/pitch-symbol-map.test.js`) with a fake `sql` and a fake product catalog.

### Phase 2: Qualify ("only call when it's real")

- [x] **2.1 `src/pitch/qualify.js`** *(Done, plus `market-hours.js` (desk NYSE calendar port), `news-check.js`, `openai-json.js`. Live run 2026-09-16: NKE, LLY, OXY passed; WTI blocked by `news_contradicts` (extra Saudi cargoes via Oman); PEP/KO `low_conviction`. The news check fails closed.)*: a pure function plus injected market/news clients. It returns `{ ok, reasons[] }` and a `candidate` object. An idea must pass **all** of these checks:
  - [x] Long stance, conviction ≥ `PITCH_MIN_CONVICTION`, desk position still open.
  - [x] Opened ≤ `PITCH_MAX_IDEA_AGE_HOURS` ago.
  - [x] Tradable product resolved (1.2).
  - [x] Live price (Yahoo; Coinbase for crypto) is **above the desk stop and below the target**.
  - [x] Price has moved less than 50% of the way from entry to target.
  - [x] Reward/risk from the *current* price ≥ `PITCH_MIN_REWARD_RISK`.
  - [x] Everything except spot crypto: US cash session open (reuse or port the desk's NYSE-hours logic, including holidays).
  - [x] **Fresh news check:** Exa, last 48 h, symbol + thesis keywords. A summary-model judge returns `supports | neutral | contradicts`, with cited URLs. `contradicts` → skip.
  - [x] Not pitched before (dedupe key = desk `ledger.id`). The same symbol was not pitched in the last 48 h.
- [x] **2.2 Call gates** in `src/pitch/gates.js` (pure; the scheduler calls it), checked before dialing:
  - [x] Not paused.
  - [x] Weekday 9:30–16:00 ET (manual + crypto exempt).
  - [x] Fewer than `PITCH_MAX_CALLS_PER_DAY` calls today (ET day). Voicemails count.
  - [x] ≥ `PITCH_MIN_SPACING_MIN` minutes since the last dial.
  - [x] No live call in progress on any agent (check the call store / event bus).
- [x] **2.3 Ranking:** *(`rankCandidates`: conviction → reward/risk → news support → freshness.)* when several ideas qualify in one scan, call about **one** only: the highest conviction, then the best reward/risk. The rest stay `queued` and are re-checked next scan. They expire at `PITCH_MAX_IDEA_AGE_HOURS`.
- [x] **2.4 Tests** *(27 new tests covering every skip reason, gates, DST, holiday, half-day, and news-check mapping; caught a missing `request` injection in news-check.)* for every skip reason and gate, using fixed clocks (including DST and a market holiday).

### Phase 3: The pitch brief (grounded)

- [x] **3.1 Pick the LLM for the Vapi assistant.** *(Done: `gpt-4.1`, confirmed on Vapi's OpenAPI model enum 2026-09-16; fast, non-reasoning, good at tool calls. Brief writing itself uses `OPENAI_SUMMARY_MODEL` (gpt-5.6-luna, medium effort) before the call.)* Check [Vapi's current OpenAI model list](https://docs.vapi.ai/api-reference/assistants/create) and choose the fastest capable model that allows tool calls, using the existing BYOK OpenAI key. Write it to `PITCH_LLM_MODEL`.
- [x] **3.2 `src/pitch/brief.js`** *(Done. Live briefs for NKE/LLY/OXY passed grounding. The first OXY draft was rejected for "30"/"90", so trend-window numbers are now allowed, digits are required, and losses are said as positive amounts. The owner's live buying power was very low, so briefs flag `lowBuyingPower` and Jordan tells him to fund the account. Desk trader records are cited only if ≥3 closed trades and ≥55% hit rate.)*: builds a strict JSON brief with the summary model (`OPENAI_SUMMARY_MODEL`, structured output) from the thesis, sources, news check, and live market data:
  - [x] `company`/`asset`, `productId`, `price`, `deskEntry`, `stop`, `target`, `upsidePct`, `downsidePct`, `rewardRisk`. These are **computed in code, not by the LLM**.
  - [x] `trendContext`: 30-day and 90-day % change and the distance from the 90-day high, computed from Coinbase candles (e.g. "down 22% over three months").
  - [x] `catalyst`, `whyNow`, `theTurn` (the "this is about to turn it around" line), `keyRisk` (one sentence), `sources[]` (title + publisher).
  - [x] `deskTrader`: name, hit rate, and record (from 1.1).
  - [x] `suggestedSize`: min(`PITCH_MAX_ORDER_USD`, 5% of available buying power), rounded to whole shares, crypto units, or contracts, plus the matching dollar P&L at stop and at target.
  - [x] `hook`: one sentence, used for the first message and the voicemail.
  - [x] **Grounding validator:** every number in the brief's text fields must match a computed field or appear in the source text. If the check fails, regenerate once, then skip the idea (`ungrounded`).
- [x] **3.3 Render Vapi `variableValues`** *(Done: `renderVapiVariables`.)* from the brief (flat strings), plus `firstMessage` and `voicemailMessage` text. Render these server-side so nothing depends on template support inside Vapi's voicemail feature.
- [x] **3.4 Tests:** *(Done: 13 tests. Caught two bugs: equities were getting a USDC product id, and the proxy's underlying name was wrong.)* brief math, grounding validator (rejects an invented "$60,000 profit"), and sizing across equity, crypto, and futures.

### Phase 4: Persona and Vapi pitch assistant

- [x] **4.1 `src/pitch/PITCH_AGENT.md`** *(Done: "Jordan" persona per owner feedback; all 28 `{{variables}}` are covered by `renderVapiVariables`; example numbers are labelled illustrative; the tool set is limited to get_active_pitch, check_balance, preview_order, execute_order, record_pitch_outcome, plus Vapi endCall. `search_crypto_news` is left out because it only accepts crypto product ids; Jordan answers from the brief's news facts instead.)*, the system prompt. Base it on the techniques in the Aerotyne phone-sale scene ([transcript](https://pdfcoffee.com/transcript-of-the-wolf-on-the-wall-street-aerotyne-phone-sale-pdf-free.html)):
  - [x] **Callback rapport:** "You told me to ring you the second something real crossed my desk. Well, something just crossed my desk."
  - [x] **The 60-second ask:** "Give me sixty seconds."
  - [x] **Hook, then context:** the trend so far, the catalyst, why now, and "this is what turns it around".
  - [x] **Upside framing with *real* numbers:** "$500 in at $36.80, target $40.50: that's about fifty bucks if it gets there…"
  - [x] **Credibility:** "Judge us on the losers." Use the desk trader's real record.
  - [x] **Assumptive close:** "How many shares do I lock in for you?" / "Should I put you down for the five hundred?"
  - [x] **Humor and swagger,** mild swearing only.
  - [x] **Hard rails** (in the prompt *and* enforced by tools where possible):
    - [x] Only use facts and numbers from `{{variables}}` or tool results. No invented patents, analysts, or returns.
    - [x] Never say "guaranteed", "can't lose", or "risk-free". Say the stop/downside in one sentence before the close.
    - [x] He's "Jordan", a Belfort-style closer (owner-approved name). Never claims to be a licensed broker or registered advisor.
    - [x] One comeback after a "no", then take a clear "no" graciously: call `record_pitch_outcome(declined)` and end the call.
    - [x] Trades: BUY on the pitched product within the cap. For anything else, point to the main line and don't place it.
    - [x] Preview → read back the exact preview → explicit "yes" in the caller's *next* utterance → execute (same rule as `PHONE_ADDENDUM`).
    - [x] Voice rules: short spoken sentences, never read IDs or JSON, spell tickers as words ("Nike", not "N-K-E").
  - [x] Include 3–4 short **example exchanges**, written fresh (not copied movie dialogue): a decline, "buy 2 shares of Nike", an over-cap request, and a "what's the risk?" question.
- [x] **4.2 `scripts/configure-vapi-pitch.mjs`** *(Done: assistant created (id in `VAPI_PITCH_ASSISTANT_ID`) and read back: gpt-4.1, 5 tools + endCall, 11labs `Ifu36BnEjjIY932etsqk` / eleven_flash_v2_5 with Vapi "Elliot" fallback, `backgroundSound: off`, Krisp denoising, Vapi audio voicemail detection. Pitch number now routes inbound through `/vapi/webhook` (no fixed assistant). `PUBLIC_BASE_URL` and `VAPI_WEBHOOK_SECRET` copied into `.env` from the live config. Tool definitions live in `src/pitch/tools.js`.)* (pattern: `configure-vapi.mjs`, supports `--dry-run`, backs up any existing assistant to `runtime/`):
  - [x] Creates or updates the assistant "Jordan (pitch)". Sets `backgroundSound: "off"` and background denoising on. Writes `VAPI_PITCH_ASSISTANT_ID` in its output.
  - [x] `model`: provider `openai`, `PITCH_LLM_MODEL`, system prompt = `PITCH_AGENT.md`, tools listed below.
  - [x] `voice`: provider `11labs`, `voiceId` = `ELEVENLABS_VOICE_ID`, low-latency model (`eleven_flash_v2_5` or the current Vapi-listed equivalent). Tune stability/style for energy.
  - [x] `voice.fallbackPlan.voices`: built-in Vapi voice **Godfrey** (young American male, "professional"; swapped from "Elliot", which is described as calm) so a failed ElevenLabs call (e.g. out of credits) switches voices instead of dropping the call ([Vapi voice fallback](https://docs.vapi.ai/voice-fallback-plan)).
  - [x] **Pre-call credit check** (`src/pitch/elevenlabs-quota.js`) *(Done + tests; The server wiring happens in 5.3.)*: `GET https://api.elevenlabs.io/v1/user/subscription`. If `character_limit - character_count` is under ~3,000 (roughly one pitch plus Q&A), or the request fails, place this call with `assistantOverrides.voice` = the Vapi voice from the start rather than switching mid-call. Log which voice was used on the pitch record.
  - [ ] Test the fallback *(moved to 7.3 with the other live calls)*: one call with a deliberately invalid ElevenLabs voice id should still connect in the Vapi voice.
  - [x] `transcriber`: Deepgram (current Nova model), `en`.
  - [x] `firstMessageMode: assistant-speaks-first`, `firstMessage: "{{firstMessage}}"`.
  - [x] `voicemailDetection` on. `voicemailMessage` set per call (3.3). Settings per [Vapi voicemail detection](https://docs.vapi.ai/calls/voicemail-detection).
  - [x] `maxDurationSeconds: 300`, end-call function enabled, `server.url` = `/vapi/webhook`, `server.secret` = `VAPI_WEBHOOK_SECRET`.
  - [x] Tools: `get_active_pitch`, `check_balance`, `preview_order`, `execute_order`, `search_crypto_news` (for follow-up questions), `record_pitch_outcome`.
- [ ] **4.3 Voice tuning pass:** *(Moved to after deploy (7.3): test calls only make sense once the webhook and tools are live. Initial settings: stability 0.38, style 0.3, speed 1.05, stopSpeaking numWords 2.)* place 3 test calls. Adjust voice settings and turn-taking (endpointing / interruption) so you can cut in mid-pitch.

### Phase 5: Server wiring

- [x] **5.1 `src/pitch/pitch-store.js`** *(Done + 4 tests: persistence, ET-day dial reset, 24h callback window. Skipped ideas go to the runtime log, not the store.)*: JSON file `runtime/pitches.json` on the Fly volume, atomic writes (same pattern as `settings-store.js`):
  - [x] Pitch record: `{ id, deskLedgerId, symbol, productId, brief, status, reasons[], createdAt, calledAt, vapiCallId, outcome, orderId }`.
  - [x] Statuses: `queued | skipped | dialing | in_call | voicemail | no_answer | declined | bought | no_decision | failed | expired`.
  - [x] Daily counter (ET) and `lastDialAt`.
- [x] **5.2 Pause flag** *(Done; `select()` now preserves other fields; settings tests updated + pause test.)* in `settings-store.js` (`pitchPaused: boolean`, persisted).
- [x] **5.3 `src/pitch/vapi-outbound.js`** *(Done + 3 tests; includes the ElevenLabs pre-call quota check, which starts the call in the Godfrey voice when credits are low. Vapi's CreateCall has no `metadata`, so pitch↔call mapping is by the returned call id.)*: `placePitchCall(pitch)` → `POST https://api.vapi.ai/call` with `{ assistantId, phoneNumberId, customer: { number }, assistantOverrides: { variableValues, voicemailMessage }, metadata: { pitchId } }` ([Vapi outbound](https://docs.vapi.ai/calls/outbound-calling)). Inject `fetchImpl` for tests. Record the returned `id` as `vapiCallId`.
- [x] **5.4 `src/pitch/scheduler.js`** *(Done + 10 tests. There's no cursor: it scans desk longs opened within `PITCH_MAX_IDEA_AGE_HOURS` and caches skips (permanent reasons forever, price/news reasons for 1h) so Exa/OpenAI aren't re-billed every 10 min. If a brief can't be grounded it tries the next-best idea. Dry runs and failed dials don't use up the idea. Outbound calls emit a `call/incoming` event with `direction: outbound`, so the dashboard shows them and the line counts as busy.)*: `setInterval(PITCH_SCAN_INTERVAL_MIN)` plus `runOnce({ manual })`.
  - [x] Single-flight lock.
  - [x] ~~Cursor~~ → time window + skip cache (see above).
  - [x] Flow: pull → qualify → rank → gates → brief → dial.
  - [x] Emit `kind: "pitch"` events to the event bus for the dashboard.
  - [x] Starts only when `ENABLE_WEB_PHONE && ENABLE_PITCH_CALLS`.
- [x] **5.5 Make `vapi-webhook.js` pitch-aware:** *(Done + 10 tests. Pitch calls are identified by pitch number or pitch assistant id and only get `PITCH_TOOL_NAMES`; without a pitched trade (empty callback) order tools are refused; a successful `execute_order` marks the pitch bought with its order id.)*
  - [x] Map `message.call.id` / `call.metadata.pitchId` → pitch, and put `ctx.pitch` into tool execution.
  - [x] `assistant-request` on the **pitch number** (match `message.phoneNumber.id` / `call.phoneNumberId` to `VAPI_PITCH_PHONE_NUMBER_ID`): keep the allowlist check, then return `{ assistantId: pitch, assistantOverrides: { variableValues } }` for the latest pitch with status `voicemail | no_answer | no_decision` from the last 24 h. With nothing pending, use a short "nothing worth your time right now" variant. Other numbers keep the current behavior.
  - [x] `end-of-call-report`: set the status from `endedReason` (voicemail → `voicemail`; no-answer/busy → `no_answer`; otherwise keep whatever `record_pitch_outcome` set, else `no_decision`). Persist through the call store as today.
- [x] **5.6 New tools** *(Done in `src/pitch/tools.js`; the webhook runs them directly rather than adding them to the shared registry, so no other agent can see them.)* in `src/agent/tools.js` (only exposed to the pitch assistant):
  - [x] `get_active_pitch` → the current brief (for callbacks and re-asks).
  - [x] `record_pitch_outcome({ outcome: declined|bought|thinking, note })` → pitch store.
- [x] **5.7 Server-side order cap** *(Done: `src/pitch/order-guard.js` + 6 tests, and verified on a local server: $10 NKE ok; $600 → refused; 20 shares (~$741) → refused; TSLA on the NKE line → refused; SELL → refused; executing a non-pitch preview from the pitch line → refused. **Finding:** Coinbase has no API order preview for equities ("API order preview is not available for equities products", even with a portfolio_id and even via the claude.ai connector), so `/api/orders/preview` now returns an `estimated: true` preview at the live Yahoo price for stocks, which also fixes stock previews for the main agents. The owner confirmed stock orders do place; only the preview is missing. All agent prompts and preview tool results now say stock previews are estimates. Stock limit orders read product increments from the CLI, because the public API 404s on stocks.)* (the non-negotiable part):
  - [x] When `ctx.pitch` is set, `preview_order` sends `pitchCapUsd` to `/api/orders/preview`. The server computes worst-case notional after quantization (quote size; or base size × price; or contracts × contract size × price) **plus estimated fees**. Over the cap → reject with a clear error the agent can say out loud.
  - [x] Store the cap on the preview record. `/api/orders/execute` re-checks it against the stored preview before calling Coinbase, as a second barrier.
  - [x] `side` must be `BUY` and `productId` must equal the pitch's product. Anything else is rejected on pitch calls.
  - [x] Only the server-side registry can set the cap flag, never the request body from a browser client. Unauthenticated callers can't lower or remove it.
  - [x] Tests: $499 passes; $501 fails; 2 shares × $300 fails; a futures contract over the cap fails; an execute on a tampered preview fails.
- [x] **5.8 Routes** (behind dashboard auth): *(Done and verified locally with `PITCH_DRY_RUN=1`: a manual run took 22 s, pitched OXY, and skipped WTI as `news_contradicts`. Pause blocks runs.)*
  - [x] `POST /api/pitch/run` ("Pitch me now"): runs `runOnce({ manual: true })`. It **still applies every qualify check and the pause flag**. It bypasses only the spacing gate and the market-hours gate *for crypto*. Returns what happened (`called <symbol>` / `nothing worth a call: <top reasons>`).
  - [x] `GET /api/pitch/state` → `{ paused, callsToday, lastDialAt, nextScanAt }`.
  - [x] `POST /api/pitch/pause` `{ paused }`.
- [x] **5.9** Add `src/pitch/*` log events *(Done: pitch.enabled / idea.skipped / brief.rejected / dry_run / call.placed / call.failed / scan.result / scan.failed / paused / run.manual, order.preview.estimated / pitch_guard.)* to `runtime/events.jsonl`, redacted like existing events.

### Phase 6: Dashboard

- [x] **6.1 Header controls** *(Done; verified in Chrome against a local dry-run server: the button showed "Scanning the desk…" then "Dry run: would pitch Occidental Petroleum"; the switch paused ("Calls paused", button disabled) and resumed; no console errors. Controls stay hidden if `/api/pitch/state` is unavailable. Helpers live in `dashboard/pitch-brief.js` with 3 tests.)* in `dashboard/index.html` / `dashboard.js`, next to the agent dropdown:
  - [x] "Pitch me now" button with a loading state; shows the returned result as a toast.
  - [x] Pause toggle (switch) with state from `/api/pitch/state`; shows "Paused", or "3/3 calls today", or the next scan time.
- [x] **6.2** Live pitch calls already show up *(Done: outbound calls show "Calling you · Jordan · SYM"; the `pitch/dialed` event renders a "Jordan's pitch" card (price/target/stop/R:R, trend, pitch details, source links; non-http links dropped). Dry runs render the card too.)* through `/api/stream`. Label them "Jordan · NKE". Render the brief (price, stop, target, sources) as an artifact card when the call starts, using the existing report/artifact rendering.
- [ ] **6.3** Mobile layout check *(Partly done: the controls wrap to their own full-width row under 640px via CSS, but the desktop Chrome window wouldn't shrink to 390px, so this still needs a look on the owner's phone after deploy.)* at phone width (the dashboard is used from a phone).

### Phase 7: Verification

- [x] **7.1** `npm run check` passes *(256/256 after aligning the old landing-copy assertion with the current "Your trades should too." hero.)* (build + all tests, new ones included).
- [x] **7.2 Local dry run:** *(Done on 2026-09-16 against the real desk/Coinbase/Exa: OXY and NKE/LLY briefs were grounded and on-tone; WTI was blocked by news; the only issue found ("$8.7%") is fixed.)* `PITCH_DRY_RUN=1` runs the full pipeline against the real desk DB, Coinbase, and Exa, and prints the brief plus the rendered first message and voicemail **without dialing**. Review two real briefs for grounding and tone.
- [ ] **7.3 Live call tests** (from Fly):
  - [ ] Pick up → hear the pitch → say "not interested" → call ends and status is `declined`.
  - [ ] Pick up → "buy 2 shares of Nike" → preview read back → "yes" → order fills, status is `bought`, order id recorded.
  - [ ] Ask for $2,000 → the agent refuses over the cap and offers ≤ $500.
  - [ ] Let it ring to voicemail → teaser left, status `voicemail` → call the pitch number back → Jordan resumes that pitch.
  - [ ] Interrupt mid-pitch → it stops and listens.
  - [ ] Pause on → "Pitch me now" → no call.
  - [ ] Call from a non-allowlisted number → rejected.
- [ ] **7.4 Gate tests in production:** confirm no calls outside 9:30–16:00 ET, none after 3/day, none within 60 min of the last.
- [ ] **7.5** Record first-week results (calls, answers, trades, declines, skip-reason counts) to tune `PITCH_MIN_CONVICTION` and the thresholds.

### Phase 8: Deploy and docs

- [x] **8.1** `fly secrets set` for the new vars *(Done 2026-09-16: staged only the new keys, with `PITCH_DRY_RUN=1` first, and deployed. At 17:38 UTC production skipped WTI (news) and dry-ran OXY. Merged into local `main`; **not pushed to GitHub** (public repo, and this spec names the pitch number and account ids), which is the owner's call.)* (not the whole `.env`), then `~/.fly/bin/flyctl deploy --remote-only`.
- [x] **8.2** Run `scripts/configure-vapi-pitch.mjs` *(Done in 4.2; it already targets the production URL.)* against the deployed URL. Set `VAPI_PITCH_ASSISTANT_ID` as a Fly secret.
- [x] **8.3** README: a new "Outbound pitch calls (Jordan)" section covering what it does, requirements (Telnyx number #2, ElevenLabs key in Vapi, desk read-only role), env vars, safety (long only, $500 cap, preview + confirmation), and costs (Vapi per-minute + Telnyx per-minute + ElevenLabs TTS characters + LLM tokens + Exa searches per scan).
- [x] **8.4** Add an optional section *(Done: "8b. Optional: outbound pitch calls".)* to the `launch-web-vapi` skill (buy/import a second number, configure the pitch assistant).
- [x] **8.5** Update the project memory note with the shipped state.

---

## 4. Out of scope / later

- Pulling ideas from `fund` (needs its own read-only proposals feed; its HMAC/least-privilege boundaries make that a separate project).
- Shorts (futures only) and "trim what you hold" calls on bearish desk theses.
- Pitches outside market hours (crypto on weekends).
- Protective stop/bracket orders placed automatically alongside a pitched buy.
- SMS follow-up with the brief and sources after a call.

## 5. Risks and open questions

- **Vapi + Telnyx import details** change often. Follow the current docs at step 0.4 and confirm with the smoke call (0.6) before building on it.
- **Pipeline latency** (STT → LLM → ElevenLabs) is higher than realtime speech-to-speech. It's acceptable for a mostly one-way pitch; tune it in 4.3.
- **Desk schema coupling:** the pitcher reads `ledger`, `theses`, `identity` directly. A desk migration can break it, so desk-source must fail soft and log.
- **Idea frequency:** the desk opened about 1–2 longs per trading day in the last 10 days (e.g. OXY, WTI, XOM, LLY, NKE, AVGO at conviction 7). After the qualify filters, expect 0–2 calls/day. Silent days are expected and correct.
- **Persuasion vs. honesty:** the persona is meant to sell, but the numbers are code-computed, the grounding check blocks invented claims, the downside is always stated, and the cap and confirmation are enforced by the server.
- **Regulatory/brand:** this is a private tool calling only its owner. Don't point it at anyone else, and don't use the real Jordan Belfort's likeness or surname in anything public.

## 6. References

- Aerotyne phone-sale transcript: [pdfcoffee](https://pdfcoffee.com/transcript-of-the-wolf-on-the-wall-street-aerotyne-phone-sale-pdf-free.html) · [Scribd](https://www.scribd.com/document/479600433/TRANSCRIPT-OF-THE-WOLF-ON-THE-WALL-STREET-AEROTYNE-PHONE-SALE) · [IMDb quotes](https://www.imdb.com/title/tt0993846/quotes/?item=qt3041629)
- "Sell me this pen" analysis: [Screen Rant](https://screenrant.com/wolf-wall-street-sell-me-this-pen-jordan-belfort-answer-explained/) · [Globe and Mail](https://www.theglobeandmail.com/report-on-business/international-business/sell-me-this-pen-the-real-answer-to-the-wolf-of-wall-streets-challenge/article17946810/)
- Vapi: [Outbound calling](https://docs.vapi.ai/calls/outbound-calling) · [Create call](https://docs.vapi.ai/api-reference/calls/create) · [Dynamic variables](https://docs.vapi.ai/assistants/dynamic-variables) · [Voicemail detection](https://docs.vapi.ai/calls/voicemail-detection) · [Import from Telnyx](https://docs.vapi.ai/telnyx) · [Telnyx SIP](https://docs.vapi.ai/advanced/sip/telnyx)
- Telnyx: [Telnyx + Vapi integration](https://support.telnyx.com/en/articles/12538402-telnyx-vapi-integration)
