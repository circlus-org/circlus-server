# Circlus Server

Run Circlus on your own VPS for private Circles, messages, files, and calls.
This repository contains the server, its database migrations, and a Docker
Compose setup with PostgreSQL, ICE configuration, and an optional local TURN
server. Use the [Circlus web client](https://web.circlus.org) or the
[Android app](https://circlus.org/#clients) to connect.

This repository is for running your own server and inspecting what the server
does with data it receives. Private messages and ordinary attachments are
stored as ciphertext. The server still needs routing and access metadata, and
it handles some deliberately public content and operational data in readable
form. See [what the server can see](docs/DATA_VISIBILITY.md) for the boundaries
and exceptions. Reviewing server code alone cannot establish how a client
encrypts data or handles keys.

## Requirements

- A Linux VPS with Docker and Docker Compose. A 2 GB RAM VPS is a practical
  starting point for a small Circle.
- A domain or subdomain pointing to the VPS for the first Circle.
- TCP ports 80 and 443 for HTTPS; TCP and UDP port 3478 plus UDP ports
  49160–49200 for the default local TURN setup. Adjust these if you change the
  TURN ports in `deploy/.env`.

The instructions below use Ubuntu or Debian for Nginx and Certbot. See
[deployment details](deploy/README.md) for ports, additional Circle domains,
and backups.

## Install with Docker Compose

1. Copy the deployment settings and set the public address for TURN. The Circle
   domain can also be used for TURN on port 3478.

   ```bash
   cp deploy/.env.example deploy/.env
   nano deploy/.env
   ```

   Set at least:

   ```env
   TURN_PUBLIC_HOST=circle.example.com
   ```

2. Generate local credentials and start the stack:

   ```bash
   ./deploy/init-local-turn.sh
   docker compose --env-file deploy/.env --profile local-turn up -d --build
   ```

   The initializer creates a stable `VPS_ID`, database password, ICE/TURN
   configuration, and secret files. Keep `deploy/.env`, `deploy/secrets/`, and
   `deploy/ice/turn-clusters.json` when updating or restoring the server.

3. Install Nginx and Certbot, then set up HTTPS for the Circle domain:

   ```bash
   sudo apt update
   sudo apt install nginx certbot python3-certbot-nginx
   sudo ./deploy/add-nginx-site.sh circle.example.com
   curl --fail --show-error https://circle.example.com/ready
   ```

   The domain must already resolve to this VPS. The setup script checks HTTP
   routing before requesting a certificate. The readiness request should return
   JSON with `"status":"ok"`. If you already manage Nginx, see the
   [included proxy example](deploy/nginx/circlus-server.conf.example).

4. Create a one-time server administrator claim token:

   ```bash
   docker compose --env-file deploy/.env exec -e LOG_LEVEL=warn server \
     npm run server-admin:create-claim:prod -- --ttl-hours=1
   ```

5. Open the [Circlus web client](https://web.circlus.org). On the start screen,
   choose **Create a Circle on your own server**. Enter the HTTPS server URL and
   the claim token. If you already have a profile, use **Settings → Server
   Management → Connect a new server** instead.

### Push notifications

After creating a Circle, open **Settings → Server Management → Push
notifications** in the client and create a connection request. Send the
pre-filled request through the support contact opened by the app. Once approved,
refresh the push status until it shows **Connected and ready**. Credentials are
installed directly on the server; keep
`deploy/secrets/push-config-encryption.secret` in backups.

## Updating and backups

Before updating, back up **both** PostgreSQL and the Docker `server_data` volume.
Also preserve `deploy/.env`, `deploy/secrets/`, and
`deploy/ice/turn-clusters.json`. The database dump alone does not contain file
attachments. See [backup instructions](deploy/README.md#backups).

Then, from the repository root:

```bash
git pull --ff-only
./deploy/init-local-turn.sh
docker compose --env-file deploy/.env --profile local-turn up -d --build
```

Keep the same Compose project name as the original installation. The
`migrate` service applies pending database migrations before the server starts.

## Configuration and troubleshooting

`deploy/.env.example` lists deployment settings; `server/.env.example` is the
complete server setting reference. The API and ICE Config Service listen on
host loopback ports 3000 and 3090 by default. PostgreSQL has no host port.

- **HTTPS fails:** check DNS, ports 80/443, and the Nginx site. The public
  `/ready` endpoint should return `"status":"ok"`.
- **The client cannot connect:** check HTTPS and the server logs.
- **Calls fail on some networks:** check the TURN host, firewall ports, and
  [TURN ports](deploy/README.md#host-ports).
- **Push does not arrive:** check the connection status in Server Management.
- **Migration fails:** check PostgreSQL connectivity and whether an applied SQL
  migration was changed. Do not edit applied migrations.

[Deployment details](deploy/README.md) cover ports, additional Circle domains,
backups, and emergency deletion after owner identity loss. [Security policy](SECURITY.md) explains how to report vulnerabilities.

For a closer look at server behavior, see [data visibility](docs/DATA_VISIBILITY.md),
[capabilities](docs/SERVER_CAPABILITIES.md),
[request reliability](docs/REQUEST_RELIABILITY.md),
[HTTP signaling](docs/HTTP_SIGNALING.md), and
[WebSocket limits](docs/WEBSOCKET_LIMITS.md). Deployment questions and ideas
about the protocol or product can be discussed in GitHub issues. Please report
suspected vulnerabilities privately as described in the security policy.

## License

MIT. See [LICENSE](LICENSE).
