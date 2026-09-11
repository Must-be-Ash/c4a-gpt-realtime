# Option B — Direct OpenAI Realtime (SIP), so we can run GPT‑Live‑1

**Why:** Vapi only allows models on its curated list — it **rejected `gpt-live-1`** (and `gpt-realtime-2.1`). OpenAI's Realtime API speaks **SIP natively**, so we point a phone line straight at OpenAI and choose **any** realtime model ourselves (`gpt-realtime` today, `gpt-live-1` the moment your account has it). Vapi is removed from the path.

This is built on the **`worktree-openai-sip-gpt-live`** branch (in `.claude/worktrees/openai-sip-gpt-live`). **`main` is untouched** and remains the working, deployed rollback version.

## Architecture
```
Your phone ──► Telnyx number ──SIP──► OpenAI Realtime (model = your choice, your key)
                                        │  realtime.call.incoming ─► POST /openai/incoming-call (our server)
                                        │      verify signature → caller allowlist → accept w/ session
                                        │      (instructions + tools + semantic_vad barge-in)
                                        ▼
                        our server ◄── function calls over realtime WS ── OpenAI
                             └─► tool registry + dashboard event bus + call history  (all reused)
```
Native barge-in is set to `semantic_vad` + `interrupt_response` — the smooth interruption behavior you had locally (the control Vapi didn't expose).

## What's built (this branch)
- `src/agent/openai-sip.js` — webhook handler (Standard-Webhooks signature verify, caller allowlist, accept/reject) + realtime-WS tool loop (reuses the shared tool registry) + transcript/tool events to the dashboard. `fetch`/`WebSocket` injected for tests.
- `src/server.js` — mounts `POST /openai/incoming-call` (raw body) behind `ENABLE_OPENAI_SIP`; shares the dashboard, auth, event bus, call history with the existing setup. Vapi (`ENABLE_WEB_PHONE`) and SIP (`ENABLE_OPENAI_SIP`) can run independently or together.
- `src/config.js` — new env: `ENABLE_OPENAI_SIP`, `OPENAI_SIP_MODEL` (default `gpt-realtime-2025-08-28`), `OPENAI_WEBHOOK_SECRET`, `SIP_PHONE_NUMBER`.
- `package.json` — adds `ws` (for the authenticated realtime socket).
- `test/openai-sip.test.js` — 4 tests (signature, allowlist accept/reject, tool loop). Full suite green (138).

## What YOU need to do (then I finish + we deploy)
1. **Telnyx** ([telnyx.com](https://telnyx.com)) — create an account, buy a phone number, and set up a **SIP trunk / voice profile** that routes that number to OpenAI's SIP endpoint:
   `sip:<OPENAI_PROJECT_ID>@sip.api.openai.com;transport=tls`
   → give me the **phone number** (`SIP_PHONE_NUMBER`).
2. **OpenAI** (platform.openai.com, your project):
   - **Webhooks** → add an endpoint `https://<app-domain>/openai/incoming-call`; copy the **signing secret** → `OPENAI_WEBHOOK_SECRET`.
   - Note your **Project ID** (for the SIP URI above).
   - Confirm **`gpt-live-1` access** (else we run `gpt-realtime-2025-08-28` and flip later).
   *(Your OpenAI API key is already configured.)*
3. **Keys I need from you:** the Telnyx number, the OpenAI webhook signing secret, and the OpenAI project ID.

## Deploy (when the above is ready)
- Set secrets: `ENABLE_OPENAI_SIP=1`, `OPENAI_WEBHOOK_SECRET`, `SIP_PHONE_NUMBER`, and `OPENAI_SIP_MODEL=gpt-live-1` (or leave default). Optionally set `ENABLE_WEB_PHONE=` (empty) to retire the Vapi number, or keep both.
- Run `npm install` once to sync `package-lock.json` with the new `ws` dependency, then deploy this branch (to the existing Fly app or a fresh one).
- **Rollback:** `main` is unchanged — redeploy it to instantly return to the working Vapi version.

## Notes / caveats
- The exact OpenAI SIP **accept/session** field names and event names are implemented per the current docs; I'll verify them against the live API on the first real call and adjust if OpenAI tweaked anything.
- Cost: Telnyx number + per-minute PSTN + OpenAI realtime ($0.05/min for gpt-live-1) + AgentCash paid data. No Vapi fee.
