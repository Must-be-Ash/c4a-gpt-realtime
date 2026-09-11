---
name: launch-web-openai
description: Deploy the Coinbase for Agents voice trading agent as a hosted web dashboard plus a phone number that connects directly to OpenAI (gpt-live-1 or gpt-realtime-2.1 over SIP via Telnyx), hosted on Fly.io. Use when someone wants the web/phone version on OpenAI's newest voice models without a managed voice platform, or needs help with Telnyx, OpenAI SIP webhooks, or the dashboard.
metadata:
  source: "https://github.com/Must-be-Ash/c4a-gpt-realtime"
  variant: "web + phone via OpenAI SIP (Telnyx)"
---

# Launch Coinbase for Agents — Web + Phone (OpenAI direct: gpt-live-1 / gpt-realtime-2.1)

Help the user deploy their own hosted copy of:

https://github.com/Must-be-Ash/c4a-gpt-realtime

Result: a private web dashboard and a **phone number** routed straight to OpenAI over SIP. No voice platform in between: the user picks the model from a dropdown on the dashboard — **gpt-live-1** (default) or **gpt-realtime-2.1** — and this server runs every tool. Telnyx provides the number and SIP trunk; Fly.io hosts the server.

If the user wants the quickest possible hosted setup with a managed voice platform, that is the `launch-web-vapi` skill; both can coexist on one deployment.

Own the setup from preflight through the first real phone call. Run commands, inspect results, and fix failures yourself. Pause only for choices, account creation, payment, consent, or secret entry the user must do.

## Operating rules

- Keep a short checklist; update it as stages pass.
- Ask one concise question only when the answer changes the next action.
- Never ask the user to paste any API key, token, secret, or wallet material into chat. Secrets go into a local `.env` (never committed) and then into Fly via `fly secrets import`. Never echo values or log them.
- Name any external resource before creating it (GitHub fork, Fly app/volume, Telnyx number/apps, OpenAI webhook) and get confirmation. Fly, Telnyx, and OpenAI all bill the user.
- Never place an order, fund a wallet, or run a paid data call as a setup test.
- Do not weaken the trade confirmation flow or the caller allowlist.
- Resume from the blocked stage after a manual action.

## 1. Confirm the target

Determine:

1. Fork vs clone (recommend fork). Parent directory; default folder `c4a-gpt-realtime`.
2. Capability profile: **Research** (OpenAI + Exa), **Trading** (adds Coinbase), **Paid data** (adds AgentCash).
3. The user's own phone number (the only caller allowed).
4. Billing acceptance: Fly.io (small always-on VM), Telnyx (number + per-minute), OpenAI (gpt-live-1 is $0.05/min voice plus backend tokens; gpt-realtime-2.1 is billed per token). Free-tier OpenAI accounts cannot use gpt-live-1.

## 2. Preflight

Check `git`, `node` (22+), `npm`, `gh auth status` (fork), and the Fly CLI:

    fly version || curl -L https://fly.io/install.sh | sh
    fly auth login

Fly needs a payment method on the account (https://fly.io/dashboard/personal/billing) before an app runs.

## 3. Fork or clone, install, verify

Fork/clone, `npm install`, `npm run check` must pass, `cp .env.example .env` only if absent, `git check-ignore .env`.

## 4. Configure the app profile in `.env`

User enters directly in `.env`:

- `OPENAI_API_KEY` — https://platform.openai.com/api-keys (this key also pays for the phone voice model)
- `EXA_API_KEY` — https://dashboard.exa.ai/api-keys
- Trading: `COINBASE_KEY_ID`, `COINBASE_KEY_SECRET` from https://portal.cdp.coinbase.com/api-keys/secret (dedicated portfolio; View + Trade only; preserve multiline formatting)

Verify presence only.

## 5. Hosted settings in `.env`

- `ENABLE_WEB_PHONE=1` (mounts the dashboard, auth, and call history)
- `ENABLE_OPENAI_SIP=1` (mounts the OpenAI SIP webhook and the Telnyx TeXML route)
- `PUBLIC_BASE_URL=https://<app>.fly.dev` (pick a unique Fly app name now)
- `DASHBOARD_PASSWORD` — user's choice
- `SESSION_SECRET` — `openssl rand -hex 32`
- `PHONE_NUMBER=+1XXXXXXXXXX` — the user's own number; only it can reach the agent
- `OPENAI_PROJECT_ID` — from https://platform.openai.com/settings (Project → General → Project ID, `proj_…`)
- `OPENAI_SIP_AGENT=gpt-live-1` — which model answers by default; the dashboard dropdown switches it later and the choice persists
- `OPENAI_WEBHOOK_SECRET` and `SIP_PHONE_NUMBER` — filled in steps 7 and 8
- Optional: `OPENAI_LIVE_BACKEND_MODEL` (default `gpt-5.6-luna`), `OPENAI_LIVE_REASONING_EFFORT` (default `low`), `OPENAI_SIP_MODEL` (default `gpt-realtime-2.1`)

Leave `VAPI_*` blank unless the user also wants the Vapi path.

Paid data (optional, only if the user chose it and has onboarded AgentCash locally; confirm first):

    AGENTCASH_WALLET_JSON_B64=$(base64 < ~/.agentcash/wallet.json)
    AGENTCASH_SOLANA_WALLET_JSON_B64=$(base64 < ~/.agentcash/solana-wallet.json)
    AGENTCASH_STATE_JSON_B64=$(base64 < ~/.agentcash/state.json)

## 6. Create and deploy the Fly app

Confirm app name and region, then:

    fly apps create <app>
    fly volumes create data --size 1 --region <region> -a <app>
    fly secrets import -a <app> < .env
    fly deploy --remote-only --ha=false -a <app>

Verify `curl --fail https://<app>.fly.dev/healthz` and `fly logs -a <app> --no-tail | tail -20` (expect `web_phone.enabled` and `openai_sip.enabled`). The public URL is needed for the next two steps.

## 7. OpenAI: webhook for inbound calls

In https://platform.openai.com → **Settings → Project → Webhooks → Create**:

- URL: `https://<app>.fly.dev/openai/incoming-call`
- Event types: **both** `realtime.call.incoming` and `live.transport.incoming`. One phone call emits both; the server acts on whichever matches the model armed in the dashboard and ignores the other.
- Copy the signing secret (`whsec_…`) into `.env` as `OPENAI_WEBHOOK_SECRET`.

Also confirm in **Audio → Live** in the OpenAI platform that `gpt-live-1` is selectable for the project (it is on paid tiers). No other OpenAI-side switch is needed.

## 8. Telnyx: number and SIP trunk to OpenAI

Have the user do these in https://portal.telnyx.com (each is a billed resource; state it before they click):

1. Create an account and add a payment method.
2. **Numbers → Buy Numbers**: buy a voice-capable number. Put it in `.env` as `SIP_PHONE_NUMBER` (E.164).
3. **Voice → Outbound Voice Profiles**: create one (any name, allow the user's country). The TeXML app must have this attached or the leg to OpenAI fails with "not available".
4. **Voice → TeXML Applications → Create**:
   - Voice webhook URL: `https://<app>.fly.dev/telnyx/texml` (HTTP POST)
   - Outbound voice profile: the one from step 3
5. **Numbers → My Numbers**: assign the number to that TeXML application.

What this does: on an inbound call Telnyx fetches TeXML from the server, which replies `<Dial><Sip>sip:<project id>@sip.api.openai.com;transport=tls</Sip></Dial>`, forwarding the caller ID for the allowlist. When gpt-live-1 is armed the server adds `;secure=srtp` because GPT-Live requires SRTP media. No manual SIP trunk configuration is needed.

If the user has a `TELNYX_API_KEY` and prefers, the same can be done with the Telnyx v2 API (`/v2/outbound_voice_profiles`, `/v2/texml_applications` with `outbound.outbound_voice_profile_id`, then `PATCH /v2/phone_numbers/{id}` with `connection_id`), but number purchase still happens in the portal.

Re-import secrets and redeploy so the webhook secret and number are live:

    fly secrets import -a <app> < .env

(Fly restarts the machine automatically on secret changes.)

## 9. First call

Open `https://<app>.fly.dev/dashboard`, log in, and check the header dropdown. It lists **gpt-realtime-2.1**, **gpt-live-1**, and **Vapi**; the two OpenAI options share the Telnyx number and the dropdown arms which one answers. Tell the user they can switch between gpt-live-1 and gpt-realtime-2.1 there at any time; the choice persists across restarts.

Have the user call the Telnyx number from their allowlisted phone and smoke test with read-only requests:

    What's the current BTC price?
    Show me the Bitcoin chart for the past week.

The chart should appear on the dashboard and captions pass along the bottom. Never preview or execute an order during setup.

Diagnostics, in order:

- `fly logs -a <app>`: `openai.webhook.routed` shows which event was acted on; `openai.live.accept_failed` / `openai.sip.accept_failed` include OpenAI's error body (for example `srtp_required`, or a signature failure meaning the webhook secret is wrong).
- `telnyx.texml.served` missing means the number is not pointed at the TeXML app.
- Caller hears "not available": the TeXML app has no outbound voice profile.
- Per-call event streams: `fly ssh console -a <app> -C "ls /app/runtime/calls"`.

## 10. Finish cleanly

`npm run check` after any source change; confirm no secrets or runtime state in `git status`; ask before committing to a fork.

Done when: Fly app healthy, dashboard logs in, the Telnyx number answers only the allowlisted phone with the armed model, a read-only voice request renders on the dashboard, and no secrets are in Git. Hand back: fork URL, app URL, dashboard URL, phone number, the armed model, and unconfigured optional integrations. Remind the user that orders require an explicit preview and fresh spoken confirmation.
