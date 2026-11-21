#!/usr/bin/env bash
# Checks that the program on devnet is this build: dumps the on-chain program, strips the trailing zero padding of the
# program account from both files, and compares their sha256 (the dump is the program data region, which is larger
# than the .so after `program extend`).
set -euo pipefail
cd "$(dirname "$0")/.."
PROGRAM=BZGivcKVE8x2YwboZ8HAUB1hu73jQLd5izigkJYVBxPy
DUMP=$(mktemp)
solana -C config.yml program dump -u devnet "$PROGRAM" "$DUMP" > /dev/null
strip() { python3 -c "import sys,hashlib; d=open(sys.argv[1],'rb').read().rstrip(b'\0'); print(hashlib.sha256(d).hexdigest(), len(d))" "$1"; }
read -r A LA < <(strip target/deploy/guard.so)
read -r B LB < <(strip "$DUMP")
rm -f "$DUMP"
echo "build  (zeros stripped): sha256 $A, $LA bytes"
echo "devnet (zeros stripped): sha256 $B, $LB bytes"
[ "$A" = "$B" ] && echo "MATCH" || { echo "DIFFERENT"; exit 1; }
