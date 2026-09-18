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
- A reverse proxy such as Nginx, Caddy, Apache, or a managed equivalent for production TLS

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

For Docker Compose, the app containers connect to the bundled PostgreSQL and
ICE Config Service using internal service names. The initialization script
creates local S2S/TURN secret files and an ICE cluster configuration without
putting secret values in versioned JSON.

The official client `https://web.circlus.org` is trusted automatically. To allow
an additional self-hosted client, configure it explicitly, for example:

```env
TRUSTED_CLIENT_ORIGINS=https://ru.circlus.org
```

This starts PostgreSQL, applies migrations once, starts the Node server and the
local ICE Config Service, and enables coturn through the `local-turn` profile.
Omit that profile when all configured TURN clusters are external. Managed push
credentials are still configured separately.

The bundled PostgreSQL configuration is intended for a small VPS. The default
values are a good starting point for a 2 GB RAM server with light traffic. On a
1 GB RAM server, reduce `shared_buffers` to `128MB` and `effective_cache_size`
to `512MB` in `server/config/postgresql-small-server.conf`.

After the containers are running:

1. Put the server behind HTTPS using a reverse proxy.
2. Check that `https://your-circle-domain.example.com/ready` returns `ok`.
3. Create a short-lived server-admin claim token.
4. Open an official Circlus web client and use Server Management to create the
   first Circle on this server.

See [First Circle Provisioning](#first-circle-provisioning) for the full flow.

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
- `PUSH_SERVICE_*`: server-to-server authentication for push delivery.
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

## Reverse Proxy Notes

The server resolves circles from the incoming `Host` header. Your reverse proxy must preserve the original host.

Caddy example:

```caddyfile
circle.example.com {
  reverse_proxy 127.0.0.1:3000 {
    header_up Host {host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
  }
}
```

Nginx example:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

The bundled Compose file binds the API port to `127.0.0.1` for a reverse proxy on the host. For a containerized proxy, connect it to the internal network and do not publish the API port to the internet.

Use `TRUST_PROXY=1` when the server is reachable only through that trusted proxy. Avoid trusting arbitrary forwarded headers from the public internet.

For a typical VPS, expose only SSH, HTTP, and HTTPS publicly. Do not expose
PostgreSQL to the public internet.

## Circles

After the server is running, create circles from the Server Management page
using a short-lived server-admin claim token. The server stores circle/domain
mappings in PostgreSQL and uses them to route API and WebSocket requests.

## First Circle Provisioning

The Docker or manual setup only starts the empty server. A Circle is created
afterward from a Circlus client.

1. Point the chosen first Circle domain at the VPS, configure HTTPS and a
   reverse proxy for it, and check that `/ready` works. This domain can also
   be `TURN_PUBLIC_HOST` when TURN uses port 3478.
2. From the repository root on a Docker Compose installation, create a
   one-time server-admin claim token:

   ```bash
   docker compose --env-file deploy/.env --profile local-turn exec server \
     npm run server-admin:create-claim:prod -- --ttl-hours=1
   ```

   For a manual installation, run
   `cd server && npm run server-admin:create-claim -- --ttl-hours=1` instead.

3. Open the official web client: `https://web.circlus.org`. With no existing
   profile, choose **Create a Circle on your own server** on the start screen.
   With an existing profile, open **Server Management** and select **Connect a
   new server**.

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

The public server repository starts from a single initial schema baseline in
`server/db/migrations/001_initial_schema.sql`. Future schema changes should be
added as new numbered migrations in the same directory, starting with `002_...`.
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
docker compose --env-file deploy/.env --profile local-turn up -d --build
```

Run these commands from the repository root. Omit `--profile local-turn` if
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
