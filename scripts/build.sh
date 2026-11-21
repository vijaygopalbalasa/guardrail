#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p target/deploy
[ -f target/deploy/guard-keypair.json ] || [ ! -f keys/guard-program.json ] || cp keys/guard-program.json target/deploy/guard-keypair.json
cargo-build-sbf --arch v3 --manifest-path programs/guard/Cargo.toml
