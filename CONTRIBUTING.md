# Contributing

Thanks for helping improve Circlus Server.

Circlus is currently primarily maintained by its original author.

Contributions are welcome, especially bug reports, installation fixes,
documentation improvements, security reviews, and small focused pull requests.

Large architectural changes should be discussed in an issue before implementation.

## Development Setup

```bash
cd server
npm install
cp .env.minimal.example .env
# edit .env
```

For local development:

```bash
npm run dev
```

## Checks

Run these before sending a pull request:

```bash
cd server
npm run build
npm test -- --runInBand
npm run lint
```

CI also applies the public schema to PostgreSQL 16, starts the compiled server,
checks `/ready`, and builds the runtime container. New changes should keep this
smoke path working without demo data or private infrastructure.

## Database and PgTyped

SQL query files live in `server/src/db/repositories/*.sql`.

Generated PgTyped files are committed so users can build from a clean clone without a live database. If you change SQL or migrations, regenerate and commit the generated files:

```bash
cd server
npm run types:generate
npm run build
npm test -- --runInBand
```

## Migrations

Database migrations live in `server/db/migrations/`.

Guidelines:

- Add a new numbered migration instead of editing old migrations that may already be deployed.
- Public migrations start from the initial open-source baseline in `001_initial_schema.sql`; the first post-baseline migration should be `server/db/migrations/002_...`.
- Keep migrations idempotent where practical.
- Update docs when schema behavior changes.
- Regenerate PgTyped files when SQL query types change.

## Security-Sensitive Changes

Be careful with:

- authentication and signature verification;
- tenant/domain resolution;
- CORS and trusted origins;
- WebSocket routing;
- call signaling;
- push tokens and server-to-server secrets;
- file/attachment handling;
- link preview fetching and SSRF protections.

Add or update tests for changes in these areas.

Device-authenticated HTTP routes must have an explicit entry in
`server/src/middleware/signedRequestTypes.ts`: HTTP method and Express route
template map to the existing client-signed `type`. Unknown routes and mismatched
types are rejected. Give distinct operations distinct types; do not infer them
from URL spelling. When adding an operation, update the client and this table
together. The route coverage test detects missing and stale entries. WebSocket
registration modes and routes with dedicated authentication validate their types
in their own handlers. Resource authorization and checks relating path parameters
to signed payloads are still required independently.

## Pull Request Notes

Please include:

- what changed;
- how it was tested;
- any migration or deployment steps;
- any new environment variables.

Do not include real `.env` files, production logs, database dumps, private keys, or access tokens.

## PostgreSQL concurrency regressions

The replay regression suite requires a separate empty database whose name ends
with `_reliability_test`. Set `RELIABILITY_TEST_DATABASE_URL`, build the server,
then run `npm run test:reliability`. The script creates the schema and exercises
real transactions; never point it at a working database. Exported CI runs it
automatically. See [request reliability](docs/REQUEST_RELIABILITY.md).
