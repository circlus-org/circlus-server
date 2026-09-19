# Circlus Server

Self-hosted Circlus server for private circles, messaging, and WebRTC calls.

This repository contains the server component used by Circlus clients. The main expected setup is:

- you run this server on your own VPS;
- you create your own circles on that server;
- users connect with the official Circlus web clients or mobile app;
- advanced users may later run custom clients by adding their origins to the server configuration.

For push delivery, the server integrates with the Circlus push service or
another compatible push relay. Push delivery itself is not bundled into this
server process.

The public repository intentionally includes both `server/` and `shared/`.
`shared/` contains TypeScript source types, small helpers, and protocol test
vectors used by the server build. Generated JavaScript, declarations, and source
maps are deliberately excluded so the repository remains source-only and does
not expose build-machine paths.

## Terminology

Circlus uses **Circle** for the user-facing private group/tenant concept. Some
internal database tables, column names, and code paths still use the older
`family` naming (`family_id`, `family_config`, `family_domains`). In those
places, `family` means a Circle/tenant, not the physical server or VPS. The
physical server is represented separately by `VPS_ID` and server-admin records.

## Requirements

- Docker and Docker Compose for the recommended setup
- Node.js 24 LTS, PostgreSQL 15+, and npm for manual setup or development
- Nginx and Certbot for the documented Ubuntu/Debian HTTPS setup

## Quick Start

```bash
cp deploy/.env.example deploy/.env
# Set TURN_PUBLIC_HOST to the public DNS name or IP used by clients.
./deploy/init-local-turn.sh
docker compose --env-file deploy/.env --profile local-turn up -d --build
```

Before starting, set the public address clients use for TURN in `deploy/.env`:

```env
TURN_PUBLIC_HOST=turn.example.com
```

The initialization script generates a stable random `VPS_ID` and PostgreSQL
password when those fields are empty. It uses `TURN_PUBLIC_HOST` as `TURN_REALM`
unless you set a separate realm. Existing values are kept on subsequent runs.
Keep `deploy/.env` and `deploy/secrets/` across updates and backups.

Before starting Compose, check for occupied host ports:

```bash
sudo ss -lntup | grep -E ':(80|443|3000|3090|3478)([^0-9]|$)' || true
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

The API uses host loopback port `3000` (`PORT` in `deploy/.env`); the ICE
Config Service uses loopback port `3090` (`ICE_CONFIG_HOST_PORT`). If port
`3000` is occupied, set `PORT=3100` (or another free port) before starting
Compose and point the reverse proxy to `127.0.0.1:3100`. The API still uses
port `3000` inside its container. `ICE_CONFIG_HOST_PORT` can likewise be
changed when occupied. PostgreSQL is not published on a host port. Existing listeners
on `80` and `443` may be your reverse proxy; configure a virtual host for the
Circle domain rather than starting a second proxy on those ports.

Local coturn uses TCP and UDP port `3478`. Set `TURN_LISTEN_PORT` in
`deploy/.env` **before** running `init-local-turn.sh` to use another free port.
The script writes that port into the ICE URLs served to clients, so clients
need no manual port setting. If you change the port after initialization,
update both `TURN_LISTEN_PORT` and the URLs in
`deploy/ice/turn-clusters.json`. Open the chosen TCP/UDP port and the
configured UDP relay range (`49160-49200` by default) in the firewall.
This local profile does not provide TURN/TLS on port 443.

For Docker Compose, the app containers connect to the bundled PostgreSQL and
ICE Config Service using internal service names. The initialization script
creates local S2S/TURN secret files and an ICE cluster configuration without
putting secret values in versioned JSON.

The official client `https://web.circlus.org` is trusted automatically. To allow
an additional self-hosted client, configure it explicitly, for example:

```env
TRUSTED_CLIENT_ORIGINS=https://client.example.com
```

This starts PostgreSQL, applies migrations once, starts the Node server and the
local ICE Config Service, and enables coturn through the `local-turn` profile.
Omit that profile when all configured TURN clusters are external. After the
first Circle exists, its server administrator can request the standard Circlus
push connection from **Settings → Server Management**. The approval service
installs and verifies the credentials directly; the VPS owner does not copy a
secret into `.env`.

The bundled PostgreSQL configuration is intended for a small VPS. The default
values are a good starting point for a 2 GB RAM server with light traffic. On a
1 GB RAM server, reduce `shared_buffers` to `128MB` and `effective_cache_size`
to `512MB` in `server/config/postgresql-small-server.conf`.

After the containers are running:

1. Follow [HTTPS with Nginx and Certbot](#https-with-nginx-and-certbot).
2. Check that `https://your-circle-domain.example.com/ready` returns `ok`.
3. Create a short-lived server-admin claim token.
4. Open an official Circlus web client and create the first Circle from its
   start screen, or from Server Management if you already have a profile.

See [First Circle Provisioning](#first-circle-provisioning) for the full flow.

### Connect push notifications

Complete this after the first Circle and server administrator access exist:

1. In the official client, open **Settings → Server Management** and select
   this server.
2. In **Push notifications**, select **Create connection request**. The code is
   valid for 24 hours and can be used only for this server.
3. Select **Open support contact**. If this is your first visit, complete the
   guest registration. The generated request is already placed in the visible
   message field; review it and send it.
4. Wait for approval in the same Circlus conversation. The maintainer can ask
   questions there. On approval, the provisioning service registers the server,
   sends the credentials directly to it, and verifies authentication.
5. Return to Server Management and refresh the push status. It should show
   **Connected and ready**.

The conversation contains only a short-lived installation claim. The permanent
push secret is generated after approval and is never sent through chat. The
server encrypts that secret with `deploy/secrets/push-config-encryption.secret`;
back up this file together with the database and the other files in
`deploy/secrets/`.

## Manual Setup

For a non-Docker deployment:

```bash
cd server
npm install
cp .env.minimal.example .env
# edit .env
./init-db.sh
npm run build
npm start
```

`./init-db.sh` is only for a fresh local installation: it invokes the explicitly
destructive `reset-local-database.sh`, which drops and recreates the configured
database after confirmation. Never use it to update an existing installation;
use `npm run migrate` for updates.

For development:

```bash
npm run dev
```

## Configuration

Use `.env.minimal.example` for first deployment and `.env.example` as the complete reference.

Important settings:

- `DATABASE_URL`: PostgreSQL connection string.
- `VPS_ID`: stable identifier for this physical server.
- `TRUST_PROXY=1`: recommended when running behind one trusted reverse proxy.
- `TRUSTED_CLIENT_ORIGINS`: additional custom web client origins allowed by CORS;
  `https://web.circlus.org` is always trusted.
- `PUSH_SERVICE_*`: optional legacy server-to-server authentication for push
  delivery. A managed configuration installed from Server Management is stored
  encrypted in PostgreSQL and takes precedence. Environment variables remain a
  compatibility fallback only while no managed configuration row exists.
- `ICE_CONFIG_*`: server-to-server authentication for TURN/ICE configuration.
- `CALL_SIGNALING_DIAGNOSTICS=false`: keep disabled in production unless debugging calls.
- `CALL_ICE_DIAGNOSTICS=false`: keep disabled in production unless debugging WebRTC connectivity.

### Logging and request correlation

Production logs use one JSON object per line by default. Set `LOG_LEVEL` to
`debug`, `info`, `warn`, `error`, or `silent`; set `LOG_FORMAT=pretty` only for
interactive local development. Operator-facing commands under `src/scripts`
retain human-readable terminal output.

Every HTTP response includes `X-Request-ID`. A caller may supply that header
when it contains only safe identifier characters and is at most 128 characters;
otherwise the server generates a UUID. Logs produced while handling that HTTP
request include the request id and, after tenant resolution, the internal Circle id.
The server does not intentionally log request bodies, authorization headers,
push payloads, delivery tokens, subscription endpoints, or encryption keys.

## ICE/TURN Configuration

Circlus uses a separate ICE config service to issue WebRTC `iceServers`. The
main server does not store coturn secrets directly. Instead, it calls the ICE
config service from `GET /api/config/ice-servers` and
`POST /api/config/turn-credentials`. The public repository includes a local
deployment of that service and an optional local coturn profile. It can also be
configured with external TURN clusters.

The main server requires:

```env
ICE_CONFIG_SERVICE_URL=https://ice.example.com
ICE_CONFIG_KEY_ID=k1
ICE_CONFIG_SHARED_SECRET=base64-random-secret
# Alternative for Docker secrets:
# ICE_CONFIG_SHARED_SECRET_FILE=/run/secrets/ice_s2s
```

`ICE_CONFIG_SERVER_ID` is optional and defaults to `VPS_ID`. It identifies this
server instance to the ICE config service; it is not a circle id and not a
user/client id.

Leave `ICE_CONFIG_*` empty while managed TURN access is pending. Messaging,
circles, identities, and direct peer-to-peer calls can still work, but TURN
credentials cannot be issued and calls may fail on restrictive networks.

See `deploy/README.md` for running only ICE Config Service and coturn next to an
existing PM2-managed Circlus Server.

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

Create the HTTP site before asking Certbot for a certificate:

```bash
sudo cp deploy/nginx/circlus-server.conf.example \
  /etc/nginx/sites-available/circlus-server
sudo nano /etc/nginx/sites-available/circlus-server
```

Replace `circle.example.com` with the Circle domain. If `PORT` in
`deploy/.env` is not `3000`, replace `127.0.0.1:3000` with the selected port.
Then enable and reload the site:

```bash
sudo ln -sfn /etc/nginx/sites-available/circlus-server \
  /etc/nginx/sites-enabled/circlus-server
sudo nginx -t
sudo systemctl reload nginx
```

Give Nginx time to replace its workers, then verify the public HTTP route in a
separate step:

```bash
sleep 2
curl --fail --show-error http://circle.example.com/ready
```

Continue only when this returns JSON with `"status":"ok"`. A 404 usually
means that Nginx is still serving another/default site or that `server_name`
does not exactly match the domain. A connection failure usually means that
DNS, port 80, or a hosting firewall is not ready.

Now request the certificate and let Certbot add HTTPS and the HTTP redirect:

```bash
sudo certbot --nginx --redirect -d circle.example.com
```

Enter an email address and accept the Let's Encrypt terms when prompted. Then
verify HTTPS and automatic renewal:

```bash
sleep 2
curl --fail --show-error https://circle.example.com/ready
sudo certbot renew --cert-name circle.example.com --dry-run
```

Both readiness requests must return JSON with `"status":"ok"`. Certbot's
Nginx flow requires the HTTP site to be publicly reachable on port 80 before
certificate issuance. `--cert-name` limits this installation check to the new
certificate; Certbot's scheduled renewal still handles every managed
certificate. See the official [Certbot instructions](https://certbot.eff.org/instructions).

The example preserves the original `Host`, overwrites forwarded client headers,
and supports WebSocket upgrades. Keep `TRUST_PROXY=1` when the API is reachable
only through this Nginx instance. The bundled Compose file exposes the API only
on host loopback. PostgreSQL is not published on a host port.

## Circles

After the server is running, create circles from the Server Management page
using a short-lived server-admin claim token. The server stores circle/domain
mappings in PostgreSQL and uses them to route API and WebSocket requests.

## First Circle Provisioning

The Docker or manual setup only starts the empty server. A Circle is created
afterward from a Circlus client.

1. Point the chosen first Circle domain at the VPS, complete
   [HTTPS with Nginx and Certbot](#https-with-nginx-and-certbot), and check that
   its HTTPS `/ready` endpoint works. This domain can also be
   `TURN_PUBLIC_HOST` when TURN uses port 3478.
2. From the repository root on a Docker Compose installation, create a
   one-time server-admin claim token:

   ```bash
   docker compose --env-file deploy/.env --profile local-turn exec \
     -e LOG_LEVEL=warn server \
     npm run server-admin:create-claim:prod -- --ttl-hours=1
   ```

   For a manual installation, run
   `cd server && npm run server-admin:create-claim -- --ttl-hours=1` instead.

3. Open either the official web client at `https://web.circlus.org` or the
   [Circlus Android app on Google Play](https://play.google.com/store/apps/details?id=org.circlus.client).
   While Google Play testing is closed, [ask the project maintainer](https://circlus.org/#contact)
   to add your Google account to the tester list before downloading the app.
   The listing is visible only to admitted tester accounts; the official APK is also available from
   [Circlus Android Releases](https://github.com/circlus-org/circlus-android-releases/releases).
   Both clients use the same first-Circle flow. With no existing profile,
   choose **Create a Circle on your own server** on the start screen. With an
   existing profile, open the **Settings** tab in the Circlus app, choose
   **Server Management**, open the **Server** drop-down list, and select
   **Connect a new server**.

   `https://web.circlus.org` is allowed by the server automatically. Before
   using another web client, add its exact origin to `deploy/.env` (multiple
   origins are comma-separated) and recreate the server container so it reads
   the updated environment:

   ```env
   TRUSTED_CLIENT_ORIGINS=https://client.example.com
   ```

   ```bash
   docker compose --env-file deploy/.env --profile local-turn up -d \
     --force-recreate server
   ```

4. Enter:

   - the HTTPS base URL of your server, for example `https://circle.example.com`;
   - the claim token from the command above.

5. Create the first Circle. The app registers an owner identity on that Circle;
   this identity also gains server administrator access. No Circle needs to
   exist before this step.

For additional Circles on the same server, use Server Management from an
identity that already has server-admin access. Do not create or share long-lived
host access secrets for routine Circle creation.

## Database Migrations

The public server repository starts from an initial schema baseline in
`server/db/migrations/001_initial_schema.sql`. Schema changes are added as
forward-only numbered migrations in the same directory.
Migrations are applied with `npm run migrate` and tracked in the database via
`schema_migrations`.

With Docker Compose, the `migrate` service runs before the server starts. For a
manual deployment, run migrations explicitly after updating code:

```bash
cd server
npm run migrate
```

The runtime exposes three unauthenticated probe endpoints:

- `/live` reports that the Node process is running and does not query external
  dependencies;
- `/ready` returns HTTP 200 only after startup is complete and PostgreSQL
  answers a probe query;
- `/health` is a backwards-compatible alias for `/ready`.

Readiness becomes unavailable before graceful shutdown starts, so a reverse
proxy or orchestrator can stop sending new work while existing HTTP requests,
WebSocket messages, and background jobs drain.

The current API runtime intentionally supports one active process per database.
Request nonces, rate limits, WebSocket presence, and signaling routes are held
in process memory, and startup enforces this constraint with a PostgreSQL
advisory lock. Scale TURN or a future SFU independently; do not add API replicas
until these process-local components have a shared coordination layer.

## Updating

Before updating a production server, make a database backup.

For Docker Compose deployments:

```bash
git pull
./deploy/init-local-turn.sh
docker compose --env-file deploy/.env --profile local-turn up -d --build
```

Run these commands from the repository root. The initialization command keeps
existing values and secrets and creates any secret file introduced by the new
version. Omit `--profile local-turn` from Compose if
your configured TURN clusters are external. Use the same Compose project name
as the original installation so its named data volumes remain attached. The
Compose setup runs migrations before starting the updated server process.

For manual deployments:

```bash
git pull
cd server
npm install
npm run build
npm run migrate
npm start
```

Use your process manager, such as `systemd` or `pm2`, to restart the production
process if you do not run `npm start` directly.

## API compatibility

Circlus clients may update sooner than self-hosted servers. The public
`GET /api/config/capabilities` endpoint exposes a cumulative `apiLevel`,
optional runtime feature overrides, and client-facing limits. Server forks and
custom clients must preserve the published level semantics instead of deriving
compatibility from the package version.

See the normative
[Server capabilities contract](docs/SERVER_CAPABILITIES.md) before
adding, removing, disabling, or changing a client-visible server capability.

## Backup and Restore

At minimum, back up:

- PostgreSQL data;
- `deploy/secrets/`, including `push-config-encryption.secret` needed to decrypt
  managed push credentials;
- the Docker `server_data` volume, which contains encrypted attachments, public
  site assets, generated sites, and local Circle migration packages;
- the server `.env`;
- reverse proxy configuration;
- any custom filesystem storage directories configured outside `server_data`.

For a small Docker Compose deployment, a logical PostgreSQL backup is usually
the easiest portable format:

```bash
docker compose exec postgres pg_dump -U fm_user -d family_messenger > circlus-backup.sql
```

The application image runs as the unprivileged `node` user. The bundled named
volume is created with a writable `/app/server/server-data` mount; custom bind
mounts must grant that user write access without making the whole container
privileged.

The database dump does not contain attachment payload files. Back up the
`server_data` volume separately, or use your VPS/provider volume snapshot
facility. Database and filesystem backups should be taken as one maintenance
operation so their metadata remains consistent.

To restore on a fresh server, recreate the same `.env` values, start PostgreSQL,
restore the dump, then start the Circlus server and run migrations if needed.
Keep `VPS_ID` stable for the same physical/logical server unless you
intentionally migrate to a new server identity.

Do not publish backups. They may contain encrypted user data, metadata,
invites, device records, and server-admin records.

## PgTyped

The generated `server/src/db/repositories/*.queries.ts` files are committed so a clean clone can build without a live PostgreSQL database.

After changing SQL query files or migrations, run:

```bash
cd server
npm run types:generate
npm run build
npm test -- --runInBand
```

Commit the updated generated files.

## Verification

Before deploying or opening a pull request:

```bash
cd server
npm run build
npm test -- --runInBand
npm run lint
```

## Troubleshooting

This section intentionally starts small. Please open an issue if you hit a setup
problem that is not covered here.

- Hosted web client cannot connect: check HTTPS, `TRUSTED_CLIENT_ORIGINS`, and
  browser console CORS errors.
- Circle/domain is not found: check that the reverse proxy preserves the
  original `Host` header and that the Circle was created for the domain you are
  using.
- Calls fail on some networks: leave `ICE_CONFIG_*` empty only while TURN access
  is pending; without TURN, restrictive NATs can prevent calls.
- Push notifications do not arrive: managed push credentials may be missing,
  pending approval, or `ENABLE_RELAY_DELIVERY` may still be `false`.
- Migrations fail: check `DATABASE_URL`, PostgreSQL reachability, and whether an
  old migration was edited after being applied.

## Repository Layout

```text
server/   Node.js/Express/WebSocket server
shared/   shared TypeScript types and helpers used by the server
```

## License

MIT

## Signed request protocol updates

The first public baseline `001_initial_schema.sql` requires the updated client for
operation IDs, versioned writes, bounded history clear and temporary-access ACK.
See [request reliability](docs/REQUEST_RELIABILITY.md) for rollout, retry semantics,
retention and the limits of database replay protection.

WebSocket connections have bounded incoming/outgoing queues, connection limits
and registration deadlines by default. See [WebSocket resource limits](docs/WEBSOCKET_LIMITS.md)
for configuration, overload behavior and capacity-testing requirements.
