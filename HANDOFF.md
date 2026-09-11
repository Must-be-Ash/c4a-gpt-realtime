# Handoff — Coinbase for Agents: hosted phone + web, 3-agent switcher

Read this, then `AGENT_SWITCHER_SPEC.md` (the checklist, with the verified GPT-Live contract in §3), then the code. Code is the source of truth.

## The vision
A local browser voice trading/research agent (OpenAI speech-to-speech + Coinbase + Exa + AgentCash) that the owner can also **phone from anywhere** and **watch on a private dashboard**. Priorities: (1) low latency + natural interruption, (2) run OpenAI's newest models directly (gpt-live-1), (3) switch between backends and compare, (4) never break `main`; additive and gated; owner approves purchases.

## Where things are (2026-09-10)
- **Prod** `https://coinbase-for-agents-phone.fly.dev` (Fly, one always-on machine, password-gated) runs `main` = Telnyx number → OpenAI Realtime SIP (`gpt-realtime-2.1`), Vapi number → Vapi. Working.
- **Worktree `agent-switcher`** (`.claude/worktrees/agent-switcher`, branch `agent-switcher`) has the phase-2 build, **not yet merged or deployed**:
  - `src/agent/settings-store.js` — persisted `runtime/settings.json` `{activeSipAgent, selectedAgent}`; `GET/POST /api/agent`.
  - Dashboard dropdown (gpt-realtime-2.1 / gpt-live-1 / Vapi) that shows the right number and arms the Telnyx number. Selecting Vapi leaves the armed OpenAI agent alone.
  - `src/agent/openai-live.js` — **gpt-live-1 over the GPT-Live API** (accept `/v1/live/sessions/{id}/accept`, attach `/v1/live/sessions/{id}/attach`, Responses delegation with backend `gpt-5.6-luna`, tool loop via `response.event` → `response.item.create` + `response.create`).
  - `src/agent/openai-webhook-router.js` — one SIP call emits **both** `realtime.call.incoming` and `live.transport.incoming`; the router acts on exactly one based on the armed agent.
  - `src/agent/latency.js` — per-call `latency` events (reply gap per turn, tool durations, end-of-call summary) on both OpenAI paths; dashboard pill shows the median.
  - Realtime path: turn detection now `semantic_vad eagerness:"high"` by default (`OPENAI_SIP_TURN_DETECTION` JSON overrides), optional input transcription (`OPENAI_SIP_TRANSCRIBE_MODEL`), optional filler (`OPENAI_SIP_FILLER=1`, off).
  - 152 tests green (`npm run check`). Dashboard verified in-browser locally.

## What's left (in order)
1. **Owner, OpenAI dashboard:** enable GPT-Live SIP for the project; add the `live.transport.incoming` event to the existing webhook endpoint (same URL/secret); confirm tier supports `gpt-live-1`.
2. Merge `agent-switcher` → `main`, `fly deploy` from `main` (deploying from inside the worktree gets sandbox-blocked). New secrets are optional; defaults are sane. `OPENAI_SIP_MODEL` default moved to `gpt-realtime-2.1` (prod already sets it).
3. Arm `gpt-live-1` in the dropdown, make a real call. Watch `runtime/events.jsonl` for `openai.live.*` and the call's event stream. Resolve the three unknowns listed in spec §3 (tool schema shape accepted by `delegation.responses.tools`, transcript done-event names, whether `session.started` arrives on attach) and record them in the spec.
4. Run the same 5 commands on all three agents; fill the latency table in spec §4; then flip the default armed agent to `gpt-live-1` (`OPENAI_SIP_AGENT=gpt-live-1` or just select it — it persists).

## Hard-won learnings
- **Realtime SIP:** call WS is `wss://api.openai.com/v1/realtime?call_id=…` with only `Authorization: Bearer` (an `OpenAI-Beta` header 404s). `session.update` needs `session.type:"realtime"`, `turn_detection` under `audio.input`, `voice` under `audio.output`; otherwise it fails silently and tools never register. The call event stream is the best diagnostic.
- **GPT-Live is a different API**, not a model swap: separate webhook, accept, attach socket, and a delegation architecture (voice layer + backend model). No VAD knobs; full duplex is native. Keep Realtime fields out of the live session. gpt-live-1 shipped in the API on 2026-09-10 ($0.05/min voice + backend tokens).
- **Telnyx:** number → TeXML app whose voice webhook returns `<Dial><Sip>sip:proj_…@sip.api.openai.com;transport=tls</Sip></Dial>`; the app needs an outbound voice profile.
- **Vapi:** allowlisted models only; strict tool JSON schemas. Kept as the comparison path.
- **Local dev quirk:** Express `sendFile` refuses paths containing dot-segments, so running the server from inside `.claude/worktrees/...` 404s the dashboard. Test from a copy outside a dot directory (or merge first).
