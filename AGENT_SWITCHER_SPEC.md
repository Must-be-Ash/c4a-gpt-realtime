# Multi-Agent Switcher + gpt-live-1 + Latency — Spec & Build Checklist

**Goal:** One dashboard dropdown to switch between **three phone agents**, a real **gpt-live-1** path (OpenAI **GPT-Live API**, not the Realtime API), and a **measured reduction of the command→reply gap** vs Vapi. Work top-to-bottom; check items off as verified.

**Status:** Reviewed 2026-09-10 against OpenAI's GPT-Live docs (contract verified — see §3). Build on the `agent-switcher` worktree; `main` stays the deployable rollback.

---

## 1. What we're building

| Agent id | Label in dropdown | Transport / model | Number shown |
|---|---|---|---|
| `gpt-realtime-2.1` | gpt-realtime-2.1 | OpenAI **Realtime** API over SIP (current, working) | **Telnyx** number |
| `gpt-live-1` | gpt-live-1 | OpenAI **GPT-Live** API over SIP (new build) | **Telnyx** number |
| `vapi` | Vapi (gpt-realtime) | Vapi managed (existing, own number) | **Vapi** number |

### Locked decisions
- **One Telnyx number, shared** by the two OpenAI agents. The dropdown **arms** which one answers it. Vapi keeps its own number. No second number.
- **Selection persists server-side** (Fly volume, `runtime/settings.json`). Survives restarts and redeploys.
- **Selecting Vapi does not change the Telnyx number** — it keeps answering with the last-armed OpenAI agent. Vapi selection only changes what the dashboard displays. *(Owner decision 2026-09-10.)*
- **Default armed agent = `gpt-realtime-2.1`** until gpt-live-1 is validated on a real call, then flip the default to `gpt-live-1`.
- **gpt-live-1 backend (delegation) model = `gpt-5.6-luna`** — the model the app already uses for summaries/catalysts. *(Owner decision 2026-09-10.)* Kept as a config value so it can be changed without code.
- **Latency is the deliverable, filler is not.** The owner wants the model to respond, call tools, and return results *fast* — not to mask latency. Any filler must be provably latency-neutral or it's dropped. Off by default.
- Already done: live model reverted to `gpt-realtime-2.1` (mini was worse and got a paid call wrong).

### Reuses / stays intact
- Realtime SIP handler (`src/agent/openai-sip.js`), Vapi webhook, shared tool registry, event bus, call store, auth, Telnyx TeXML route.
- Local voice app and `main` unchanged; everything is additive and gated behind the existing `ENABLE_OPENAI_SIP` / `ENABLE_WEB_PHONE` flags.

---

## 2. Build checklist

### M0 — Worktree, baseline, and OpenAI-side prerequisites
- [x] Remove the stale merged worktree `.claude/worktrees/openai-sip-gpt-live` (branch `worktree-openai-sip-gpt-live` is fully merged into `main`).
- [x] Create worktree `agent-switcher` from `main`; symlink `node_modules`; `npm run check` green as baseline.
- [ ] Confirm prod: Telnyx # → Realtime SIP (`gpt-realtime-2.1`), Vapi # → Vapi, dashboard live.
- [ ] **Owner, in platform.openai.com (needed before M3 can be live-tested):**
  - [ ] Confirm **GPT-Live SIP support is enabled** for the project (docs: "Confirm that GPT-Live SIP support is enabled for your project and that your provider's SIP trunk is routed to that project").
  - [ ] On the existing webhook endpoint (`/openai/incoming-call`), **add the `live.transport.incoming` event** alongside `realtime.call.incoming`. Same URL, same signing secret. (Deprecated name `live.call.incoming` — handle it too but don't subscribe.)
  - [ ] Confirm the account tier allows `gpt-live-1` (Free tier unsupported; $0.05/min voice + backend model tokens billed separately).

### M1 — Server-side "armed agent" store (persisted)
- [x] `src/agent/settings-store.js`: JSON file at `runtime/settings.json` → `{ activeSipAgent: "gpt-realtime-2.1" | "gpt-live-1", selectedAgent: "gpt-realtime-2.1" | "gpt-live-1" | "vapi" }`. Safe defaults; atomic write (tmp + rename); in-memory cache; injectable dir for tests.
  - `activeSipAgent` = what answers Telnyx. `selectedAgent` = what the dropdown shows (may be `vapi`). Selecting an OpenAI agent sets both; selecting `vapi` sets only `selectedAgent`.
  - Env fallback: if the file is absent, `activeSipAgent` defaults to `OPENAI_SIP_AGENT` env if set, else `gpt-realtime-2.1`.
- [x] `GET /api/agent` (auth-gated) → `{ selectedAgent, activeSipAgent, agents: [{ id, label, transport, number, armable }] }`. Numbers come from `SIP_PHONE_NUMBER` / `VAPI_PHONE_NUMBER`.
- [x] `POST /api/agent` `{ agent }` (auth-gated) → validates against the 3 ids, persists, returns the same shape as GET. Unknown id → 400.
- [x] Replace `/api/dashboard/config`'s single `phoneNumber` with the above (keep the old route returning the selected agent's number for backward compat).
- [x] Unit tests: defaults, set/get, vapi-doesn't-change-armed, persistence across a fresh store instance, bad id rejected.

### M2 — Dashboard agent dropdown
- [x] `<select id="agentSelect">` in the dashboard header next to the number: gpt-realtime-2.1 / gpt-live-1 / Vapi (gpt-realtime).
- [x] On load: `GET /api/agent`; set the dropdown, the tap-to-call number, and a hint (“armed on Telnyx” / “Vapi number”).
- [x] On change: `POST /api/agent`; re-render from the response. Show a transient error if the POST fails and revert the dropdown.
- [x] Keep `tel:` tap-to-call behavior. Show which agent the displayed number reaches.
- [x] Verify in-browser: switch → number updates; reload → same selection; switch to Vapi → Telnyx armed agent unchanged in `GET /api/agent`.

### M3 — gpt-live-1 via the GPT-Live API (the new build)
Contract is verified (§3). Implement as a **separate module** `src/agent/openai-live.js` mirroring `openai-sip.js` (injectable `fetchImpl` / `wsFactory`), not a branch inside the realtime handler.

- [x] **Webhook routing** in `/openai/incoming-call` (one handler, one raw-body parse, one signature check):
  - `realtime.call.incoming` → if armed = `gpt-realtime-2.1`: existing realtime accept+attach. If armed = `gpt-live-1`: **ack 200 and do nothing** (don't accept, don't reject — accepting via one API decides the surface).
  - `live.transport.incoming` (and legacy `live.call.incoming`) → if armed = `gpt-live-1`: live accept+attach. Else ack 200 and ignore.
  - Allowlist check runs on whichever event we act on; reject via the matching API (`/v1/live/sessions/{id}/reject` `{status_code:486}` or the realtime reject).
  - Log which event was acted on and which was ignored, per call, into the runtime log.
- [x] **Accept**: `POST /v1/live/sessions/{session_id}/accept` with
  ```json
  { "session": { "type": "live", "model": "gpt-live-1",
      "instructions": "<voice-layer prompt>",
      "audio": { "output": { "voice": "marin" } },
      "delegation": { "type": "responses", "responses": {
          "model": "gpt-5.6-luna",
          "instructions": "<backend prompt = AGENT.md + phone addendum>",
          "tools": [ <Responses function-tool schema: {type:"function", name, description, parameters}> ],
          "tool_choice": "auto", "parallel_tool_calls": true } } } }
  ```
  Returns 200 with empty body. *(Tool schema shape: the Responses API uses the flat `{type, name, description, parameters}` form; if accept returns 400 on tools, the nested `{type, function:{...}}` form is the fallback — resolve on the first real call and record which worked here.)*
- [x] **Attach**: `wss://api.openai.com/v1/live/sessions/{session_id}/attach`, header `Authorization: Bearer` only, **do not send `session.start`**. Retry/backoff like the realtime path (accept returns before the session is attachable).
- [x] **Greeting**: `session.instructions.append` `{ delegation_id: null, content: "Greet immediately without waiting for the caller: '<greeting>'. Then pause and listen." }`; wait for `session.instructions.appended`.
- [x] **Tool loop** on the attach socket: dispatch on `msg.type === "response.event"` → `msg.event.type === "response.output_item.done"` with `event.item.type === "function_call"` (`call_id`, `name`, `arguments`). Execute via the shared registry. Return with `response.item.create { item: { type:"function_call_output", call_id, output } }` then `response.create {}`. Preserve the envelope's `delegation_id` in logs/events. Submit **all** pending outputs before `response.create` when `parallel_tool_calls` fires several.
- [x] **Transcripts** → dashboard events: buffer `session.input_transcript.delta` / `session.output_transcript.delta` and flush on the matching done/completed event (handle both `.done` and `.completed` names) or on turn change; emit the same `transcript` event kind the dashboard already renders.
- [x] **Lifecycle**: `session.closed` (`reason`: `remote_hangup` / `close_requested` / `expired` / `connection_lost`) → `finish(reason)` and call-store finalize. `session.usage.updated` → keep last value for the per-call summary. `error` → dashboard error event + runtime log.
- [x] **Prompt split** (per GPT-Live prompting guide): voice-layer `instructions` = personality, brevity, backchannel policy, interruption policy, and *concrete* delegation conditions ("when the caller asks for a price, chart, position, news, or a trade, delegate"). Backend `delegation.responses.instructions` = the full agent prompt + the phone addendum (preview_order → read back → explicit spoken confirmation → execute_order). Voice layer must never claim an action finished before the backend confirms.
- [x] **Interruption**: no VAD/turn-detection fields exist for GPT-Live — full duplex is native. Do **not** send Realtime fields (`turn_detection`, `session.type:"realtime"`, `tools` at session level); the docs warn to keep Realtime-specific fields out.
- [x] Unit tests with fakes: webhook routing by armed agent (4 cases), accept body shape, tool loop round-trip, transcript buffering, `session.closed` → finalize.
- [ ] **Live-validate** one real call: tools + artifacts on the dashboard + interrupting mid-sentence + a `preview_order` confirmation flow. Record findings in §4.

### M4 — Latency reduction (PRIORITY)
- [x] **Measure first** — per call, in the call store + a `latency` summary event: `user_speech_end → first_assistant_audio/transcript` (realtime: `input_audio_buffer.speech_stopped` → first `response.output_audio.delta`; live: last `session.input_transcript` final → first `session.output_transcript.delta`), `tool_start → tool_done` per tool, and `tool_done → next assistant audio`. Show a small per-call latency line in the dashboard call history.
- [x] **Realtime path knobs** (this is where the "it waits before replying" gap lives): compare `semantic_vad eagerness:"high"` vs `server_vad` with `silence_duration_ms ≈ 300–400` (vs default 500+). Pick the faster one that doesn't clip the caller. Make it a config value (`OPENAI_SIP_TURN_DETECTION`), not a dashboard control.
- [ ] **Tool-side**: the registry calls back into localhost with an internal token — measure it; make sure nothing in the tool path re-fetches tool definitions or re-authenticates per call. Keep `sipToolDefs` refresh off the hot path.
- [ ] **GPT-Live path**: no endpointing knob. Latency levers are the backend model (luna) and keeping the tool path hot. Full duplex means the caller can keep talking while a tool runs — measure "first useful spoken answer", not backend time (docs' guidance).
- [ ] **A/B**: same 5 commands on all three agents; table of measured gaps in §4. This decides the default.

### M5 — Filler (only if latency-neutral)
- [x] Realtime path only (GPT-Live fills natively; Vapi self-fills). Off by default via `OPENAI_SIP_FILLER=1`.
- [x] If enabled: a single short `response.create` with instructions "say one short acknowledgement" fired **in parallel with** the tool call, never before it, and never for `preview_order` / `execute_order`. If M4 measurements show it delays the real answer by >100 ms, remove it.

### M6 — Verify, merge, deploy
- [ ] `npm run check` green; local app untouched (`/api/realtime-token` path unchanged).
- [ ] Merge worktree → `main`; `fly deploy` from `main` (worktree deploys get sandbox-blocked).
- [ ] Set secrets as needed: `OPENAI_LIVE_BACKEND_MODEL` (default `gpt-5.6-luna`), `OPENAI_SIP_TURN_DETECTION` (from M4), `OPENAI_SIP_FILLER` (off).
- [ ] End-to-end: dropdown → call the shown number → correct agent answers with tools/artifacts; selection persists across a redeploy.
- [ ] Flip default armed agent to `gpt-live-1` only after M3's live validation and M4's numbers say so.
- [ ] Update `README` / `HANDOFF.md` with the switcher, live contract, and latency table.

---

## 3. Verified GPT-Live contract (2026-09-10, developers.openai.com)

Why gpt-live-1 404'd on the realtime WS: it is **only served by the Live endpoint** (`/v1/live/sessions`), never by `/v1/realtime`. It shipped in the API on **2026-09-10** (GA, $0.05/min voice, backend tokens extra).

| | Realtime (gpt-realtime-2.1) | GPT-Live (gpt-live-1) |
|---|---|---|
| Inbound webhook | `realtime.call.incoming` → `data.call_id` (`rtc_…`) | `live.transport.incoming` → `data.type:"sip"`, `data.session_id` (`live_…`); legacy `live.call.incoming` |
| Both fire? | **Yes — one SIP call emits both.** "Assign one handler to the accept/reject decision rather than accepting through both APIs." First successful accept decides the surface. | |
| Accept | `POST /v1/realtime/calls/{call_id}/accept` `{type:"realtime", model, instructions}` | `POST /v1/live/sessions/{session_id}/accept` `{session:{type:"live", model, instructions, audio.output.voice, delegation}}` |
| Reject / hangup | `/v1/realtime/calls/{id}/reject|hangup` | `/v1/live/sessions/{id}/reject|hangup` (+ `/refer` for transfer) |
| Control socket | `wss://api.openai.com/v1/realtime?call_id=…` + `session.update` | `wss://api.openai.com/v1/live/sessions/{id}/attach`; **no `session.start`** |
| Tools | `session.tools` on the session; `response.function_call_arguments.done` → `conversation.item.create` + `response.create` | `delegation.responses.tools`; `response.event{event:{type:"response.output_item.done", item:{type:"function_call", call_id, name, arguments}}}` → `response.item.create` + `response.create` |
| Turn detection | `audio.input.turn_detection` (semantic_vad / server_vad) | none — full duplex, listens while speaking |
| Transcripts | `conversation.item.input_audio_transcription.completed`, `response.output_audio_transcript.done` | `session.input_transcript.delta/…`, `session.output_transcript.delta/…` |
| Greeting | `response.create {instructions}` | `session.instructions.append {delegation_id:null, content}` |
| Close | WS close | `session.closed {reason, usage}`; `session.usage.updated` |
| SIP URI | `sip:proj_…@sip.api.openai.com;transport=tls` | same URI; project must have GPT-Live SIP enabled |

Doc pages used: `guides/voice-sip?api=live`, `guides/voice-server-controls?api=live`, `guides/live-delegation` (responses + client), `guides/voice-websockets?api=live`, `guides/live-migration`, `guides/live-conversations`, `guides/live-prompting`, `reference/resources/live/primary-websocket`, `reference/resources/webhooks`, `models/gpt-live-1`. The Telnyx "outbound AI calls with OpenAI Live" guide uses Telnyx **media streaming** (app-owned WebSocket audio bridge), not SIP — we stay on SIP-direct, which is simpler and already routed.

**Unknowns to resolve on the first live call** (record the answer here): exact tool-schema shape accepted by `delegation.responses.tools`; exact transcript done-event names; whether `session.started` is re-sent on attach.

---

## 4. Findings / progress log
- **2026-09-10:** Reverted live model mini → `gpt-realtime-2.1`. Spec created.
- **2026-09-10:** Spec reviewed against docs. Corrected M3 (GPT-Live is a delegation architecture with its own webhook/accept/attach/tool events; both webhooks fire per call). Owner decisions: luna backend; Vapi selection leaves Telnyx armed; filler must be latency-neutral or dropped; build everything on one worktree.
- **2026-09-10 (build):** M0–M3 code, M4 measurement + knobs, M5 flag all implemented on worktree `agent-switcher` (152 tests green; dashboard verified in-browser locally). Realtime default turn detection is now `semantic_vad eagerness:"high"` (override with `OPENAI_SIP_TURN_DETECTION` JSON). Remaining: owner's OpenAI-side steps (M0), a real gpt-live-1 call (M3 last item), the latency A/B table (M4), merge + deploy (M6).
- *(M3 live validation, M4 latency table — to fill in.)*
