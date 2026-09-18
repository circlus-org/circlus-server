#!/usr/bin/env bash
set -euo pipefail

# Same as pgtyped-generate.sh but in watch mode.

if [ ! -f .env ]; then
  echo "ERROR: .env file not found in $(pwd)"
  echo "Run from server/ and create it: cp .env.example .env"
  exit 1
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
  echo "ERROR: DATABASE_URL is not set in .env"
  exit 1
fi

exec npx pgtyped -c pgtyped.config.json --watch --uri "$DATABASE_URL"
