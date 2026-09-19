# Circlus Docker deployment

These files are the source for the public self-hosted Docker installation.
They do not replace the PM2 deployment used by the complete private source
repository.

## Prepare local ICE and TURN

```bash
cp deploy/.env.example deploy/.env
# Set TURN_PUBLIC_HOST to the public DNS name or IP used by clients.
./deploy/init-local-turn.sh
```

The initialization script creates deployment-local files which are ignored by
Git and the Docker build context:

- `deploy/ice/turn-clusters.json`;
- `deploy/secrets/ice-s2s.secret`;
- `deploy/secrets/ice-subject-id.secret`;
- `deploy/secrets/turn-local.secret`.

The script also generates `VPS_ID` and `POSTGRES_PASSWORD` in `deploy/.env`
when empty, and defaults `TURN_REALM` to `TURN_PUBLIC_HOST`. Existing values,
secrets, and ICE configuration are preserved. Keep `deploy/.env` and the secret
files when updating this installation.

## Host ports

Check for existing listeners before starting Compose:

```bash
sudo ss -lntup | grep -E ':(80|443|3000|3090|3478)([^0-9]|$)' || true
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

The API and ICE Config Service bind only to host loopback, using `PORT=3000`
and `ICE_CONFIG_HOST_PORT=3090` by default. Change those values in
`deploy/.env` if occupied. For example, set `PORT=3100` and point Nginx at
`127.0.0.1:3100`. The container's API port remains `3000`. Use
`ICE_CONFIG_HOST_PORT` in any host-side ICE service or smoke-test
URL. PostgreSQL has no host port. Ports 80 and 443 may already belong to an
existing reverse proxy; add a virtual host for the Circle domain there.

Coturn uses TCP and UDP port `TURN_LISTEN_PORT=3478` by default. Choose a
different free port in `deploy/.env` **before** running `init-local-turn.sh`.
The generated ICE URLs include this port; clients use those URLs without a
separate client setting. After initialization, changing the port also requires
updating both TURN URLs in `deploy/ice/turn-clusters.json`. Open the chosen
TCP/UDP port and relay UDP range in the firewall. Port 443 is not a plain
TURN/TLS option in this profile; it requires separate TLS and proxy setup.

For the complete beginner sequence—HTTP Nginx configuration, public readiness
check, Certbot certificate issuance, HTTPS verification, and renewal test—see
`HTTPS with Nginx and Certbot` in the repository root `README.md`. Do not run
Certbot until the public HTTP readiness check succeeds.

## Full public stack

```bash
docker compose --env-file deploy/.env --profile local-turn up -d --build
```

Without `--profile local-turn`, coturn is not started. The local ICE Config
Service still starts and can use external clusters configured in
`deploy/ice/turn-clusters.json`.

## Existing PM2 server

Keep the Circlus API server and PostgreSQL under their existing process
management. Start only the new infrastructure:

```bash
docker compose --env-file deploy/.env --profile local-turn \
  up -d --build ice-config-service coturn
```

Configure the PM2-managed server with:

```env
ICE_CONFIG_SERVICE_URL=http://127.0.0.1:3090
ICE_CONFIG_SERVER_ID=<same value as VPS_ID in deploy/.env>
ICE_CONFIG_KEY_ID=k1
ICE_CONFIG_SHARED_SECRET_FILE=/absolute/path/to/deploy/secrets/ice-s2s.secret
ICE_SUBJECT_ID_SECRET_FILE=/absolute/path/to/deploy/secrets/ice-subject-id.secret
```

The ICE Config Service port is bound to host loopback only. Coturn uses host
networking because the official coturn image recommends it for large UDP relay
port ranges on Linux VPS hosts.

Verify that the running ICE service accepts a signed request and returns
short-lived credentials for the local cluster:

```bash
set -a
. deploy/.env
set +a
node deploy/smoke-test-ice.mjs
```

The public CI runs this check both with an explicit cluster and with the
legacy default-cluster request shape.

Open these firewall ports for the local TURN profile:

- TCP and UDP `TURN_LISTEN_PORT` (`3478` by default);
- UDP `49160-49200`, or the configured relay range.

The initial profile intentionally does not configure TURN TLS on `5349`.
Add certificate handling before advertising `turns:` URLs.

## External clusters

An external TURN server is another entry in `turnClusters`; it does not require
another local container. Add its credential file under `deploy/secrets/`, mount
path `/run/circlus-secrets/<name>`, and add its id to the authorized server's
`allowedTurnClusterIds`.
