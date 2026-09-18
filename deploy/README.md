# Circlus Docker deployment

These files are the source for the public self-hosted Docker installation.
They do not replace the PM2 deployment used by the complete private source
repository.

## Prepare local ICE and TURN

```bash
cp deploy/.env.example deploy/.env
# Set VPS_ID, POSTGRES_PASSWORD, TURN_PUBLIC_HOST and TURN_REALM.
./deploy/init-local-turn.sh
```

The initialization script creates deployment-local files which are ignored by
Git and the Docker build context:

- `deploy/ice/turn-clusters.json`;
- `deploy/secrets/ice-s2s.secret`;
- `deploy/secrets/ice-subject-id.secret`;
- `deploy/secrets/turn-local.secret`.

It never replaces an existing secret or ICE configuration.

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

- TCP and UDP `3478`;
- UDP `49160-49200`, or the configured relay range.

The initial profile intentionally does not configure TURN TLS on `5349`.
Add certificate handling before advertising `turns:` URLs.

## External clusters

An external TURN server is another entry in `turnClusters`; it does not require
another local container. Add its credential file under `deploy/secrets/`, mount
path `/run/circlus-secrets/<name>`, and add its id to the authorized server's
`allowedTurnClusterIds`.
