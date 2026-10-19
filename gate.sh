#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
ORIGIN="${PORCH_ORIGIN:-https://pi.coey.dev}"
fail=0
check() { if [ "$2" = 0 ]; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

npx tsc -p . >/dev/null && npx tsc -p tsconfig.client.json >/dev/null && npx vitest run >/dev/null 2>&1
check "0 types and unit tests" $?

code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$ORIGIN/api/sidebar")
[ "$code" = 302 ] || [ "$code" = 401 ] || [ "$code" = 403 ]
check "1 unauthenticated request refused ($code)" $?

if [ -f .real/cookie ] || [ -n "${PORCH_CLIENT_SECRET:-}" ]; then
  bun gate/live.ts "$ORIGIN"
  check "2-4 live sidebar, input, Pi stream" $?
else
  echo "FAIL 2-4 live checks: need .real/cookie (CF_Authorization) to call the deployed app"
  fail=1
fi

if [ -f ../basic/reports/porch.md ] && ! grep -qE '^\| *FAIL|MISSING' ../basic/reports/porch.md; then check "5 basic @must" 0; else check "5 basic @must (no passing report)" 1; fi

exit $fail
