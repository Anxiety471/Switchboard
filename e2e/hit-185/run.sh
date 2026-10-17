#!/usr/bin/env bash
# Exercise a built Switchboard API.
#
# Required environment:
#   SWITCHBOARD_ROOT      directory that contains apps/api/dist/index.js
#   TEST_DATABASE_URL     Postgres URL for the API under test.
#                         The database name must end in _test.
#   DOWN_DATABASE_URL     Postgres URL that does not accept connections
#   E2E_DIR               directory for e2e-run.log and scratch files
#   REGISTRATION_SECRET   value sent as x-registration-secret
#
# Optional environment:
#   API_HOST              address to call (default 127.0.0.1)
#   API_PORT              API port (default 3011)
#   DOWN_PORT             port for the unreachable API (default 3012)
set -euo pipefail

require() {
  if [[ -z "${!1:-}" ]]; then
    echo "$1 is required" >&2
    exit 1
  fi
}

require SWITCHBOARD_ROOT
require TEST_DATABASE_URL
require DOWN_DATABASE_URL
require E2E_DIR
require REGISTRATION_SECRET

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-3011}"
DOWN_PORT="${DOWN_PORT:-3012}"
API_URL="http://${API_HOST}:${API_PORT}"
DOWN_URL="http://${API_HOST}:${DOWN_PORT}"
API_LOG="${E2E_DIR}/api.log"
DOWN_LOG="${E2E_DIR}/down.log"
ALPHA_JSON="${E2E_DIR}/alpha.json"
BETA_JSON="${E2E_DIR}/beta.json"
PAGE_JSON="${E2E_DIR}/page.json"
MID_MARKER="${E2E_DIR}/mid"
DONE_MARKER="${E2E_DIR}/done"

mkdir -p "$E2E_DIR"
cd "$SWITCHBOARD_ROOT"
exec > >(tee "${E2E_DIR}/e2e-run.log") 2>&1

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

rm -f "$MID_MARKER" "$DONE_MARKER" "$API_LOG" "$DOWN_LOG"

echo "== Switchboard API =="
db_name=$(TEST_DATABASE_URL="$TEST_DATABASE_URL" python3 - <<'PY'
import os
from urllib.parse import unquote, urlparse

name = unquote(urlparse(os.environ["TEST_DATABASE_URL"]).path.lstrip("/"))
print(name)
PY
)
case "$db_name" in
  *_test) ;;
  *)
    echo "Refusing to run against database ${db_name}; the name must end in _test" >&2
    exit 1
    ;;
esac
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE agents CASCADE"

env -u HOST \
  DATABASE_URL="$TEST_DATABASE_URL" \
  PORT="$API_PORT" \
  REGISTRATION_SECRET="$REGISTRATION_SECRET" \
  node "${SWITCHBOARD_ROOT}/apps/api/dist/index.js" >"$API_LOG" 2>&1 &
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
  -H "x-registration-secret: ${REGISTRATION_SECRET}" \
  -d '{"name":"alpha"}' \
  "$API_URL/agents" | tee "$ALPHA_JSON"
echo
ALPHA_JSON="$ALPHA_JSON" python3 - <<'PY'
import json
import os
body = json.load(open(os.environ["ALPHA_JSON"]))
assert set(body) == {"id", "name", "token"}
assert body["name"] == "alpha"
print("registered", body["name"], body["id"])
PY

echo
echo "-- duplicate alpha and Alpha --"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H 'content-type: application/json' \
  -H "x-registration-secret: ${REGISTRATION_SECRET}" \
  -d '{"name":"alpha"}' \
  "$API_URL/agents"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H 'content-type: application/json' \
  -H "x-registration-secret: ${REGISTRATION_SECRET}" \
  -d '{"name":"Alpha"}' \
  "$API_URL/agents"

echo
echo "-- register beta --"
curl -sS -H 'content-type: application/json' \
  -H "x-registration-secret: ${REGISTRATION_SECRET}" \
  -d '{"name":"beta"}' \
  "$API_URL/agents" | tee "$BETA_JSON"
echo

ALPHA=$(ALPHA_JSON="$ALPHA_JSON" python3 -c 'import json,os; print(json.load(open(os.environ["ALPHA_JSON"]))["token"])')
BETA=$(BETA_JSON="$BETA_JSON" python3 -c 'import json,os; print(json.load(open(os.environ["BETA_JSON"]))["token"])')

echo "-- message to Beta and paged inbox --"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H "authorization: Bearer $ALPHA" \
  -H 'content-type: application/json' \
  -d '{"to":"Beta","body":"first"}' \
  "$API_URL/messages"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H "authorization: Bearer $ALPHA" \
  -H 'content-type: application/json' \
  -d '{"to":"beta","body":"second"}' \
  "$API_URL/messages"
self_code=$(curl -sS -o "${E2E_DIR}/self.json" -w "%{http_code}" \
  -H "authorization: Bearer $ALPHA" \
  -H 'content-type: application/json' \
  -d '{"to":"ALPHA","body":"nope"}' \
  "$API_URL/messages")
echo "self-send HTTP ${self_code}"
if [[ "$self_code" != "400" ]]; then
  echo "expected self-send to be rejected" >&2
  exit 1
fi

echo "page 1"
curl -sS -o "$PAGE_JSON" -w "HTTP %{http_code}\n" \
  -H "authorization: Bearer $BETA" \
  "$API_URL/inbox?limit=1"
cat "$PAGE_JSON"
echo
CURSOR=$(PAGE_JSON="$PAGE_JSON" python3 -c 'import json,os; print(json.load(open(os.environ["PAGE_JSON"]))["next"])')
echo "page 2 after $CURSOR"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H "authorization: Bearer $BETA" \
  --get \
  --data-urlencode "after=$CURSOR" \
  "$API_URL/inbox"

bad_code=$(curl -sS -o "${E2E_DIR}/bad-cursor.json" -w "%{http_code}" \
  -H "authorization: Bearer $BETA" \
  --get \
  --data-urlencode "after=2026-02-30T00:00:00.000Z|00000000-0000-4000-8000-000000000001" \
  "$API_URL/inbox")
echo "bad cursor HTTP ${bad_code}"
if [[ "$bad_code" != "400" ]]; then
  echo "expected an impossible cursor date to be rejected" >&2
  exit 1
fi

echo
echo "-- sender inbox stays empty --"
curl -sS -w "\nHTTP %{http_code}\n" \
  -H "authorization: Bearer $ALPHA" \
  "$API_URL/inbox"

touch "$MID_MARKER"
sleep 2

echo
echo "-- logs redact the token and registration secret --"
if grep -F "$ALPHA" "$API_LOG" || grep -F "$REGISTRATION_SECRET" "$API_LOG"; then
  echo "secret leaked into API logs" >&2
  exit 1
fi
grep -F "[Redacted]" "$API_LOG" >/dev/null
echo "redacted"

echo
echo "-- unreachable database stays up and returns 503 --"
env -u HOST \
  DATABASE_URL="$DOWN_DATABASE_URL" \
  PORT="$DOWN_PORT" \
  node "${SWITCHBOARD_ROOT}/apps/api/dist/index.js" >"$DOWN_LOG" 2>&1 &
DOWN_PID=$!
sleep 0.3
down_body=$(curl -sS -w "\nHTTP %{http_code}\n" "$DOWN_URL/health" || true)
printf '%s\n' "$down_body"
agents_body=$(curl -sS --max-time 10 -w "\nHTTP %{http_code}\n" \
  -H "authorization: Bearer not-a-real-token" \
  "$DOWN_URL/agents" || true)
printf '%s\n' "$agents_body"
if ! kill -0 "$DOWN_PID"; then
  echo "down API exited" >&2
  cat "$DOWN_LOG" >&2
  exit 1
fi
echo "process $DOWN_PID still running"
mapfile -t down_parts < <(DOWN_DATABASE_URL="$DOWN_DATABASE_URL" python3 - <<'PY'
import os
from urllib.parse import unquote, urlparse
url = urlparse(os.environ["DOWN_DATABASE_URL"])
print(unquote(url.username or ""))
print(unquote(url.password or ""))
print(unquote(url.path.lstrip("/")))
PY
)
leaked=0
for part in "${down_parts[@]}"; do
  if [[ -n "$part" ]] && printf '%s' "$down_body$agents_body" | grep -F "$part" >/dev/null; then
    leaked=1
  fi
done
if [[ "$leaked" == 1 ]] || printf '%s' "$down_body$agents_body" | grep -F 'ECONNREFUSED' >/dev/null; then
  echo "response leaked the database error" >&2
  exit 1
fi
if ! printf '%s' "$agents_body" | grep -F 'HTTP 503' >/dev/null; then
  echo "protected route did not return 503" >&2
  exit 1
fi
kill "$DOWN_PID"
wait "$DOWN_PID" 2>/dev/null || true
DOWN_PID=""

echo
echo "PASS"
touch "$DONE_MARKER"
sleep 4
