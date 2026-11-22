#!/usr/bin/env bash
# Daily G10 keeper for the demo guards on devnet, run by launchd (scripts/launchd/com.guardrail.keeper.plist) at 00:00
# UTC and again at 00:30 UTC. Each demo guard's keeper is its owner, so it runs scripts/keeper.mjs once per owner key.
# Keys are passed by path only and never printed; the log gets owner public keys and transaction signatures.
set -uo pipefail
cd "$(dirname "$0")/.."
NODE=${NODE:-node}
LOG=out/keeper-daily.log
mkdir -p out
# The chain's clock can trail the wall clock by a little; start just after midnight UTC by the chain.
sleep "${KEEPER_DELAY:-0}"
# key file (gitignored) -> owner public key -> guard
GUARDS=(
  "out/demo-owner-FkQfmTpR.json FkQfmTpReWXHHCoAc7vUmesKBDMSAwmx1GobETVeUMeS 9NJpRGSq (language-model agent)"
  "out/demo-owner-4cMEVdWk.json 4cMEVdWkpaMWvuGznBxUWeRxYXadiR5ULVmsJ2dZSH2V HMwVJCoz (scripted runaway agent)"
  "out/demo-owner-W7ntzEnk.json W7ntzEnkuoDQJDRdH3sPLqWeav3HLKK9D3aC5n6pdj5 9yVPGMcC (runaway agent, earlier run)"
  "keys/stranger.json AFnLPrDAyncqNLtgeLGuPjAFvkkHc4ifk6LbSDP8KHWQ FuoawFpm (quickstart)"
)
{
  echo "=== keeper-daily $(date -u '+%Y-%m-%d %H:%M:%S') UTC ==="
  for g in "${GUARDS[@]}"; do
    read -r key owner guard <<< "$g"
    echo "--- guard $guard, owner $owner"
    if [ ! -f "$key" ]; then echo "ALERT: missing key file for $owner"; continue; fi
    "$NODE" scripts/keeper.mjs --keypair "$key" --owners "$owner" --now --tries 10 2>&1 || echo "ALERT: keeper exited non-zero for $owner"
    sleep 5 # the public devnet RPC rate-limits
  done
} >> "$LOG" 2>&1
