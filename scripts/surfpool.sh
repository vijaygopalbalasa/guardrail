#!/usr/bin/env bash
# A surfpool fork of devnet with the guard deployed, for live fills at moving prices (demo/live.mjs).
#   SURFPOOL=/path/to/surfpool scripts/surfpool.sh start | stop
# surfpool is the Solana Foundation's local validator (github.com/solana-foundation/surfpool); this was checked
# with v1.7.0. RPC on 8997, websocket on 8998.
set -euo pipefail
cd "$(dirname "$0")/.."
SP=${SURFPOOL:-surfpool}
case "${1:-start}" in
  stop) pkill -f "surfpool start --network devnet --port 8997" 2>/dev/null || true ;;
  start)
    [ -f keys/dev.json ] && [ -f config.yml ] || ./scripts/init-local.sh
    mkdir -p out/surfpool
    DEV=$(solana-keygen pubkey keys/dev.json)
    (cd out/surfpool && "$SP" start --network devnet --port 8997 --ws-port 8998 --no-tui --no-studio --no-deploy --airdrop "$DEV" --airdrop-amount 100000000000 > surfpool.log 2>&1 &)
    for _ in $(seq 1 60); do curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' http://127.0.0.1:8997 | grep -q result && break; sleep 1; done
    [ -f keys/guard-program.json ] || solana-keygen new --no-bip39-passphrase --silent -o keys/guard-program.json >/dev/null
    echo "note: the guard deploys at its declared id only with the matching key; otherwise use the local validator flow"
    solana -C config.yml -u http://127.0.0.1:8997 --ws ws://127.0.0.1:8998 -k keys/dev.json program deploy --use-rpc --program-id keys/guard-program.json target/deploy/guard.so
    ;;
esac
