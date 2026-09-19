#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file="${1:-$script_dir/.env}"

if [ ! -f "$env_file" ]; then
  echo "deployment environment file not found: $env_file" >&2
  echo "copy deploy/.env.example to deploy/.env and set TURN_PUBLIC_HOST first" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate deployment secrets" >&2
  exit 1
fi

set -a
# This is an operator-owned deployment file, equivalent to a Compose env file.
. "$env_file"
set +a

case "${VPS_ID:-}" in
  *[!A-Za-z0-9._-]*)
    echo "VPS_ID must use only letters, digits, dot, underscore, or hyphen" >&2
    exit 1
    ;;
esac
case "${TURN_PUBLIC_HOST:-}" in
  ''|*[!A-Za-z0-9.:-]*)
    echo "TURN_PUBLIC_HOST must be a hostname or IP address without a URL scheme" >&2
    exit 1
    ;;
esac
turn_listen_port="${TURN_LISTEN_PORT:-3478}"
case "$turn_listen_port" in
  ''|*[!0-9]*)
    echo "TURN_LISTEN_PORT must be an integer from 1 to 65535" >&2
    exit 1
    ;;
esac
if [ "$turn_listen_port" -lt 1 ] || [ "$turn_listen_port" -gt 65535 ]; then
  echo "TURN_LISTEN_PORT must be an integer from 1 to 65535" >&2
  exit 1
fi

# Values generated here must remain stable across restarts and upgrades.
persist_env_value() {
  key="$1"
  value="$2"
  temp_file=$(mktemp "${env_file}.XXXXXX")
  if ! awk -v key="$key" -v value="$value" '
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$env_file" > "$temp_file"; then
    rm -f "$temp_file"
    exit 1
  fi
  chmod 600 "$temp_file"
  mv "$temp_file" "$env_file"
}

umask 077
if [ -z "${VPS_ID:-}" ]; then
  VPS_ID="vps-$(openssl rand -hex 8)"
  persist_env_value VPS_ID "$VPS_ID"
fi
if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  POSTGRES_PASSWORD=$(openssl rand -hex 32)
  persist_env_value POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
fi
if [ -z "${TURN_REALM:-}" ]; then
  TURN_REALM="$TURN_PUBLIC_HOST"
  persist_env_value TURN_REALM "$TURN_REALM"
fi
chmod 600 "$env_file"
case "${ICE_CONFIG_KEY_ID:-k1}" in
  *[!A-Za-z0-9._-]*)
    echo "ICE_CONFIG_KEY_ID contains unsupported characters" >&2
    exit 1
    ;;
esac

secrets_dir="$script_dir/secrets"
config_file="$script_dir/ice/turn-clusters.json"
template_file="$script_dir/ice/turn-clusters.example.json"
mkdir -p "$secrets_dir"

generate_secret_if_missing() {
  target="$1"
  if [ -e "$target" ]; then
    if [ ! -s "$target" ]; then
      echo "refusing to replace empty existing secret: $target" >&2
      exit 1
    fi
    return
  fi
  openssl rand -base64 32 > "$target"
}

generate_secret_if_missing "$secrets_dir/ice-s2s.secret"
generate_secret_if_missing "$secrets_dir/ice-subject-id.secret"
generate_secret_if_missing "$secrets_dir/turn-local.secret"
generate_secret_if_missing "$secrets_dir/push-config-encryption.secret"

if [ -e "$config_file" ]; then
  echo "configuration already exists, leaving it unchanged: $config_file"
else
  sed \
    -e "s/TURN_PUBLIC_HOST/${TURN_PUBLIC_HOST}/g" \
    -e "s/TURN_LISTEN_PORT/${turn_listen_port}/g" \
    -e "s/\"VPS_ID\"/\"${VPS_ID}\"/g" \
    -e "s/\"ICE_CONFIG_KEY_ID\"/\"${ICE_CONFIG_KEY_ID:-k1}\"/g" \
    "$template_file" > "$config_file"
  chmod 600 "$config_file"
  echo "created ICE configuration: $config_file"
fi

echo "local ICE/TURN secrets are ready in: $secrets_dir"
echo "validate with: docker compose --env-file deploy/.env --profile local-turn config"
