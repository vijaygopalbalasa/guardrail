#!/usr/bin/env bash
# A surfpool fork of Solana MAINNET with the guard deployed, for a live run where guarded orders fill against copies of
# real resting mainnet orders (demo/mainnet-fork.mjs). Local only: every transaction goes to the fork, none to mainnet.
#   SURFPOOL=/path/to/surfpool scripts/surfpool-mainnet.sh start | stop
# Checked with surfpool v1.7.0. RPC on 8997, websocket on 8998 (stop a devnet fork on the same ports first).
set -euo pipefail
cd "$(dirname "$0")/.."
SP=${SURFPOOL:-surfpool}
RPC=http://127.0.0.1:8997
case "${1:-start}" in
  stop)
    pkill -f "surfpool start --network mainnet --port 8997" 2>/dev/null || true
    pkill -f "demo/mainnet-fork.mjs clock" 2>/dev/null || true
    ;;
  start)
    if curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' $RPC | grep -q result; then
      echo "something already answers on $RPC: run '$0 stop' (or stop the devnet fork, scripts/surfpool.sh stop) first" >&2
      exit 1
    fi
    [ -f keys/dev.json ] && [ -f config.yml ] || ./scripts/init-local.sh
    mkdir -p out/surfpool-mainnet
    KEY="$PWD/keys/dev.json"
    # The startup airdrop goes to the repo's throwaway dev key (named here, so the default wallet path is never read).
    (cd out/surfpool-mainnet && exec nohup "$SP" start --network mainnet --port 8997 --ws-port 8998 --no-tui --no-studio --no-deploy \
      --airdrop-keypair-path "$KEY" --airdrop-amount 100000000000 > surfpool.log 2>&1 < /dev/null) &
    for _ in $(seq 1 60); do curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' $RPC | grep -q result && break; sleep 1; done
    # The guard at its declared id (keys/guard-program.json is the address key of the devnet deploy; the address is free
    # on mainnet, docs/mainnet.md).
    solana -C config.yml -u $RPC --ws ws://127.0.0.1:8998 -k keys/dev.json program deploy --use-rpc --program-id keys/guard-program.json target/deploy/guard.so
    # Only the SOL-PERP and USDT oracles follow mainnet (surfnet_streamAccount); markets and users are copied once, so
    # local fills stay on the fork.
    for O in 2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4; do
      curl -s -X POST -H 'content-type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"surfnet_streamAccount\",\"params\":[\"$O\",{\"includeOwnedAccounts\":false}]}" $RPC > /dev/null
    done
    # The fork's clock follows mainnet's slot (forward time travel only), so the streamed oracle reads as fresh as on mainnet.
    nohup node demo/mainnet-fork.mjs clock > out/surfpool-mainnet/clock.log 2>&1 < /dev/null &
    echo "mainnet fork on $RPC: guard deployed, SOL and USDT oracles streamed from mainnet, clock following mainnet's slot"
    ;;
esac
