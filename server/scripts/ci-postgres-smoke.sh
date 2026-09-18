#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

npm run migrate:prod

SMOKE_LOG="$(mktemp)"
SERVER_PID=""
cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}"
    wait "${SERVER_PID}" || true
  fi
  rm -f "${SMOKE_LOG}"
}
trap cleanup EXIT

VPS_ID="${VPS_ID:-ci-postgres-smoke}" PORT="${PORT:-3010}" \
  node dist/server/src/index.js >"${SMOKE_LOG}" 2>&1 &
SERVER_PID="$!"

for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error "http://127.0.0.1:${PORT:-3010}/ready" >/dev/null; then
    kill -TERM "${SERVER_PID}"
    if ! wait "${SERVER_PID}"; then
      echo "Server did not shut down cleanly after SIGTERM" >&2
      sed -n '1,200p' "${SMOKE_LOG}" >&2
      exit 1
    fi
    SERVER_PID=""
    echo "PostgreSQL startup/readiness/graceful-shutdown smoke test passed"
    exit 0
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "Server exited before becoming ready" >&2
    sed -n '1,200p' "${SMOKE_LOG}" >&2
    exit 1
  fi
  sleep 1
done

echo "Server did not become ready within 30 seconds" >&2
sed -n '1,200p' "${SMOKE_LOG}" >&2
exit 1
