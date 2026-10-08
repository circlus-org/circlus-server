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
- `deploy/secrets/push-config-encryption.secret`;
- `deploy/secrets/circle-migration.secret`.

The script also generates `VPS_ID`, `POSTGRES_PASSWORD`, and
`MOBILE_CALL_ACTION_SECRET` in `deploy/.env` when empty, and defaults
`TURN_REALM` to `TURN_PUBLIC_HOST`. The call-action secret signs short-lived
native incoming-call actions and bootstrap tokens. Existing values, secrets,
and ICE configuration are preserved. Keep `deploy/.env` and the secret files
when updating this installation.

The initializer sets `turn-local.secret` and the four server secret files to
mode `640`, preserves their owners and groups, and records the numeric groups
in `deploy/.env`. The four server secrets must share one host group. Compose
grants the matching supplementary groups to the non-root coturn and server
processes. Run initialization with the account that owns the deployment files
(root if originally installed as root). Re-running it repairs permissions
without replacing credentials.
`TURN_LOCAL_SECRET_FILE`, if set, selects the coturn secret whose permissions
are repaired; relative paths are resolved from the repository root. A custom
secret must also match the cluster secret configured for the ICE service.

## Host ports

Check for existing listeners before starting Compose:

```bash
sudo ss -lntup | grep -E ':(80|443|3000|3090|3478)([^0-9]|$)' || true
sudo docker ps --format 'table {{.Names}}\t{{.Ports}}'
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
For Oracle Cloud Ubuntu, see the [OCI installation guide](ORACLE_CLOUD.md)
for Security List or Network Security Group rules and host `iptables` rules.

## TURN verification and troubleshooting

Verify in this order:

```bash
sudo ./deploy/compose.sh ps -a
sudo ./deploy/compose.sh logs --tail=100 coturn ice-config-service
sudo ss -lntup | grep ':3478'
```

Replace `3478` if configured differently. Coturn should listen on a host
interface over both TCP and UDP; behind NAT this may be a private address.
`TURN_PUBLIC_HOST` and the URLs in
`deploy/ice/turn-clusters.json` must resolve to the correct server. Behind 1:1
NAT, configure `TURN_EXTERNAL_IP`. Initialization preserves existing ICE JSON:
changing the hostname or port in `.env` alone does not update those URLs.

Check secret loading without displaying it:

```bash
sudo ./deploy/compose.sh exec -T coturn sh -c '
  test -r /run/secrets/turn_local &&
  grep -q "^static-auth-secret=." /tmp/turnserver.conf &&
  echo "TURN secret: OK"
'
```

Container health checks local STUN liveness and secret/config availability.
`node deploy/smoke-test-ice.mjs` checks only credential issuance. Neither checks
authenticated TURN relaying or public reachability.

Once the containers are running, run this command from the repository root
if Node.js 24+ is installed system-wide:

```bash
sudo node deploy/smoke-test-turn.mjs
```

The test runs `docker compose` internally, so it needs Docker socket access.
If your account can already run Docker without `sudo`, use `node` instead.
Node.js is not required for normal prebuilt-image installation.

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

### Verify a call through TURN

A successful call can use a direct connection. To confirm that the local TURN
relay works from outside the VPS:

1. On a computer, in the web client, open **Settings → About → Technical
   information → Connection diagnostics** and turn on **Always TURN** and
   **WebRTC debug**.
2. Start a new call with someone on a different network, for example a phone on
   mobile data. The phone does not need these settings.
3. On the computer, check the **WebRTC Debug** panel: the selected local
   candidate should be `relay`, `pc` should be `connected`, and `ice` should
   be `connected` or `completed`. Check audio and video in both directions.
4. Turn both settings off again afterwards.

The panel is hidden in the compact mobile browser layout and is not part of
the Android app's native call screen. Use the computer's panel for this check;
the phone can be the other participant.

### If relay still fails

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
sudo ./deploy/compose.sh up -d --force-recreate coturn
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
python3 deploy/test-compose-wrapper.py
python3 deploy/test-local-turn.py
```

`test-compose-wrapper.py` uses a stub `docker` command and checks which Compose
files `deploy/compose.sh` selects and its release tag check.

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

Before updating, complete a [backup](#backups). For installations using
published images, follow [the main README](../README.md#updating). For
installations built from source (empty `CIRCLUS_IMAGE_TAG`), run from the
repository root. If the installation checked out a release, fetch and switch
to the new release tag; `git pull` works only when installed from a branch:

```bash
git fetch --tags
git switch --detach NEW_TAG
./deploy/init-local-turn.sh
sudo ./deploy/compose.sh up -d --build
```

Compose fixes the project name as `circlus-server`, so it retains the named
volumes across tag changes. The initializer preserves existing values and
creates any newly required secret files. The `migrate` service applies pending
migrations before the API starts.

## Backups

Use the helper below for the **standard Compose installation** in this
repository. It saves PostgreSQL, the `server_data` volume, `deploy/.env`, the
ICE configuration, and all five files in `deploy/secrets/` together. It checks
the actual Compose project, mounts, secrets, and storage settings before it
stops a service or changes data. If an installation uses another project name,
custom storage directories, bind mounts, or moved secret/config files, it
stops with an error; arrange backups for that layout separately. The helper
does not save Nginx configuration, TLS certificates, external TURN services, or
anything outside this Compose installation.

### Create and verify a backup

From the repository root, run:

```bash
sudo python3 deploy/backup.py create
```

The command stops the API for the duration of the database and file
backup, then starts it again. Calls and API requests may be interrupted. PostgreSQL stays running. It prints a directory
such as `backups/circlus-20261007-120000`. The backup contains secrets and is
readable only by root. Check the exact directory printed by the command:

```bash
sudo python3 deploy/backup.py verify backups/circlus-20261007-120000
```

Replace the example name with your backup directory. Keep the **whole**
directory together and copy it to storage outside the VPS. The check verifies
file hashes and archive structure. It is not a substitute for a trial restore
on another installation. Do not publish backups or add them to Git.

### Restore to an empty installation

Install Docker and check out the **code commit printed by `verify`**. Put the
selected backup directory on this VPS. The target Compose data volumes must
not exist. The helper pulls the PostgreSQL image if it is missing, after its
read-only checks pass. The restore command checks the backup, code commit,
Compose paths, and absence of target volumes
**before** it copies settings or creates volumes:

```bash
sudo python3 deploy/backup.py verify /path/to/selected-backup
git switch --detach SOURCE_COMMIT
sudo python3 deploy/backup.py restore /path/to/selected-backup
sudo ./deploy/compose.sh up -d
sudo ./deploy/compose.sh ps -a
```

Replace `/path/to/selected-backup` in both commands with the same absolute
path, and `SOURCE_COMMIT` with the commit printed by `verify`. The restore copies the backed-up settings and secrets, fills new volumes,
and restores PostgreSQL. It leaves the API stopped until the `up -d` command.
If restoration fails after it begins, it attempts to remove only the partial
new target volumes; the selected backup remains unchanged. Read any cleanup
error before retrying. Restore an older backup with the code version recorded
in that backup; switching to a newer release can run database migrations.

### Replace data on an existing VPS

First create a **new rescue backup of the current state** with
`create --leave-stopped` and copy it off the VPS. The API stays stopped so no
new writes can occur before the old data is cleared. This is distinct from
the **source backup** you intend to restore. Write down the two full paths; the script never picks a backup by date.
Verify both, then switch the checkout to the source backup's recorded code
commit. The `clear` command checks both backups and the existing Docker volumes,
asks you to type `DELETE circlus-server`, and only then removes the current
Compose containers and data volumes. It does not remove either backup directory.

```bash
sudo python3 deploy/backup.py create --leave-stopped
sudo python3 deploy/backup.py verify /path/to/source-backup
sudo python3 deploy/backup.py verify /path/to/rescue-backup
git switch --detach SOURCE_COMMIT
sudo python3 deploy/backup.py clear /path/to/source-backup /path/to/rescue-backup
sudo python3 deploy/backup.py restore /path/to/source-backup
sudo ./deploy/compose.sh up -d
sudo ./deploy/compose.sh ps -a
```

Replace `SOURCE_COMMIT` with the source backup's printed commit. The source
and rescue backups must have the same `VPS_ID` as the installation.
If the server is already stopped, `clear` can still check and remove its
standard volumes. To create a rescue backup, PostgreSQL must be running and
its container must exist. If `clear` or `restore` fails, keep the server
stopped and read the error before retrying; the backup directories are never
removed by these commands. Use the rescue path as the source if you decide to
return to the state just before clearing. If you cancel the replacement after
creating the rescue backup, restart the API with:

```bash
sudo ./deploy/compose.sh start server
```

### Older releases and other installation layouts

Prebuilt images do not change what needs to be backed up. The helper works
with source-built and prebuilt images when the **checked-out code contains this
helper** and the running installation passes its layout checks. An older
checkout may have the same data volumes but lack the helper or use different
Compose settings. Do not copy `backup.py` from a newer release into it and
assume that it supports that release.

For a different layout, first inspect the Compose configuration and the
running containers' mounts using the **same Compose files, environment file,
project name, and profiles used to start the server**. Identify the actual
PostgreSQL data volume, every server file-storage volume or bind mount, and
the active environment, ICE configuration, and secret files. Stop services
that can write to the database or file storage while making a consistent
backup. Save a PostgreSQL custom-format dump, archive every file-storage
location with ownership and permissions preserved, and copy the active
configuration and secrets. Save reverse-proxy settings and TLS material
separately if needed. Verify the dump and archives, keep a copy outside the
VPS, and test restoration on a separate installation.

The `clear` and `restore` commands above apply only to the checked standard
layout. For another layout, prepare a restore procedure from its inspected
mounts and paths before removing any existing data; there is no safe universal
volume name or directory to substitute into those commands.

## Emergency deletion after complete identity loss

If every device holding a Circle owner identity has been lost, SSH access can
delete that Circle without resetting the other Circles or the whole database.
List all Circles and their current domains, identifiers, status, member and
guest counts, total identities, and active device counts:

```bash
sudo ./deploy/compose.sh exec server \
  npm run tenant:list:prod
```

Use `npm run tenant:list:prod -- --json` inside the container when
machine-readable output is preferable. The next command only inspects the
selected target:

```bash
sudo ./deploy/compose.sh exec server \
  npm run tenant:delete:prod -- --host=circle.example.com
```

Copy the reported `Family ID` (the database name for the Circle ID), then
repeat the command with explicit confirmation. If multiple Circles share the host, the inspection command also requires
`--family-id=THE_SELECTED_FAMILY_ID` and refuses to choose one automatically:

```bash
sudo ./deploy/compose.sh exec server \
  npm run tenant:delete:prod -- --host=circle.example.com \
  --family-id=THE_FAMILY_ID_FROM_THE_FIRST_COMMAND \
  --confirm-family-id=THE_FAMILY_ID_FROM_THE_FIRST_COMMAND
```

Deletion is irreversible and removes all server-side data for that Circle,
including any server-admin grant carried by one of its identities. Other
Circles remain intact. Reusing the domain creates a new Circle with new
identifiers, keys, and membership history.
