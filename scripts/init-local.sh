#!/usr/bin/env bash
# One-time local setup: a throwaway key in keys/dev.json (gitignored) and a solana CLI config in config.yml that
# points at it and at the local validator. Never touches ~/.config/solana.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p keys
[ -f keys/dev.json ] || solana-keygen new --no-bip39-passphrase --silent -o keys/dev.json >/dev/null
chmod 600 keys/dev.json
cat > config.yml <<CFG
json_rpc_url: "http://127.0.0.1:8999"
websocket_url: ""
keypair_path: $PWD/keys/dev.json
address_labels: {}
commitment: confirmed
CFG
echo "dev key $(solana-keygen pubkey keys/dev.json); config.yml written"
