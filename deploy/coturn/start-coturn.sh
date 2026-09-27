#!/bin/sh
set -eu

secret_file="/run/secrets/turn_local"
template_file="/opt/circlus/turnserver.conf.template"
runtime_file="/tmp/turnserver.conf"

if [ ! -r "$secret_file" ] || [ ! -s "$secret_file" ]; then
  echo "coturn secret file is missing, unreadable or empty; run deploy/init-local-turn.sh and recreate coturn" >&2
  exit 1
fi
# Do not hide a failed command substitution inside a successful printf.
if ! turn_secret=$(tr -d '\r\n' < "$secret_file"); then
  echo "coturn secret file could not be read" >&2
  exit 1
fi
if [ -z "$turn_secret" ]; then
  echo "coturn secret file contains no secret" >&2
  exit 1
fi
if [ -z "${TURN_REALM:-}" ]; then
  echo "TURN_REALM is required" >&2
  exit 1
fi

listen_port="${TURN_LISTEN_PORT:-3478}"
case "$listen_port" in
  ''|*[!0-9]*)
    echo "TURN_LISTEN_PORT must be an integer from 1 to 65535" >&2
    exit 1
    ;;
esac
if [ "$listen_port" -lt 1 ] || [ "$listen_port" -gt 65535 ]; then
  echo "TURN_LISTEN_PORT must be an integer from 1 to 65535" >&2
  exit 1
fi

relay_min_port="${TURN_RELAY_MIN_PORT:-49160}"
relay_max_port="${TURN_RELAY_MAX_PORT:-49200}"
case "$relay_min_port:$relay_max_port" in
  *[!0-9:]*|:*|*:)
    echo "TURN relay ports must be integers" >&2
    exit 1
    ;;
esac
if [ "$relay_min_port" -gt "$relay_max_port" ]; then
  echo "TURN_RELAY_MIN_PORT must not exceed TURN_RELAY_MAX_PORT" >&2
  exit 1
fi

umask 077
runtime_tmp=$(mktemp "${runtime_file}.XXXXXX")
trap 'rm -f "$runtime_tmp"' EXIT
cp "$template_file" "$runtime_tmp"
{
  printf 'listening-port=%s\n' "$listen_port"
  printf 'realm=%s\n' "$TURN_REALM"
  printf 'server-name=%s\n' "$TURN_REALM"
  printf 'min-port=%s\n' "$relay_min_port"
  printf 'max-port=%s\n' "$relay_max_port"
  printf 'static-auth-secret=%s\n' "$turn_secret"
  if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
    printf 'external-ip=%s\n' "$TURN_EXTERNAL_IP"
  fi
} >> "$runtime_tmp"
chmod 600 "$runtime_tmp"
mv -f "$runtime_tmp" "$runtime_file"
trap - EXIT
unset turn_secret

exec turnserver -c "$runtime_file"
