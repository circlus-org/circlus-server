# Circlus Docker deployment

Details for the Docker Compose installation in the [root README](../README.md):
ports, HTTPS, additional Circles, updates, and backups.

## Files created during setup

`deploy/init-local-turn.sh`, run during the installation in the root README,
creates local files ignored by Git and the Docker build context:

- `deploy/ice/turn-clusters.json`;
- `deploy/secrets/ice-s2s.secret`;
- `deploy/secrets/ice-subject-id.secret`;
- `deploy/secrets/turn-local.secret`;
- `deploy/secrets/push-config-encryption.secret`.

The script also generates `VPS_ID`, `POSTGRES_PASSWORD`, and
`MOBILE_CALL_ACTION_SECRET` in `deploy/.env` when empty, and defaults
`TURN_REALM` to `TURN_PUBLIC_HOST`. The call-action secret signs short-lived
native incoming-call actions and bootstrap tokens. Existing values, secrets,
and ICE configuration are preserved. Keep `deploy/.env` and the secret files
when updating this installation.

The initializer sets `turn-local.secret` to mode `640`, preserves its owner and
group, and writes the numeric group to `TURN_SECRET_GID` in `deploy/.env`.
Compose gives coturn this supplementary group while retaining the image's
non-root user. Other secrets remain private to their owner. Run initialization
with the account that owns the deployment files (root if originally installed
as root). Re-running it repairs permissions without replacing credentials.
`TURN_LOCAL_SECRET_FILE`, if set, selects the coturn secret whose permissions
are repaired; relative paths are resolved from the repository root. A custom
secret must also match the cluster secret configured for the ICE service.

## Host ports

Check for existing listeners before starting Compose:

```bash
sudo ss -lntup | grep -E ':(80|443|3000|3090|3478)([^0-9]|$)' || true
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

The API and ICE Config Service bind only to host loopback, using `PORT=3000`
and `ICE_CONFIG_HOST_PORT=3090` by default. Change those values in
`deploy/.env` if occupied. For example, set `PORT=3100` and point Nginx at
`127.0.0.1:3100`. The container's API port remains `3000`. PostgreSQL has no host port.
Ports 80 and 443 may already belong to an existing reverse proxy; add a site
for the Circle domain there.

Coturn uses TCP and UDP port `TURN_LISTEN_PORT=3478` by default. Choose a
different free port in `deploy/.env` **before** running `init-local-turn.sh`.
The generated ICE URLs include this port; clients use those URLs without a
separate client setting. After initialization, changing the port also requires
updating both TURN URLs in `deploy/ice/turn-clusters.json`. Open the chosen
TCP/UDP port and relay UDP range in the firewall. The local TURN profile does
not configure TURN/TLS.

The installation command in the root README starts PostgreSQL, the API,
ICE Config Service, and local coturn.

## Firewall configuration

Allow these inbound ports on **both the host firewall and the hosting provider's
firewall/security group**:

| Setting | Default | Protocol |
| --- | --- | --- |
| HTTPS setup | 80, 443 | TCP |
| `TURN_LISTEN_PORT` | 3478 | TCP and UDP |
| `TURN_RELAY_MIN_PORT`–`TURN_RELAY_MAX_PORT` | 49160–49200 | UDP |

For an already active UFW and default TURN ports:

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49160:49200/udp
sudo ufw status verbose
```

If you changed the ports, replace the values in the commands above with those
from `deploy/.env`. The initializer does not modify firewall rules.
If UFW is inactive, check the firewall actually used by your host. Preserve
existing SSH/HTTPS access. Provider firewall rules must be configured separately.
Coturn uses `network_mode: host`, so there is no Docker port-publication rule
that opens these ports for you. The Nginx HTTPS setup does not open TURN ports.

## TURN verification and troubleshooting

Verify in this order:

```bash
docker compose --env-file deploy/.env --profile local-turn ps -a
docker compose --env-file deploy/.env --profile local-turn logs --tail=100 coturn ice-config-service
sudo ss -lntup | grep ':3478'
```

Replace `3478` if configured differently. Coturn should listen on a public
interface over both TCP and UDP. `TURN_PUBLIC_HOST` and the URLs in
`deploy/ice/turn-clusters.json` must resolve to the correct server. Behind 1:1
NAT, configure `TURN_EXTERNAL_IP`. Initialization preserves existing ICE JSON:
changing the hostname or port in `.env` alone does not update those URLs.

Check secret loading without displaying it:

```bash
docker compose --env-file deploy/.env --profile local-turn exec -T coturn sh -c '
  test -r /run/secrets/turn_local &&
  grep -q "^static-auth-secret=." /tmp/turnserver.conf &&
  echo "TURN secret: OK"
'
```

Container health checks local STUN liveness and secret/config availability.
`node deploy/smoke-test-ice.mjs` checks only credential issuance. Neither checks
authenticated TURN relaying or public reachability.

Once the containers are running, run this command from the repository root
(requires Node.js 24+ on the VPS):

```bash
node deploy/smoke-test-turn.mjs
```

This reads `deploy/.env`, requests temporary credentials from the ICE API and
uses `turnutils_uclient` inside coturn to authenticate and exchange packets for
every returned TURN URL (UDP and TCP in the standard setup). It fails on
errors, timeouts, missing statistics or lost packets. It does not print the
credentials. `CIRCLUS_ENV_FILE` selects another env file; use the original
`COMPOSE_PROJECT_NAME` if the installation uses a custom project name.

A successful local test does not verify the host/provider firewall from outside.
To test from another network, first export **temporary** credentials on the VPS:

```bash
node deploy/smoke-test-turn.mjs --write-credentials /tmp/circlus-turn-check.json
```

The file is created with mode `600`, is never overwritten, and contains only
expiring client credentials and TURN addresses, not the shared server secret.
Copy it privately to a separate Linux machine with this repository, Node.js 24+
and `turnutils_uclient` (from the `coturn` package). On that external machine:

```bash
TURN_SMOKE_CLIENT=turnutils_uclient node deploy/smoke-test-turn.mjs \
  --credentials /tmp/circlus-turn-check.json
```

The printed expiration time limits how long the file works. Remove the temporary
file on both machines afterwards. Never copy `deploy/secrets/` for this test.
This test exercises two relay allocations on the same TURN server; it does not
exhaustively test reachability of relay ports from every possible peer/network.

To check a call through the relay, enable **Always TURN** in the web client. This forces
call media through the TURN relay instead of a direct connection. Make a new
call between devices on different networks, check for `relay` candidates and
audio in both directions, then restore your preferred setting.

| Symptom | Next check |
| --- | --- |
| `Permission denied` reading `turn_local` | Run the initializer and recreate coturn as described below. |
| `healthy`, but no relay candidates | Check public TCP/UDP access and run the authenticated test. |
| Listener exists, external requests time out | Check host and provider firewalls, DNS and NAT. |
| Authentication never succeeds | Check that ICE and coturn use the same secret, that credentials have not expired, and the server clock. An initial TURN 401 challenge alone is normal. |
| Allocation succeeds, but packets/audio do not flow | Check relay UDP range, advertised relay address/NAT and the other peer. |

If needed, run `sudo timeout 30 tcpdump -ni any 'port 3478'` during a fresh
external attempt. No arriving packets points to the client/network path before
the host capture; arriving requests require examining the replies and firewall
rules. Do not publish `.env`, secret files or temporary credentials in reports.

## Upgrading an existing TURN installation

After obtaining the updated code, run from the installation directory:

```bash
./deploy/init-local-turn.sh
docker compose --env-file deploy/.env --profile local-turn up -d --force-recreate coturn
```

Use the original installation account and Compose project name. The initializer
preserves the secret and ICE configuration, repairs its permissions, and records
its group for Compose. Recreating coturn applies the supplementary group;
`docker compose restart` alone cannot apply it. No manual `chmod 644`, secret
rotation or root coturn process is required. The new startup script refuses to
run if the secret cannot be read or is empty.

Apply the firewall rules above as well: fixing secret permissions does not open
ports. Repeat the authenticated test and an external Always TURN call. Existing
calls using this coturn instance can be interrupted during recreation.

## Deployment regression tests

With Linux, Docker Compose, Python 3, Node.js 24+ and OpenSSL installed:

```bash
python3 deploy/test-local-turn.py
```

The test uses a temporary installation and separate Compose project. It covers
initialization/reinitialization, ordinary-user and root-created secrets,
startup rejection for unreadable/empty secrets, UDP/TCP relay exchanges with
ICE-issued credentials, and rejection of invalid credentials or incomplete
packet exchanges. The public export CI runs this test. It does not modify the
production deployment or firewall and does not replace external reachability
testing.

## HTTPS with Nginx and Certbot

This is the supported beginner path for an Ubuntu or Debian VPS. It assumes
that the chosen domain already has an `A` record pointing to the VPS and that
TCP ports 80 and 443 are allowed by the hosting firewall. The same domain may
also be `TURN_PUBLIC_HOST`; HTTPS uses ports 80/443 while local TURN uses 3478.

Install Nginx, Certbot, and its Nginx plugin:

```bash
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx
```

`deploy/add-nginx-site.sh` performs the whole sequence below for one domain.
Run it from the repository root:

```bash
sudo ./deploy/add-nginx-site.sh circle.example.com
```

The proxy target port comes from `PORT` in `deploy/.env`, or `3000` when that
file does not set it. Pass a different port as a second argument. Set
`CERTBOT_EMAIL` to run Certbot without prompts.

The script writes `/etc/nginx/sites-available/circle.example.com`, enables it,
and checks the public HTTP readiness route before requesting the certificate,
so a wrong DNS record or a conflicting site cannot consume Let's Encrypt rate
limits. Certbot then installs the certificate and the HTTPS redirect. The
script refuses to overwrite a site file it did not create, so an existing
hand-written or Certbot-extended configuration is never replaced.

Return to the [root README](../README.md) to create the first Circle when
the script reports success. If you already manage Nginx on this VPS, use
`deploy/nginx/circlus-server.conf.example` as a reference for the proxy
settings and TLS. Preserve the original `Host` header and WebSocket upgrades.

## Adding Another Circle Domain

A server that already hosts a Circle needs no second installation, no second
container, and no claim token for a further Circle. One server process serves
every Circle and resolves each one from the public `Host` header, so a new
domain only needs DNS, an Nginx site, and a certificate.

1. Point the new domain at the VPS with an `A` record and wait for it to
   resolve.
2. Give it HTTPS with the same setup script:

   ```bash
   sudo ./deploy/add-nginx-site.sh second-circle.example.com
   ```
3. Check that `https://second-circle.example.com/ready` returns
   `"status":"ok"`. This endpoint answers before any Circle exists for the
   domain, so it confirms Nginx routing on its own.
4. In an official Circlus client, open **Settings → Server Management** with an
   identity that already has server-admin access on this server, and create the
   Circle for the new domain.

Both domains keep serving their own Circles. The new domain does not need its
own `TURN_PUBLIC_HOST`; Circles on the same server share the configured TURN
deployment.

## Updating

Before pulling new code, complete a [backup](#backups). Then run from
the repository root:

```bash
git pull --ff-only
./deploy/init-local-turn.sh
docker compose --env-file deploy/.env --profile local-turn up -d --build
```

Use the same Compose project name as the original installation. The initializer
preserves existing values and creates any newly required secret files. The
`migrate` service applies pending migrations before the API starts.

## Backups

At minimum, back up:

- PostgreSQL data;
- `deploy/.env`, `deploy/ice/turn-clusters.json`, and `deploy/secrets/`,
  including `push-config-encryption.secret` needed to decrypt managed push
  credentials;
- the Docker `server_data` volume, which contains encrypted attachments, public
  site assets, generated sites, and local Circle migration packages;
- reverse proxy configuration;
- any custom filesystem storage directories configured outside `server_data`.

### Database backup before an update

For a small Docker Compose deployment, a logical PostgreSQL backup is usually
the easiest portable format. Run this from the repository root:

```bash
mkdir -p backups
BACKUP_FILE="backups/circlus-db-$(date +%Y%m%d-%H%M%S).dump"
docker compose --env-file deploy/.env exec -T postgres \
  pg_dump -U fm_user -d family_messenger -Fc > "$BACKUP_FILE"
docker compose --env-file deploy/.env exec -T postgres \
  pg_restore --list < "$BACKUP_FILE" > /dev/null && \
  echo "Database backup saved to $BACKUP_FILE"
```

This creates a compressed PostgreSQL custom-format dump. The output redirection
is handled by the VPS shell, so the dump is written to the host's `backups/`
directory, not inside the PostgreSQL container. Removing or recreating that
container therefore does not remove the dump. The `-T` option disables the
Compose pseudo-terminal and keeps the binary dump stream intact. Do not
continue with an update unless the final success message appears. Store another
copy outside the VPS and do not place backups in Git.

The database dump does not contain attachment payload files. Back up the
`server_data` volume separately, or use your VPS/provider volume snapshot
facility. Database and filesystem backups should be taken as one maintenance
operation so their metadata remains consistent.

Do not publish backups. They may contain encrypted user data, metadata,
invites, device records, and server-admin records.

## Emergency deletion after complete identity loss

If every device holding a Circle owner identity has been lost, SSH access can
delete that Circle without resetting the other Circles or the whole database.
List all Circles and their current domains, identifiers, status, member and
guest counts, total identities, and active device counts:

```bash
docker compose --env-file deploy/.env --profile local-turn exec server \
  npm run tenant:list:prod
```

Use `npm run tenant:list:prod -- --json` inside the container when
machine-readable output is preferable. The next command only inspects the
selected target:

```bash
docker compose --env-file deploy/.env --profile local-turn exec server \
  npm run tenant:delete:prod -- --host=circle.example.com
```

Copy the reported `Family ID` (the database name for the Circle ID), then
repeat the command with explicit confirmation. If multiple Circles share the host, the inspection command also requires
`--family-id=THE_SELECTED_FAMILY_ID` and refuses to choose one automatically:

```bash
docker compose --env-file deploy/.env --profile local-turn exec server \
  npm run tenant:delete:prod -- --host=circle.example.com \
  --family-id=THE_FAMILY_ID_FROM_THE_FIRST_COMMAND \
  --confirm-family-id=THE_FAMILY_ID_FROM_THE_FIRST_COMMAND
```

Deletion is irreversible and removes all server-side data for that Circle,
including any server-admin grant carried by one of its identities. Other
Circles remain intact. Reusing the domain creates a new Circle with new
identifiers, keys, and membership history.
