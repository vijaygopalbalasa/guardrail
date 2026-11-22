#!/usr/bin/env bash
# Mainnet deploy of the guard program. DRY RUN by default: it checks the build, reads the cost from mainnet and prints
# the exact commands. Nothing is signed or sent unless --yes is given together with a mainnet keypair and an upgrade
# authority plan. See docs/mainnet.md.
#
#   scripts/deploy-mainnet.sh                                              dry run (no keys needed)
#   scripts/deploy-mainnet.sh --keypair <mainnet.json> --authority-plan <plan> [--rpc URL] [--headroom BYTES] --yes
#
#   --keypair         the mainnet payer and initial upgrade authority, a file YOU supply (never keys/dev.json)
#   --authority-plan  multisig:<PUBKEY>  hand the upgrade authority to a multisig (e.g. a Squads vault) after deploy
#                     final              make the program immutable after deploy (no upgrades, ever)
#                     keep               keep the --keypair as upgrade authority (only for a short review window)
#   --headroom        extra program bytes reserved for upgrades (default 26045, as on devnet: 384,045 bytes in all)
set -euo pipefail
cd "$(dirname "$0")/.."
PROGRAM=BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy
PROGRAM_KEY=keys/guard-program.json # the program address keypair (same address as devnet; only used at first deploy)
RPC=https://api.mainnet-beta.solana.com
KEYPAIR="" PLAN="" YES=0 HEADROOM=26045
while [ $# -gt 0 ]; do
  case "$1" in
    --keypair) KEYPAIR=$2; shift 2 ;;
    --authority-plan) PLAN=$2; shift 2 ;;
    --rpc) RPC=$2; shift 2 ;;
    --headroom) HEADROOM=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done
SOL="solana -C config.yml" # never the default ~/.config/solana

echo "== 1. The build is the audited devnet build"
[ -f target/deploy/guard.so ] || ./scripts/build.sh > notes/build.log 2>&1
./scripts/verify-devnet-program.sh

echo "== 2. Mainnet state (read only)"
EXISTS=$(curl -s -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$PROGRAM\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":0}}]}" "$RPC" | python3 -c "import json,sys; print('yes' if json.load(sys.stdin)['result']['value'] else 'no')")
echo "program address $PROGRAM already on mainnet: $EXISTS"
[ "$EXISTS" = "no" ] || { echo "STOP: the address is taken on mainnet; this script only does a first deploy"; exit 1; }

SO=$(wc -c < target/deploy/guard.so | tr -d ' ')
LEN=$((SO + HEADROOM))
DATA=$((LEN + 45)) # programdata header
RENT=$($SOL rent -u "$RPC" "$DATA" | awk '/Rent-exempt minimum/{print $3}')
BUF=$($SOL rent -u "$RPC" "$((SO + 37))" | awk '/Rent-exempt minimum/{print $3}')
IDL=$(python3 -c "import json,zlib; d=json.dumps(json.load(open('target/idl/guard.json'))).encode(); print(len(zlib.compress(d))*2+44)")
IDL_RENT=$($SOL rent -u "$RPC" "$IDL" | awk '/Rent-exempt minimum/{print $3}')
echo "guard.so $SO bytes; program data $DATA bytes (with $HEADROOM bytes headroom)"
echo "rent, locked while the program exists (closing the program returns it): $RENT SOL"
echo "deploy buffer rent, returned when the deploy finishes: $BUF SOL (must be on hand during the deploy)"
echo "on-chain IDL account (optional, names instructions in the explorer): about $IDL_RENT SOL"
echo "fees: about 0.01 to 0.02 SOL for the write transactions, plus any priority fee"
NEED=$(python3 -c "print(round($RENT + $BUF + $IDL_RENT + 0.05, 3))")
echo "have at least $NEED SOL in the payer before starting"

case "$PLAN" in
  multisig:*) NEW=${PLAN#multisig:}; AUTH_CMD="$SOL program set-upgrade-authority -u $RPC --keypair \"\$KEYPAIR\" $PROGRAM --new-upgrade-authority $NEW --skip-new-upgrade-authority-signer-check" ;;
  final) AUTH_CMD="$SOL program set-upgrade-authority -u $RPC --keypair \"\$KEYPAIR\" $PROGRAM --final" ;;
  keep) AUTH_CMD="# upgrade authority stays with \$KEYPAIR; hand it to a multisig or make it final after review" ;;
  "") AUTH_CMD="# choose --authority-plan multisig:<PUBKEY> | final | keep" ;;
  *) echo "bad --authority-plan: $PLAN"; exit 2 ;;
esac

cat <<EOF

== 3. The exact commands (KEYPAIR is your mainnet payer and initial upgrade authority)
KEYPAIR=${KEYPAIR:-/path/to/your-mainnet-keypair.json}
$SOL program deploy -u $RPC --keypair "\$KEYPAIR" --upgrade-authority "\$KEYPAIR" \\
  --program-id $PROGRAM_KEY --max-len $LEN --with-compute-unit-price 20000 --use-rpc target/deploy/guard.so
anchor idl init -f target/idl/guard.json $PROGRAM --provider.cluster mainnet --provider.wallet "\$KEYPAIR"
$AUTH_CMD
$SOL program show -u $RPC $PROGRAM
# then compare the deployed bytes with the build, as verify-devnet-program.sh does for devnet
EOF

if [ "$YES" != 1 ]; then echo; echo "DRY RUN: nothing was signed or sent. Add --keypair, --authority-plan and --yes to deploy."; exit 0; fi

# ---- real deploy: every precondition, then the commands above ----
[ -n "$KEYPAIR" ] && [ -f "$KEYPAIR" ] || { echo "STOP: --keypair <file> is required for a real deploy"; exit 2; }
[ -n "$PLAN" ] || { echo "STOP: --authority-plan is required for a real deploy"; exit 2; }
case "$(cd "$(dirname "$KEYPAIR")" && pwd)/$(basename "$KEYPAIR")" in
  */keys/dev.json|*/keys/stranger.json|*/keys/agent.json|*/out/*) echo "STOP: that is a devnet or demo key; use a separate mainnet keypair"; exit 2 ;;
esac
PAYER=$(solana-keygen pubkey "$KEYPAIR")
BAL=$($SOL balance -u "$RPC" "$PAYER" | awk '{print $1}')
python3 -c "import sys; sys.exit(0 if $BAL >= $NEED else 1)" || { echo "STOP: $PAYER has $BAL SOL; needs $NEED"; exit 1; }
echo "deploying $PROGRAM to mainnet from $PAYER ($BAL SOL), authority plan: $PLAN"
$SOL program deploy -u "$RPC" --keypair "$KEYPAIR" --upgrade-authority "$KEYPAIR" \
  --program-id "$PROGRAM_KEY" --max-len "$LEN" --with-compute-unit-price 20000 --use-rpc target/deploy/guard.so
anchor idl init -f target/idl/guard.json "$PROGRAM" --provider.cluster mainnet --provider.wallet "$KEYPAIR"
eval "$AUTH_CMD"
$SOL program show -u "$RPC" "$PROGRAM"
