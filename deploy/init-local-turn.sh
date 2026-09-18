#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file="${1:-$script_dir/.env}"

if [ ! -f "$env_file" ]; then
  echo "deployment environment file not found: $env_file" >&2
  echo "copy deploy/.env.example to deploy/.env and edit it first" >&2
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
  ''|*[!A-Za-z0-9._-]*)
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
  umask 077
  openssl rand -base64 32 > "$target"
}

generate_secret_if_missing "$secrets_dir/ice-s2s.secret"
generate_secret_if_missing "$secrets_dir/ice-subject-id.secret"
generate_secret_if_missing "$secrets_dir/turn-local.secret"

if [ -e "$config_file" ]; then
  echo "configuration already exists, leaving it unchanged: $config_file"
else
  sed \
    -e "s/TURN_PUBLIC_HOST/${TURN_PUBLIC_HOST}/g" \
    -e "s/\"VPS_ID\"/\"${VPS_ID}\"/g" \
    -e "s/\"ICE_CONFIG_KEY_ID\"/\"${ICE_CONFIG_KEY_ID:-k1}\"/g" \
    "$template_file" > "$config_file"
  chmod 600 "$config_file"
  echo "created ICE configuration: $config_file"
fi

echo "local ICE/TURN secrets are ready in: $secrets_dir"
echo "validate with: docker compose --env-file deploy/.env --profile local-turn config"
