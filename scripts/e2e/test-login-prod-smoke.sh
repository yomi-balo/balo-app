#!/usr/bin/env bash
set -euo pipefail

# Starts the web app built by the `Build All` step, with NO E2E_TEST_SECRET set.
# The test-login guard must 404 before any DB/session work, and the middleware
# fast-paths the no-cookie public POST — so a bare `next start` returns 404.
pnpm --filter web start &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

URL="http://localhost:3000/api/auth/test-login"

status="000"
for _ in $(seq 1 30); do
  status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" \
    -H 'content-type: application/json' -d '{"onboardingCompleted":false}' || true)"
  [ "$status" != "000" ] && break
  sleep 2
done

echo "test-login prod-inert smoke: status=$status"
if [ "$status" != "404" ]; then
  echo "FAIL: expected 404 without E2E_TEST_SECRET, got $status" >&2
  exit 1
fi
echo "PASS: route is inert (404) under next start without E2E_TEST_SECRET"
