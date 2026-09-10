#!/bin/sh
# Materialize the AgentCash wallet from secrets (base64) before starting the app.
# The AgentCash MCP server reads ~/.agentcash/wallet.json + solana-wallet.json.
set -e

mkdir -p "$HOME/.agentcash" /app/runtime /app/reports

write_b64() {
  # $1 = base64 value, $2 = destination path
  [ -n "$1" ] || return 0
  printf '%s' "$1" | base64 -d > "$2"
  chmod 600 "$2"
}

write_b64 "$AGENTCASH_WALLET_JSON_B64" "$HOME/.agentcash/wallet.json"
write_b64 "$AGENTCASH_SOLANA_WALLET_JSON_B64" "$HOME/.agentcash/solana-wallet.json"
write_b64 "$AGENTCASH_STATE_JSON_B64" "$HOME/.agentcash/state.json"

exec node src/server.js
