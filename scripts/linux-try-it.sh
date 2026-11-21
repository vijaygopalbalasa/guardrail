#!/usr/bin/env bash
# Runs the README's "Try it in two minutes" steps 0 to 6 and 8, exactly as written there (step 7 needs an OpenRouter key), and reports each one.
cd "$(dirname "$0")/.."
step() { echo; echo "===== STEP $1 ($(date +%T))"; }
fail=0
step 0; ./scripts/init-local.sh || fail=1
step 1; solana -C config.yml program dump -u devnet vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P fixtures/velocity-devnet.so && (sha256sum fixtures/velocity-devnet.so 2>/dev/null || shasum -a 256 fixtures/velocity-devnet.so) || fail=1
cat fixtures/velocity-devnet.so.sha256
step 2; ./scripts/build.sh 2>&1 | tail -2; [ -f target/deploy/guard.so ] || fail=1
step 3; (cd tests-litesvm && cargo test --release --test runaway -- --nocapture) 2>&1 | grep -E "HEADLINE|test result|^error" || fail=1
step 4; (cd tests-litesvm && cargo test --release) 2>&1 | grep -E "test result|^error" || fail=1
step 5; npm --prefix client ci && npm --prefix client run build && npm --prefix mcp ci && npm --prefix demo ci && ./scripts/local-validator.sh start || fail=1
step 6; (node demo/setup.mjs && node demo/agent.mjs runaway) 2>&1 | tail -3 || fail=1
step 8; node client/scripts/demo-seed.mjs | tail -1 || fail=1
PIDF=$(mktemp); (cd dashboard && python3 -m http.server 8780 >/dev/null 2>&1 & echo $! > "$PIDF"); sleep 1
curl -s -o /dev/null -w "dashboard http %{http_code}\n" http://127.0.0.1:8780/ || fail=1
kill "$(cat "$PIDF")"; rm -f "$PIDF"; ./scripts/local-validator.sh stop
echo; echo "git status after the run:"; git status --short
echo "RESULT: $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
