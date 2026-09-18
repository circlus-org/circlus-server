#!/bin/sh
set -eu

secret_file="/run/secrets/turn_local"
template_file="/opt/circlus/turnserver.conf.template"
runtime_file="/tmp/turnserver.conf"

if [ ! -s "$secret_file" ]; then
  echo "coturn secret file is missing or empty" >&2
  exit 1
fi
if [ -z "${TURN_REALM:-}" ]; then
  echo "TURN_REALM is required" >&2
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

cp "$template_file" "$runtime_file"
{
  printf 'realm=%s\n' "$TURN_REALM"
  printf 'server-name=%s\n' "$TURN_REALM"
  printf 'min-port=%s\n' "$relay_min_port"
  printf 'max-port=%s\n' "$relay_max_port"
  printf 'static-auth-secret=%s\n' "$(tr -d '\r\n' < "$secret_file")"
  if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
    printf 'external-ip=%s\n' "$TURN_EXTERNAL_IP"
  fi
} >> "$runtime_file"
chmod 600 "$runtime_file"

exec turnserver -c "$runtime_file"
