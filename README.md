# Coinbase for Agents

Your own low-latency voice research and trading agent. It uses OpenAI Realtime for responsive conversation, Coinbase for equities, crypto, US futures, portfolio data, and guarded trading, Exa for live web research, and AgentCash for optional paid data and custom artifacts.

## Get started with your coding agent

Paste this prompt into Codex, Claude Code, Cursor, or another coding agent:

```text
Read https://coinbase-for-agents.vercel.app/skill and help me set up my own Coinbase for Agents.
```

The agent-guided flow forks or clones the repository, checks your machine, installs dependencies, walks you to each API-key dashboard, verifies the configuration without exposing secrets, and launches the app locally.

Visit [coinbase-for-agents.vercel.app](https://coinbase-for-agents.vercel.app) for the minimal quickstart, or read the reusable [`launch-coinbase-for-agents`](skills/launch-coinbase-for-agents/SKILL.md) skill directly.

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
