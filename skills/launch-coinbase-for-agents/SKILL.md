---
name: launch-coinbase-for-agents
description: Fork, install, configure, verify, and run the Coinbase for Agents low-latency voice research and trading app locally. Use when someone asks to launch their own copy, set up its OpenAI or Exa keys, connect Coinbase equities, crypto, or futures, or troubleshoot first-run setup.
metadata:
  source: "https://github.com/Must-be-Ash/c4a-gpt-realtime"
---

# Launch Coinbase for Agents

Help the user get their own working local copy of:

https://github.com/Must-be-Ash/c4a-gpt-realtime

Own the setup from preflight through a successful first voice session. Run commands, inspect results, and fix setup-related failures when tools permit. Pause only for choices, authentication, consent, billing, microphone permission, or secret entry that the user must complete.

## Operating rules

- Keep a short checklist and update it as each stage passes.
- Ask one concise question only when the answer changes the next action.
- Never ask the user to paste an API key, private key, token, wallet seed, Coinbase secret, or other credential into chat.
- Have the user enter secrets directly into their local `.env` with an editor, password manager, or hidden interactive prompt. Never put secret values in command arguments, logs, screenshots, commits, issues, or pull requests.
- Before creating a GitHub fork or pushing changes, name the external resource that will change and get confirmation.
- Do not place an order, transfer funds, create a wallet, fund a wallet, or run a paid API call during setup.
- Treat the app as experimental. Recommend a dedicated, minimally funded Coinbase portfolio and the minimum permissions the user actually wants.
- Diagnose failures; do not skip checks, weaken trade confirmation, or replace live providers with mock data.
- Resume from the blocked stage after a manual action instead of restarting the runbook.

## 1. Confirm the setup target

Determine:

1. Whether the user wants a GitHub fork or only a local clone. Recommend a fork if they plan to customize or contribute.
2. The GitHub account or organization for the fork, if applicable.
3. The parent directory for the checkout. Default the folder name to `c4a-gpt-realtime`.
4. The initial capability profile:
   - **Research:** OpenAI + Exa. This is enough for responsive voice, live web research on any topic, public crypto market data, charts, prediction markets, derivatives, catalysts, and generated reports.
   - **Trading:** Research plus Coinbase credentials. This adds supported S&P 500 equities, spot crypto, US futures, balances, risk views, order previews, and confirmed order execution.
   - **Paid data:** Either profile plus AgentCash and optional Nansen/Orthogonal configuration.

Ask for account choices and readiness only, never credential values. Explain that local setup will create a checkout, install npm packages, and write an ignored `.env` file.

## 2. Preflight the machine

Check the tools yourself:

    git --version
    node --version
    npm --version

Require Node.js 22 or newer. If Node is missing or old, prefer an already-installed version manager. Otherwise guide the user through the official Node.js installer and recheck before continuing.

For a fork, also run:

    gh auth status
    gh repo view Must-be-Ash/c4a-gpt-realtime --json nameWithOwner,visibility,url

If GitHub CLI is unavailable, use the GitHub web fork flow and standard `git clone`. If authentication or account consent is required, tell the user exactly which login screen to complete and wait.

## 3. Fork or clone

Resolve the destination to an explicit path and confirm it does not already contain unrelated files. Never overwrite or delete an existing checkout.

For a GitHub fork, state the owner and repository that will be created, get confirmation, then prefer:

    gh repo fork Must-be-Ash/c4a-gpt-realtime --clone --remote

If the desired fork already exists, clone or open it and ensure the original repository is available as `upstream`. For a clone-only setup:

    git clone https://github.com/Must-be-Ash/c4a-gpt-realtime.git

Inside the checkout, read `README.md`, `AGENT.md`, `.env.example`, and `package.json`. Verify the branch, remotes, and clean status before editing:

    git status --short --branch
    git remote -v

## 4. Install and prove the clean checkout

Run:

    npm install
    npm run check

`npm install` also installs the pinned Coinbase for Agents CLI as a local project dependency. Do not install or prefer a global copy; the app deliberately launches its tested local version.

Do not continue past a failing clean-checkout test suite. Diagnose dependency, Node version, or platform errors and explain any upstream code failure clearly.

Create the local environment file only if it does not already exist:

    cp .env.example .env

Never overwrite an existing `.env`. Confirm `.env` is ignored by Git without printing its contents:

    git check-ignore .env

## 5. Configure the research profile

The required local variables are `OPENAI_API_KEY` and `EXA_API_KEY`.

Guide the user to create or select keys directly in the provider dashboards:

- OpenAI: https://platform.openai.com/api-keys
- Exa: https://dashboard.exa.ai/api-keys

Ask the user to store both in a password manager and enter them directly in the local `.env`. Explain that the keys stay server-side; the browser receives only a short-lived OpenAI Realtime client secret.

After the user says they are saved, verify only that each variable is present and non-empty. Use a command that prints variable names or readiness booleans, never values. Do not upload `.env` or read its secret content back into chat.

Leave the default model and voice values unchanged unless the app reports that the configured model is unavailable for the user's OpenAI project.

## 6. Configure optional Coinbase trading

Skip this stage when the user chose the research profile. Tell them they can return later without reinstalling the app.

Verify the pinned official CLI installed with the project:

    npm exec -- coinbase --version

Have the user create a Secret API key in Coinbase's CDP portal:

https://portal.cdp.coinbase.com/api-keys/secret

Recommend a dedicated, minimally funded Advanced Trade portfolio. Guide the user to enable only the permissions needed for their intended use. `View` is needed for balances and product discovery; `Trade` is needed for equity, crypto, or futures order previews and execution. Do not recommend transfer, receive, policy-management, or private-key-export permissions for this app's normal trade flow. Futures also require Coinbase account eligibility.

Have the user put `COINBASE_KEY_ID` and `COINBASE_KEY_SECRET` directly into `.env`. Preserve multiline key formatting exactly. Do not pass either value through `coinbase env ...` command arguments because that can enter shell history.

Verify only readiness, then run a read-only balance check if the user explicitly wants it. Never use a live order as a setup test. Explain that every order in the app must be previewed and then explicitly confirmed in a following utterance.

## 7. Configure optional paid data

Skip this stage unless the user chose paid data.

AgentCash search and endpoint discovery can work before funding. Wallet creation and funding affect financial resources, so explain the change and obtain confirmation before running onboarding:

    npx agentcash@latest onboard
    npx agentcash@latest balance

Let the user complete wallet backup or funding steps directly. Never request wallet material in chat and never initiate a paid fetch as a setup test.

`ORTHOGONAL_API_KEY` optionally expands endpoint discovery. Nansen can use `NANSEN_API_KEY` or its documented x402 wallet variables. Configure only integrations the user requested, and leave unrelated `.env` entries blank.

## 8. Launch and verify

Run the app in a retained terminal session:

    npm run dev

Wait for the server to report `http://localhost:4173`. Check these routes without printing sensitive configuration:

    curl --fail http://localhost:4173/
    curl --fail http://localhost:4173/skill
    curl --fail http://localhost:4173/api/config

Open `http://localhost:4173/app/` in the user's browser. Ask them to allow microphone access. Confirm that the page does not report missing variables for the chosen profile.

For the first smoke test, have the user start voice and ask for a read-only public request such as:

    What's the current BTC price?

Then test current news if Exa is configured:

    What is the most important Bitcoin news today?

If Coinbase is configured and the user wants to verify it, use a read-only balance request. Do not preview or execute an order during setup.

Optionally verify the expanded product catalog with a read-only request such as “Find the Coinbase product for Apple stock” or “List the current Coinbase futures contracts.” Explain that Coinbase's ticker, candle, order-book, and best-bid/ask endpoints are not currently available for equities, while product discovery and guarded equity ordering are supported.

## 9. Finish cleanly

Run `npm run check` again after any setup-related source change. Inspect `git status` and confirm that `.env`, runtime logs, reports, wallets, and credentials are absent from the diff.

If a fork was created and setup required source changes, summarize the non-secret diff and ask for confirmation before committing and pushing. Do not force-push.

The setup is complete only when:

- Node.js and dependencies are installed.
- The full check suite passes.
- The chosen profile's variables are configured without exposing their values.
- The local app opens and microphone permission is resolved.
- A public voice request completes successfully.
- No credentials or generated private state appear in Git.

Hand back the fork URL when applicable, the checkout path, the local app URL, the enabled profile, and which optional integrations remain unconfigured. Remind the user that the app can place real Coinbase orders only after an explicit preview and fresh confirmation.
