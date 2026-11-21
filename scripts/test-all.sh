#!/usr/bin/env bash
# Everything: build, Rust replay and math tests, then client, MCP and dashboard tests on a local validator.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/build.sh > notes/build.log 2>&1
./scripts/idl.sh
(cd tests-litesvm && cargo test --release 2>&1 | grep -E "^test result")
cargo test --release --manifest-path programs/guard/Cargo.toml 2>&1 | grep -E "^test result" | head -1
(cd client && npm run build >/dev/null)
./scripts/local-validator.sh start >/dev/null
trap './scripts/local-validator.sh stop' EXIT
(cd client && node --test test/*.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)")
(cd mcp && node --test test/*.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)")
(cd demo && node --test test/*.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)")
GUARD=$(node client/scripts/demo-seed.mjs | awk '/^guard /{print $2}')
GUARD=$GUARD node --test dashboard/test/*.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"
echo "dashboard: (cd dashboard && python3 -m http.server 8780) then open http://127.0.0.1:8780/?guard=$GUARD"
