#!/bin/sh
# Create an Nginx reverse-proxy site for one Circle domain and give it HTTPS.
#
# This automates the manual sequence documented in "HTTPS with Nginx and
# Certbot" in the repository README: write the HTTP site, verify the public
# readiness route, then let Certbot install the certificate and the redirect.
#
# Usage:
#   sudo ./deploy/add-nginx-site.sh circle.example.com
#   sudo ./deploy/add-nginx-site.sh circle.example.com 3100
set -eu

MARKER='# Managed by Circlus deploy/add-nginx-site.sh'

usage() {
  cat <<'EOF'
Usage: deploy/add-nginx-site.sh DOMAIN [PORT]

DOMAIN  Circle domain with an A record already pointing at this host.
PORT    Loopback port of the Circlus API. Defaults to PORT from deploy/.env,
        or 3000 when that file does not set it.

Optional environment variables:
  CERTBOT_EMAIL  Run Certbot non-interactively with this registration address.

The script writes /etc/nginx/sites-available/DOMAIN, enables it, checks that
http://DOMAIN/ready is publicly reachable, and only then requests the
certificate. It refuses to overwrite a site file it did not create.
EOF
}

case "${1:-}" in
  ''|-h|--help)
    usage
    exit 0
    ;;
esac

domain="$1"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file="$script_dir/.env"

case "$domain" in
  *[!A-Za-z0-9.-]*|-*|*-|.*|*.|*..*)
    echo "invalid domain: $domain" >&2
    exit 1
    ;;
  *.*) ;;
  *)
    echo "domain must be fully qualified: $domain" >&2
    exit 1
    ;;
esac

port="${2:-}"
if [ -z "$port" ] && [ -f "$env_file" ]; then
  # Read only PORT; the deployment file also holds secrets this script never needs.
  port=$(sed -n 's/^PORT=\([0-9]\{1,5\}\)[[:space:]]*$/\1/p' "$env_file" 2>/dev/null | tail -n 1)
fi
port="${port:-3000}"
case "$port" in
  ''|*[!0-9]*)
    echo "port must be an integer from 1 to 65535: $port" >&2
    exit 1
    ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  echo "port must be an integer from 1 to 65535: $port" >&2
  exit 1
fi

for required_command in nginx certbot systemctl curl; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "missing required command: $required_command" >&2
    echo "install it first: sudo apt install nginx certbot python3-certbot-nginx curl" >&2
    exit 1
  fi
done

if [ "$(id -u)" -eq 0 ]; then
  run_privileged() { "$@"; }
elif command -v sudo >/dev/null 2>&1; then
  run_privileged() { sudo "$@"; }
else
  echo "run this script as root or install sudo" >&2
  exit 1
fi

available="/etc/nginx/sites-available/$domain"
enabled="/etc/nginx/sites-enabled/$domain"

# An operator-written or Certbot-extended site must never be silently replaced.
if [ -e "$available" ] && ! head -n 1 "$available" | grep -qxF "$MARKER"; then
  echo "refusing to overwrite an existing site file this script did not create: $available" >&2
  echo "remove or rename it first, or follow the manual sequence in the README" >&2
  exit 1
fi
if [ -e "$enabled" ] && [ ! -L "$enabled" ]; then
  echo "refusing to replace a regular file in sites-enabled: $enabled" >&2
  exit 1
fi

echo "[add-nginx-site] writing HTTP site for $domain -> 127.0.0.1:$port"
tmp_conf=$(mktemp)
trap 'rm -f "$tmp_conf"' EXIT
cat > "$tmp_conf" <<EOF
$MARKER
server {
    listen 80;
    listen [::]:80;
    server_name $domain;

    # Keep this in step with the server's attachment request limit.
    client_max_body_size 250m;

    location / {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;

        # Circlus resolves a Circle from the original public host.
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Required for WebSocket messaging and call signaling.
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
run_privileged install -m 0644 "$tmp_conf" "$available"

echo "[add-nginx-site] enabling the site"
run_privileged ln -sfn "$available" "$enabled"
run_privileged nginx -t
run_privileged systemctl reload nginx

# Nginx replaces its workers asynchronously, and Certbot's HTTP-01 challenge
# fails unless the public route already works.
echo "[add-nginx-site] checking http://$domain/ready"
sleep 2
readiness=$(curl --silent --show-error --max-time 15 \
  --write-out '\n%{http_code}' "http://$domain/ready" 2>&1) || {
  echo "$readiness" >&2
  echo "[add-nginx-site] http://$domain/ready is not reachable." >&2
  echo "Check the A record, port 80 in the hosting firewall, and that the API answers on 127.0.0.1:$port." >&2
  exit 1
}
readiness_code=$(printf '%s' "$readiness" | tail -n 1)
readiness_body=$(printf '%s' "$readiness" | sed '$d')
if [ "$readiness_code" != "200" ] || ! printf '%s' "$readiness_body" | grep -q '"status":"ok"'; then
  echo "[add-nginx-site] unexpected readiness response: HTTP $readiness_code $readiness_body" >&2
  case "$readiness_code" in
    30*)
      echo "Another site is answering for this domain, usually the default site with its own HTTPS redirect." >&2
      ;;
    404)
      echo "Nginx is serving a different site; check that no other server block claims this domain." >&2
      ;;
  esac
  echo "Certbot was not started. Fix the HTTP route and run this script again." >&2
  exit 1
fi

echo "[add-nginx-site] requesting the certificate"
set -- --nginx --redirect --keep-until-expiring -d "$domain"
if [ -n "${CERTBOT_EMAIL:-}" ]; then
  set -- "$@" --non-interactive --agree-tos -m "$CERTBOT_EMAIL"
fi
run_privileged certbot "$@"

echo "[add-nginx-site] checking https://$domain/ready"
sleep 2
if ! curl --silent --show-error --fail --max-time 15 "https://$domain/ready" >/dev/null; then
  echo "[add-nginx-site] HTTPS readiness check failed for $domain" >&2
  exit 1
fi

cat <<EOF

[add-nginx-site] done: https://$domain -> http://127.0.0.1:$port

Next steps:
  1. Confirm renewal:  sudo certbot renew --cert-name $domain --dry-run
  2. Create the Circle for this domain from an official Circlus client.
     With server-admin access, use Settings -> Server Management. On a server
     that has no Circle yet, follow "First Circle Provisioning" in the README.
EOF
