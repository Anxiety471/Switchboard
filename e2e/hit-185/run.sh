#!/usr/bin/env bash
set -euo pipefail

cd /workspace
mkdir -p /workspace/e2e/hit-185
exec > >(tee /workspace/e2e/hit-185/e2e-run.log) 2>&1

API_URL="http://127.0.0.1:3011"
DOWN_URL="http://127.0.0.1:3012"
TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/switchboard_test"
API_LOG="/tmp/hit-185-api.log"
DOWN_LOG="/tmp/hit-185-down.log"
SECRET="demo-secret"

cleanup() {
  if [[ -n "${API_PID:-}" ]]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "${DOWN_PID:-}" ]]; then
    kill "$DOWN_PID" 2>/dev/null || true
    wait "$DOWN_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

rm -f /tmp/hit-185-mid /tmp/hit-185-done "$API_LOG" "$DOWN_LOG"

echo "== Switchboard API against switchboard_test =="
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE agents CASCADE"

env -u HOST \
  DATABASE_URL="$TEST_DATABASE_URL" \
  PORT=3011 \
  REGISTRATION_SECRET="$SECRET" \
  node apps/api/dist/index.js >"$API_LOG" 2>&1 &
API_PID=$!

ready=0
for _ in $(seq 1 50); do
  if curl -sf "$API_URL/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" != 1 ]]; then
  echo "API did not become ready" >&2
  cat "$API_LOG" >&2
  exit 1
fi

echo
echo "-- listen address --"
grep -F "listening" "$API_LOG"

echo
echo "-- health --"
curl -sS -w "\nHTTP %{http_code}\n" "$API_URL/health"

echo
echo "-- register without secret --"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H 'content-type: application/json' \
  -d '{"name":"alpha"}' \
  "$API_URL/agents"

echo
echo "-- register alpha --"
curl -sS -H 'content-type: application/json' \
  -H "x-registration-secret: $SECRET" \
  -d '{"name":"alpha"}' \
  "$API_URL/agents" | tee /tmp/hit-185-alpha.json
echo
python3 - <<'PY'
import json
body = json.load(open("/tmp/hit-185-alpha.json"))
assert set(body) == {"id", "name", "token"}
assert body["name"] == "alpha"
print("registered", body["name"], body["id"])
PY

echo
echo "-- duplicate alpha and Alpha --"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H 'content-type: application/json' \
  -H "x-registration-secret: $SECRET" \
  -d '{"name":"alpha"}' \
  "$API_URL/agents"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H 'content-type: application/json' \
  -H "x-registration-secret: $SECRET" \
  -d '{"name":"Alpha"}' \
  "$API_URL/agents"

echo
echo "-- register beta --"
curl -sS -H 'content-type: application/json' \
  -H "x-registration-secret: $SECRET" \
  -d '{"name":"beta"}' \
  "$API_URL/agents" | tee /tmp/hit-185-beta.json
echo

ALPHA=$(python3 -c 'import json; print(json.load(open("/tmp/hit-185-alpha.json"))["token"])')
BETA=$(python3 -c 'import json; print(json.load(open("/tmp/hit-185-beta.json"))["token"])')

echo "-- message and paged inbox --"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H "authorization: Bearer $ALPHA" \
  -H 'content-type: application/json' \
  -d '{"to":"beta","body":"first"}' \
  "$API_URL/messages"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H "authorization: Bearer $ALPHA" \
  -H 'content-type: application/json' \
  -d '{"to":"beta","body":"second"}' \
  "$API_URL/messages"
echo "page 1"
curl -sS -o /tmp/hit-185-page.json -w "HTTP %{http_code}\n" \
  -H "authorization: Bearer $BETA" \
  "$API_URL/inbox?limit=1"
cat /tmp/hit-185-page.json
echo
CURSOR=$(python3 -c 'import json; print(json.load(open("/tmp/hit-185-page.json"))["next"])')
echo "page 2 after $CURSOR"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H "authorization: Bearer $BETA" \
  --get \
  --data-urlencode "after=$CURSOR" \
  "$API_URL/inbox"

echo
echo "-- sender inbox stays empty --"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H "authorization: Bearer $ALPHA" \
  "$API_URL/inbox"

touch /tmp/hit-185-mid
sleep 2

echo
echo "-- logs redact the token and registration secret --"
if grep -F "$ALPHA" "$API_LOG" || grep -F "$SECRET" "$API_LOG"; then
  echo "secret leaked into API logs" >&2
  exit 1
fi
grep -F "[Redacted]" "$API_LOG" >/dev/null
echo "redacted"

echo
echo "-- unreachable database stays up and returns 503 --"
env -u HOST \
  DATABASE_URL="postgres://switchboard_user:s3cret-pass@127.0.0.1:1/unreachable_test" \
  PORT=3012 \
  node apps/api/dist/index.js >"$DOWN_LOG" 2>&1 &
DOWN_PID=$!
sleep 0.3
down_body=$(curl -sS -w "\nHTTP %{http_code}\n" "$DOWN_URL/health" || true)
printf '%s\n' "$down_body"
if ! kill -0 "$DOWN_PID"; then
  echo "down API exited" >&2
  cat "$DOWN_LOG" >&2
  exit 1
fi
echo "process $DOWN_PID still running"
if printf '%s' "$down_body" | grep -E 'ECONNREFUSED|s3cret-pass|unreachable_test'; then
  echo "health body leaked the database error" >&2
  exit 1
fi
kill "$DOWN_PID"
wait "$DOWN_PID" 2>/dev/null || true
DOWN_PID=""

echo
echo "PASS"
touch /tmp/hit-185-done
sleep 4
