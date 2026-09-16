---
name: launch-web-vapi
description: Deploy the Coinbase for Agents voice trading agent as a hosted web dashboard plus a phone number you can call from anywhere, using Vapi for the phone leg and Fly.io for hosting. Use when someone wants the web/phone version with Vapi, wants to call their agent, or needs help with Fly, Vapi, or dashboard setup.
metadata:
  source: "https://github.com/Must-be-Ash/c4a-gpt-realtime"
  variant: "web + phone via Vapi"
---

# Launch Coinbase for Agents — Web + Phone (Vapi)

Help the user deploy their own hosted copy of:

https://github.com/Must-be-Ash/c4a-gpt-realtime

Result: a private web dashboard (charts, reports, previews, live captions) and a **phone number** they call to talk to their agent. Vapi provides the number and runs OpenAI Realtime speech-to-speech on the user's own OpenAI key; this server executes every tool. Fly.io hosts it on one always-on machine.

This is the **fastest hosted path**. If the user wants to run OpenAI's newest voice models directly (gpt-live-1, gpt-realtime-2.1) they want the `launch-web-openai` skill instead; both can coexist on one deployment.

Own the setup from preflight through the first real phone call. Run commands, inspect results, and fix failures yourself. Pause only for choices, account creation, payment, consent, or secret entry the user must do.

## Operating rules

- Keep a short checklist; update it as stages pass.
- Ask one concise question only when the answer changes the next action.
- Never ask the user to paste any API key, token, secret, or wallet material into chat. Secrets go into a local `.env` (never committed) and from there into Fly secrets via `fly secrets import`. Never echo secret values, put them in command arguments that would be logged, or commit them.
- Name any external resource before creating it (GitHub fork, Fly app, Fly volume, Vapi assistant/number changes) and get confirmation. Fly and Vapi both bill the user.
- Never place an order, fund a wallet, or run a paid data call as a setup test.
- Do not weaken the trade confirmation flow or the caller allowlist.
- Resume from the blocked stage after a manual action; do not restart the runbook.

## 1. Confirm the target

Determine:

1. Fork vs clone (recommend fork). Parent directory; default folder `c4a-gpt-realtime`.
2. Capability profile: **Research** (OpenAI + Exa), **Trading** (adds Coinbase), **Paid data** (adds AgentCash).
3. The user's own phone number (the only number allowed to call the agent).
4. That the user accepts three billed services: Fly.io (small always-on VM, a few dollars/month), Vapi (per-minute plus a phone number), and OpenAI (realtime tokens on their key).

## 2. Preflight

Check: `git --version`, `node --version` (22+), `npm --version`, `gh auth status` (for a fork), and the Fly CLI:

    fly version || curl -L https://fly.io/install.sh | sh

Install the Fly CLI if missing and make sure it is on PATH. Then have the user sign in in their own browser:

    fly auth login

If the user has no Fly account, the login page creates one. A payment method is required before an app can run; tell the user to add it at https://fly.io/dashboard/personal/billing and wait.

## 3. Fork or clone, install, verify

Same as the local skill: fork/clone, `npm install`, `npm run check` must pass, `cp .env.example .env` only if absent, `git check-ignore .env`.

## 4. Configure the app profile in `.env`

The user enters these directly in `.env` (never in chat):

- `OPENAI_API_KEY` — https://platform.openai.com/api-keys
- `EXA_API_KEY` — https://dashboard.exa.ai/api-keys
- Trading profile: `COINBASE_KEY_ID`, `COINBASE_KEY_SECRET` from https://portal.cdp.coinbase.com/api-keys/secret (dedicated, minimally funded portfolio; View + Trade only). Preserve multiline key formatting.

Verify presence only (names / booleans, never values).

## 5. Hosted settings in `.env`

Add these to the same `.env`; explain each in one line:

- `ENABLE_WEB_PHONE=1`
- `PUBLIC_BASE_URL=https://<app>.fly.dev` (decide the Fly app name now; it must be globally unique, e.g. `c4a-<username>`)
- `DASHBOARD_PASSWORD` — user-chosen password for the private dashboard
- `SESSION_SECRET` — generate: `openssl rand -hex 32`
- `VAPI_WEBHOOK_SECRET` — generate: `openssl rand -hex 24`
- `PHONE_NUMBER=+1XXXXXXXXXX` — the user's own number (E.164). Only this caller gets through.
- `VAPI_PRIVATE_KEY`, `VAPI_AGENT_ID`, `VAPI_PHONE_NUMBER` — filled in step 7.

Paid data (optional): the AgentCash wallet lives in `~/.agentcash/` locally. To use it hosted, stage each file as base64 in `.env`:

    AGENTCASH_WALLET_JSON_B64=$(base64 < ~/.agentcash/wallet.json)
    AGENTCASH_SOLANA_WALLET_JSON_B64=$(base64 < ~/.agentcash/solana-wallet.json)
    AGENTCASH_STATE_JSON_B64=$(base64 < ~/.agentcash/state.json)

Only do this if the user chose paid data and has run `npx agentcash@latest onboard` locally; confirm before touching wallet files.

## 6. Create and deploy the Fly app

State the app name and region, get confirmation, then:

    fly apps create <app>
    fly volumes create data --size 1 --region <region> -a <app>
    fly secrets import -a <app> < .env
    fly deploy --remote-only --ha=false -a <app>

`fly.toml` already sets one always-on machine (`min_machines_running = 1`, no auto-stop) so the webhook never cold-starts. If the repo's `fly.toml` has a different `app` name, pass `-a <app>` on every command rather than editing it, or update it in the fork and commit.

Verify:

    curl --fail https://<app>.fly.dev/healthz
    fly logs -a <app> --no-tail | tail -20

Look for `web_phone.enabled` in the logs. Open `https://<app>.fly.dev/dashboard`, log in with the dashboard password, confirm the page loads.

## 7. Wire up Vapi

Have the user do these in the Vapi dashboard (https://dashboard.vapi.ai):

1. Create an account.
2. **Integrations → Model Providers → OpenAI**: add their OpenAI API key (BYOK), so realtime billing runs on their OpenAI account.
3. **Phone Numbers**: buy or import a number. Put it in `.env` as `VAPI_PHONE_NUMBER`.
4. **Assistants**: create an empty assistant (any name). Put its id in `.env` as `VAPI_AGENT_ID`.
5. **API Keys**: copy the private key into `.env` as `VAPI_PRIVATE_KEY`.

Then re-import secrets (`fly secrets import -a <app> < .env`) and configure the assistant + number from the repo. Tools are enumerated from a local unauthenticated server so the live Coinbase tools are included, while the tools' webhook points at production:

    PORT=4173 ENABLE_WEB_PHONE=1 node src/server.js &
    TOOLS_BASE_URL="http://127.0.0.1:4173" node scripts/configure-vapi.mjs --dry-run
    TOOLS_BASE_URL="http://127.0.0.1:4173" node scripts/configure-vapi.mjs
    kill %1

The script reads `PUBLIC_BASE_URL`, `VAPI_*`, and `VAPI_WEBHOOK_SECRET` from `.env`. It registers every tool, sets the phone-call system prompt, and routes the number's inbound calls through `/vapi/webhook` (which enforces the caller allowlist). Vapi accepts only models on its allowlist; the script uses `gpt-realtime-2025-08-28` and falls back to it automatically if another name is rejected.

Then apply the tuned turn-taking settings (barge-in on the first word, short wait after the caller stops, no tool narration):

    node scripts/tune-vapi.mjs

## 8. First call

Open the dashboard, select **Vapi (gpt-realtime)** in the header dropdown so it shows the Vapi number, and have the user call it from their allowlisted phone. Smoke test with read-only requests:

    What's the current BTC price?
    Show me the Bitcoin chart for the past week.

The chart should appear on the dashboard within a second and captions should pass along the bottom. If Coinbase is configured, a read-only balance request is fine. Never preview or execute an order during setup.

Diagnostics: `fly logs -a <app>`; per-call event streams are in `/app/runtime/calls/` on the volume (`fly ssh console -a <app> -C "ls /app/runtime/calls"`).

## 8b. Optional: outbound pitch calls ("Jordan")

Only if the user asks for the agent to call them with trade ideas. It needs an idea source: a Postgres database with the research desk's `ledger`, `theses`, and `identity` tables, reached through a SELECT-only role. Create that role with SQL (`CREATE ROLE … LOGIN`, `default_transaction_read_only = on`, `GRANT SELECT` on those three tables only). On Neon, don't use the console/API for this, because those roles join `neon_superuser`.

1. The user buys a second Telnyx voice number and leaves it unassigned. Free Vapi numbers can't dial out.
2. Import it into Vapi (`POST /credential` with `provider: telnyx` and their Telnyx API key, then `POST /phone-number` with `provider: telnyx`). Attach the "Vapi" call-control app that Vapi creates in Telnyx to an outbound voice profile that allows the user's country.
3. The user adds their ElevenLabs `sk_` key in Vapi → Integrations → Voice Providers.
4. Put the pitch block from `.env.example` in `.env` (`DESK_DATABASE_URL`, `VAPI_PITCH_PHONE_NUMBER_ID`, `PITCH_PHONE_NUMBER`, `ELEVENLABS_*`) and run `node scripts/configure-vapi-pitch.mjs`. Save the printed `VAPI_PITCH_ASSISTANT_ID`.
5. Set those as Fly secrets with `ENABLE_PITCH_CALLS=1` and `PITCH_DRY_RUN=1`, deploy, and check `/app/runtime/events.jsonl` for `pitch.dry_run`. Then unset `PITCH_DRY_RUN`.

With the user's go-ahead, smoke test with one outbound call. Never place an order during setup.

## 9. Finish cleanly

`npm run check` after any source change. Confirm `.env`, `runtime/`, wallets, and credentials are not in `git status`. If a fork was created and source changed, summarize the non-secret diff and ask before committing.

Done when: the Fly app is healthy, the dashboard logs in, the Vapi number answers only the allowlisted phone, a read-only voice request renders on the dashboard, and no secrets are in Git. Hand back: fork URL, app URL, dashboard URL, the phone number, and which optional integrations are unconfigured. Remind the user that orders require an explicit preview and fresh spoken confirmation.
