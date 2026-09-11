# Coinbase for Agents

Your own low-latency voice research and trading agent. It uses OpenAI Realtime for responsive conversation, Coinbase for equities, crypto, US futures, portfolio data, and guarded trading, Exa for live web research, and AgentCash for optional paid data and custom artifacts.

## Get started with your coding agent

There are three ways to run it. Pick one, paste the matching prompt into Codex, Claude Code, Cursor, or another coding agent, and the agent walks you through accounts, API keys, verification, and (for the hosted paths) deployment. The landing page at [coinbase-for-agents.vercel.app](https://coinbase-for-agents.vercel.app) has a toggle that produces the right prompt and shows the matching demo.

| Path | What you get | Prompt |
|---|---|---|
| **Local** | Voice agent in your browser on your laptop. | `Read https://coinbase-for-agents.vercel.app/skill and help me set up my own trading agent locally.` |
| **Web + phone via Vapi** (fastest hosted) | A phone number you call from anywhere plus a private web dashboard. Vapi runs OpenAI Realtime on your key; Fly.io hosts the server. | `Read https://coinbase-for-agents.vercel.app/skill-web-vapi and help me deploy my own trading agent as a web dashboard with a phone number I can call, using Vapi.` |
| **Web + phone via OpenAI direct** | Same dashboard, but the number connects straight to OpenAI over SIP (Telnyx). Switch between **gpt-live-1** and **gpt-realtime-2.1** from a dropdown on the dashboard. | `Read https://coinbase-for-agents.vercel.app/skill-web-openai and help me deploy my own trading agent as a web dashboard with a phone number that connects directly to OpenAI (gpt-live-1 or gpt-realtime-2.1 over SIP via Telnyx).` |

The skills themselves live in [`skills/`](skills/): [`launch-coinbase-for-agents`](skills/launch-coinbase-for-agents/SKILL.md) (local), [`launch-web-vapi`](skills/launch-web-vapi/SKILL.md), and [`launch-web-openai`](skills/launch-web-openai/SKILL.md). Both hosted paths can coexist on one deployment; the dashboard dropdown shows the number to call for whichever agent you pick.

All research, market data, balances, previews, and orders use live providers. The application contains no runtime mock-data mode.

> This is an experimental prototype, not financial advice. Live mode can place real Coinbase orders after spoken confirmation. Use a dedicated portfolio with limited funds and permissions.

## Requirements

- Node.js 22 or newer
- A browser with microphone access
- An OpenAI API key
- An Exa API key for news research
- Coinbase credentials for balances and trading. The current Coinbase for Agents CLI is pinned as a local project dependency and installed by `npm install`—no global CLI install is required.

```bash
npm exec -- coinbase --version
```

Set up AgentCash once on the local machine, then fund it if you want to use paid endpoints:

```bash
npx agentcash@latest onboard
npx agentcash@latest balance
```

The app starts AgentCash's MCP server itself. Search and endpoint discovery work without payment; paid fetches require a funded AgentCash wallet. Paid requests prefer x402 on Base, while endpoint-specific Solana, Tempo, or MPP requirements are preserved. Wallet-file changes are detected automatically, so replacing a local wallet does not require restarting the app.

Paid-data recovery is outcome-based rather than endpoint-specific. The app blocks an unchanged failed request before it can be paid for again. Validation failures are returned to the agent so it can correct the arguments, while empty or broken endpoints trigger discovery of another suitable provider. The agent only reports that data is unavailable after materially different attempts and provider discovery have both been exhausted.

Set `ORTHOGONAL_API_KEY` to add Orthogonal's catalog as a discovery source. Orthogonal only finds endpoints and their schemas; AgentCash still executes and pays the returned x402 or MPP URL. The app does not use Orthogonal's run endpoint.

Voice transcripts and redacted tool request/result/error diagnostics are written to `runtime/events.jsonl`. Paid calls also record their intent, endpoint, outcome, failure class, attempt count, distinct-endpoint count, and discovered-alternative count. The runtime directory is ignored by Git and can be inspected when debugging a demo failure.

## Or run locally yourself

```bash
git clone https://github.com/Must-be-Ash/c4a-gpt-realtime.git
cd c4a-gpt-realtime
npm install
cp .env.example .env
npm run dev
```

Add the required keys to `.env`, then open [http://localhost:4173/app/](http://localhost:4173/app/). The project landing page is served at [http://localhost:4173](http://localhost:4173).

Provide `COINBASE_KEY_ID` and `COINBASE_KEY_SECRET` to enable balances, real previews, and order execution.

## What is live

| Feature | Source |
| --- | --- |
| Voice conversation and captions | OpenAI Realtime over WebRTC |
| Spot prices, 60-day volume comparison | Coinbase public market API |
| Candlestick charts | Coinbase public candle API |
| Order-book depth | Coinbase public product-book API |
| News and relevant factors | Exa search, summarized by OpenAI |
| Prediction-market sentiment | Polymarket public search API |
| Perpetual positioning and funding | Hyperliquid public API, with optional Nansen position data over x402 |
| Position and concentration risk | Coinbase portfolios and open orders |
| Trade-size impact and estimated fees | Coinbase live order book and account fee tier |
| On-chain token and cohort flows | Nansen token screener and flow intelligence over x402 |
| Upcoming project, macro, and regulatory catalysts | Exa search, date-grounded by OpenAI |
| Equities, spot crypto, US futures, balances, products, order history, fills, and conversion quotes | Coinbase for Agents CLI/MCP |
| Paid data, enrichment, and premium APIs | AgentCash over x402 or MPP |
| Additional paid-API discovery | Orthogonal catalog (optional) |

The research asset is inferred from speech. Crypto-specific views accept Coinbase USD products; general live research can cover any subject through Exa and paid x402 sources. Coinbase's dynamic tools expose the current product catalog across supported S&P 500 equities, spot crypto, and US futures.

Every voice order uses a guarded preview and fresh confirmation. Raw Coinbase mutations are excluded from the agent's dynamic tool catalog, so an order cannot bypass this flow. For priced orders, the server fetches the selected product's live `base_increment` and `quote_increment`, converts quote-currency sizing when appropriate, and quantizes size and price before Coinbase sees the preview. Futures are sized in contracts. Extended-hours equities use Coinbase's documented whole-share limit-order sessions.

These views are requested independently rather than bundled together. Example prompts include “show HYPE derivatives positioning,” “estimate the impact of buying $5,000 of BTC,” “show my position risk,” “show HYPE on-chain flows,” and “what catalysts are scheduled for HYPE in the next 90 days?”

## Hosted: web dashboard + phone (optional)

The app can also run **hosted** so you can phone the agent and watch it from a browser without your laptop. This is **additive**: local `npm run dev` is unchanged. Everything hosted is gated behind `ENABLE_WEB_PHONE=1`; with it unset none of it mounts.

- **Web:** a private dashboard at `/dashboard` (password via `DASHBOARD_PASSWORD`) shows the live call artifacts-first, the same charts and reports the local app renders, with the spoken words passing along the bottom as captions. Call history persists under `runtime/` and is replayable. A dropdown in the header picks which agent answers and shows the number to call.
- **Host:** [Fly.io](https://fly.io), one always-on machine (the webhooks must not cold-start).
- **Phone, two interchangeable paths:**
  - **Vapi** (`ENABLE_WEB_PHONE=1` + `VAPI_*`): Vapi provides the number and runs OpenAI Realtime speech-to-speech on your BYOK OpenAI key. Tools are executed by this server via `POST /vapi/webhook`. Configure with `scripts/configure-vapi.mjs`, tune turn-taking with `scripts/tune-vapi.mjs`. Vapi only allows models on its list (`gpt-realtime-2025-08-28`).
  - **OpenAI direct over SIP** (`ENABLE_OPENAI_SIP=1` + `OPENAI_PROJECT_ID`, `OPENAI_WEBHOOK_SECRET`, `SIP_PHONE_NUMBER`): a Telnyx number dials `sip:<project>@sip.api.openai.com` and OpenAI calls back `POST /openai/incoming-call`. Two agents share the number and the dashboard dropdown arms one: **gpt-live-1** (OpenAI's GPT-Live API, full duplex, delegation backend `OPENAI_LIVE_BACKEND_MODEL`) or **gpt-realtime-2.1** (Realtime API). The choice persists in `runtime/settings.json`.

Inbound calls on every path are restricted to your caller ID (`PHONE_NUMBER`).

### Deploy (Fly)

```bash
fly apps create <app>
fly volumes create data --size 1 --region <region> -a <app>
fly secrets import -a <app> < .env      # see .env.example for the hosted blocks
fly deploy --remote-only --ha=false -a <app>
```

For paid data, stage the AgentCash wallet as base64 secrets (`AGENTCASH_WALLET_JSON_B64`, `AGENTCASH_SOLANA_WALLET_JSON_B64`, `AGENTCASH_STATE_JSON_B64`); `scripts/docker-entrypoint.sh` writes them into `~/.agentcash/` at boot.

### Wire up Vapi

1. Vapi dashboard → **Integrations → Model Providers → OpenAI**: add your OpenAI key (BYOK).
2. Buy a number, create an empty assistant, put `VAPI_PRIVATE_KEY`, `VAPI_AGENT_ID`, `VAPI_PHONE_NUMBER` in `.env`, then:

```bash
PORT=4173 ENABLE_WEB_PHONE=1 node src/server.js &       # local, unauthenticated: tools enumerate here
TOOLS_BASE_URL="http://127.0.0.1:4173" node scripts/configure-vapi.mjs   # --dry-run to preview
node scripts/tune-vapi.mjs
```

### Wire up OpenAI direct (Telnyx)

1. OpenAI platform → project **Webhooks**: endpoint `https://<app>.fly.dev/openai/incoming-call`, events `realtime.call.incoming` **and** `live.transport.incoming` (one call emits both; the server acts on the armed one). Secret → `OPENAI_WEBHOOK_SECRET`.
2. Telnyx: buy a number → `SIP_PHONE_NUMBER`; create an **Outbound Voice Profile**; create a **TeXML Application** with voice URL `https://<app>.fly.dev/telnyx/texml` and that profile attached; assign the number to it. The server returns the `<Dial><Sip>` TeXML (adding `;secure=srtp` when gpt-live-1 is armed, since GPT-Live requires SRTP).

The full step-by-step, including diagnostics, is in the two hosted skills.

### Costs

Fly machine + the phone provider (Vapi per-minute, or Telnyx number + per-minute) + OpenAI (realtime tokens, or gpt-live-1 at $0.05/min plus backend tokens) + any AgentCash paid data.

## Checks

```bash
npm run check
```

Keep `.env` private. Generated reports and the compiled browser bundle are ignored by Git.

## Security

- Never commit `.env`, `.env.local`, AgentCash/Nansen wallets, private keys, generated reports, or runtime logs. The included ignore rules cover these files.
- Browser clients receive only short-lived OpenAI Realtime client secrets. Long-lived API keys and Coinbase credentials stay on the local server.
- Runtime diagnostics are redacted before being written, but review `runtime/events.jsonl` before sharing logs.
- If a credential is ever committed, revoke it immediately; removing it from a later commit does not remove it from Git history.

## License

[MIT](LICENSE)
