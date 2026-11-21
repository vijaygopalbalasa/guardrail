#!/usr/bin/env bash
# Regenerates the IDL from the program source and the client's error map from it, so neither goes stale.
set -euo pipefail
cd "$(dirname "$0")/.."
anchor idl build -p guard -o target/idl/guard.json > notes/idl-build.log 2>&1
cp target/idl/guard.json client/idl/guard.json
python3 - <<'PY'
import json, re
d = json.load(open("client/idl/guard.json"))
p = "client/src/errors.ts"
s = open(p).read()
body = "\n".join(f'  {e["code"]}: "{e["name"]}",' for e in d["errors"])
s2 = re.sub(r'(export const GUARD_ERRORS: Record<number, string> = \{\n)(.*?)(\n\};)', lambda m: m.group(1) + body + m.group(3), s, count=1, flags=re.S)
open(p, "w").write(s2)
PY
