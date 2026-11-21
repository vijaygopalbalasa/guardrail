#!/usr/bin/env bash
# Local validator for the client, MCP and dashboard: Velocity, its devnet state, markets, oracles, the dUSDT mint and
# Velocity's token faucet cloned from devnet, plus the guard program at genesis.
#   scripts/local-validator.sh start | stop
set -euo pipefail
cd "$(dirname "$0")/.."
CFG=config.yml
stop() { [ -f $CFG ] || return 0; pkill -f "solana-test-validator -C $CFG" 2>/dev/null || true; for _ in $(seq 1 20); do pgrep -f "solana-test-validator -C $CFG" >/dev/null || return 0; sleep 1; done; }
case "${1:-start}" in
  stop) stop ;;
  start)
    stop
    [ -f keys/dev.json ] && [ -f $CFG ] || ./scripts/init-local.sh
    DEV=$(solana-keygen pubkey keys/dev.json)
    mkdir -p out
    solana-test-validator -C $CFG --mint "$DEV" --ledger out/ledger --reset -q \
      --rpc-port 8999 --faucet-port 9909 --dynamic-port-range 11000-11200 \
      --url https://api.devnet.solana.com \
      --clone-upgradeable-program vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P \
      --clone-upgradeable-program V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB \
      --clone 2etx5NvPNxeMZ7EfHE6GjJfW2imRYEUANehNS1WB4CVW \
      --clone 2QpHj5vzgCdWaGM2KSoGtYJWeSkx24cMyzUDHDrucvRc \
      --clone FDejXbUrSy6zayBCL5xuk2SXLHZgr8ppfFTLcHbyJorY \
      --clone G9NKtiafHiCTArgVouXx6XS7Jb3DqigrT6S6BgSDLrvz \
      --clone 2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV \
      --clone Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4 \
      --clone GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6 \
      --clone 467z7AR8tPKQcUD17hgmU3DFt8NUWrUi7ZEVs461wdEf \
      --upgradeable-program BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy target/deploy/guard.so "$DEV" \
      > out/validator.log 2>&1 &
    for _ in $(seq 1 120); do solana -C $CFG --url http://127.0.0.1:8999 cluster-version >/dev/null 2>&1 && break; sleep 1; done
    solana -C $CFG --url http://127.0.0.1:8999 slot
    ;;
esac
