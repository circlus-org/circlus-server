#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file="$script_dir/.env"
env_file_selected=false
set_image_tag=false
requested_tag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image-tag)
      if [ "$set_image_tag" = true ] || [ "$#" -lt 2 ]; then
        echo "usage: $0 [ENV_FILE] [--image-tag TAG]" >&2
        exit 1
      fi
      requested_tag="$2"
      set_image_tag=true
      shift 2
      ;;
    --*)
      echo "unknown option: $1" >&2
      echo "usage: $0 [ENV_FILE] [--image-tag TAG]" >&2
      exit 1
      ;;
    *)
      if [ "$env_file_selected" = true ]; then
        echo "usage: $0 [ENV_FILE] [--image-tag TAG]" >&2
        exit 1
      fi
      env_file="$1"
      env_file_selected=true
      shift
      ;;
  esac
done

if [ ! -f "$env_file" ]; then
  echo "deployment environment file not found: $env_file" >&2
  echo "copy deploy/.env.example to deploy/.env and set TURN_PUBLIC_HOST first" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate deployment secrets" >&2
  exit 1
fi
if [ "$set_image_tag" = true ]; then
  case "$requested_tag" in
    v*) ;;
    *) echo "--image-tag requires a nonempty release tag beginning with v" >&2; exit 1 ;;
  esac
  case "$requested_tag" in
    *[!A-Za-z0-9_.-]*) echo "--image-tag contains unsupported characters" >&2; exit 1 ;;
  esac
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to verify --image-tag" >&2
    exit 1
  fi
  tag_commit=$(git -c "safe.directory=$repo_dir" -C "$repo_dir" rev-parse -q --verify "refs/tags/$requested_tag^{commit}") || {
    echo "--image-tag does not name a tag in this checkout: $requested_tag" >&2
    exit 1
  }
  head_commit=$(git -c "safe.directory=$repo_dir" -C "$repo_dir" rev-parse HEAD) || exit 1
  if [ "$tag_commit" != "$head_commit" ]; then
    echo "--image-tag=$requested_tag does not point to the checked-out commit" >&2
    exit 1
  fi
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
if [ -z "${MOBILE_CALL_ACTION_SECRET:-}" ]; then
  MOBILE_CALL_ACTION_SECRET=$(openssl rand -hex 32)
  persist_env_value MOBILE_CALL_ACTION_SECRET "$MOBILE_CALL_ACTION_SECRET"
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
generate_secret_if_missing "$secrets_dir/circle-migration.secret"

# Compose file-backed secrets keep host ownership and mode. Grant each
# non-root service the file's group instead of exposing secrets to everyone.
server_secret_gid=""
prepare_server_secret() {
  secret_file="$1"
  case "$secret_file" in
    /*) ;;
    *) secret_file="$repo_dir/$secret_file" ;;
  esac
  if [ ! -f "$secret_file" ] || [ ! -s "$secret_file" ] || [ ! -r "$secret_file" ]; then
    echo "Server secret must be a readable, nonempty file: $secret_file" >&2
    exit 1
  fi
  secret_gid=$(stat -c '%g' "$secret_file")
  if [ -n "$server_secret_gid" ] && [ "$secret_gid" != "$server_secret_gid" ]; then
    echo "Server secrets must share one host group: $secret_file has group $secret_gid, expected $server_secret_gid" >&2
    exit 1
  fi
  server_secret_gid="$secret_gid"
  chmod 640 "$secret_file"
}

prepare_server_secret "${ICE_S2S_SECRET_FILE:-$secrets_dir/ice-s2s.secret}"
prepare_server_secret "${ICE_SUBJECT_ID_SECRET_FILE:-$secrets_dir/ice-subject-id.secret}"
prepare_server_secret "${PUSH_CONFIG_ENCRYPTION_SECRET_FILE:-$secrets_dir/push-config-encryption.secret}"
prepare_server_secret "${CIRCLE_MIGRATION_SECRET_FILE:-$secrets_dir/circle-migration.secret}"
persist_env_value SERVER_SECRET_GID "$server_secret_gid"

turn_secret_file="${TURN_LOCAL_SECRET_FILE:-$secrets_dir/turn-local.secret}"
case "$turn_secret_file" in
  /*) ;;
  *) turn_secret_file="$repo_dir/$turn_secret_file" ;;
esac
if [ ! -f "$turn_secret_file" ] || [ ! -s "$turn_secret_file" ] || [ ! -r "$turn_secret_file" ]; then
  echo "TURN secret must be a readable, nonempty file: $turn_secret_file" >&2
  exit 1
fi
turn_secret_gid=$(stat -c '%g' "$turn_secret_file")
chmod 640 "$turn_secret_file"
persist_env_value TURN_SECRET_GID "$turn_secret_gid"

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

if [ "$set_image_tag" = true ]; then
  persist_env_value CIRCLUS_IMAGE_TAG "$requested_tag"
  echo "CIRCLUS_IMAGE_TAG=$requested_tag saved in $env_file"
fi

echo "local ICE/TURN secrets are ready in: $secrets_dir"
