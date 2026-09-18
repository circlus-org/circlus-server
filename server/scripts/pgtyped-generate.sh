#!/usr/bin/env bash
set -euo pipefail

SKIP_ON_ERROR="${PGTYPED_SKIP_ON_ERROR:-0}"

soft_fail_or_exit() {
  local message="$1"
  if [ "$SKIP_ON_ERROR" = "1" ]; then
    echo "WARN: $message"
    echo "WARN: Reusing checked-in pgtyped outputs for this build."
    exit 0
  fi
  echo "ERROR: $message"
  exit 1
}

# Loads .env without breaking on values with spaces and runs pgtyped using DATABASE_URL.

if [ ! -f .env ]; then
  soft_fail_or_exit ".env file not found in $(pwd). Run from server/ and create it: cp .env.minimal.example .env"
fi

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in
    ''|'#'*) continue ;;
  esac
  if [[ "$line" != *"="* ]]; then
    continue
  fi

  key="${line%%=*}"
  value="${line#*=}"

  key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  value="$(echo "$value" | sed -e 's/^[[:space:]]*//')"

  if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
    value="${value:1:${#value}-2}"
  fi

  export "$key=$value"
done < .env

if [ -z "${DATABASE_URL:-}" ]; then
  soft_fail_or_exit "DATABASE_URL is not set in .env"
fi

if ! npm run migrate; then
  soft_fail_or_exit "Database migrations could not be applied before pgtyped generation"
fi

if ! npx pgtyped -c pgtyped.config.json --uri "$DATABASE_URL"; then
  soft_fail_or_exit "pgtyped generation failed"
fi
