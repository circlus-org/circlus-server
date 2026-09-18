# Circlus ICE Config Service

Small server-to-server broker that returns STUN/TURN configuration to Circlus
family servers.

The family server calls this service with HMAC authentication. The service
selects an allowed named TURN cluster from a local JSON config file, generates
short-lived coturn REST credentials (or returns configured static credentials),
and returns ordinary WebRTC `iceServers`.

## Direct local run

```bash
cp .env.example .env
cp config.example.json config.local.json
mkdir -p secrets
openssl rand -base64 32 > secrets/ice-s2s.secret
openssl rand -base64 32 > secrets/turn-local.secret
# edit config.local.json for authorized servers and TURN clusters
npm install
npm run build
npm start
```

`config.local.json` is intentionally ignored by git because it contains
deployment-specific topology. Secret values belong in separate files referenced
by `secretFile`, `credentialFile`, or `s2sSharedSecretFile`. Keep both the local
configuration and secret directory out of logs, tickets, and commits.

This file is read only on the host where the service is started:

- `npm start` reads `./config.local.json` when `ICE_CONFIG_PATH` is not set;
- `docker-compose.small-server.yml` bind-mounts the same host file as
  `/app/config/config.json` inside its `ice-config-service` container;
- the open-source deployment `compose.yaml` does not use it: that compose file mounts
  `${ICE_CONFIG_FILE:-./deploy/ice/turn-clusters.json}` instead.

Nothing in the client downloads or references the developer machine's
`config.local.json`. Other users are affected only if their Circlus server is
actually deployed from this exact host with `docker-compose.small-server.yml`.
If neither the direct local run nor that legacy compose file is used,
`config.local.json` may be deleted from this host.

Generate an S2S shared secret for each family server:

```bash
openssl rand -base64 32
```

Put that value in the file referenced by `s2sSharedSecretFile`. Put each
coturn `static-auth-secret` value in the file referenced by that cluster's
`auth.secretFile`.

The configuration must use `schemaVersion: 1`. TURN clusters must use the
nested `auth` object shown in `config.example.json`; the old cluster fields
`authMode: "rest"` and `staticAuthSecret` are rejected. Migrate and validate the
real configuration before deploying a service build that requires schema 1.

Authorized servers may still provide the S2S key as `s2sSharedSecret`, but
`s2sSharedSecretFile` is recommended so that secrets are not embedded in the
topology file.

Validate a deployment configuration with the same parser used at startup:

```bash
ICE_CONFIG_PATH=/absolute/path/to/config.json npm start
```

The process must reach the listening state without a configuration error. A
TypeScript build alone does not load or validate the runtime JSON file.

## Named TURN clusters

Each authorized server has a `defaultTurnClusterId` and an
`allowedTurnClusterIds` list. If a request omits `requestedTurnClusterId`, the
default is selected exactly as in the legacy contract. A requested cluster must
exist, be active, and be present in the caller's allowed list.

Cluster auth modes:

- `turn-rest-secret`: recommended; produces per-call time-limited credentials;
- `static-credentials`: compatibility option for external services that do not
  expose a REST shared secret. Static credentials are reusable and should be
  avoided where a short-lived option exists.

## Auth

Family servers sign requests with:

- `X-Ice-Server-Id`
- `X-Ice-Key-Id`
- `X-Ice-Timestamp`
- `X-Ice-Nonce`
- `X-Ice-Body-Sha256`
- `X-Ice-Signature`

The signature is HMAC-SHA256 over:

```text
METHOD
PATH
TIMESTAMP
NONCE
BODY_SHA256
```

## Endpoint

`POST /v1/ice-servers`

Request:

```json
{
  "vpsId": "prod-eu-1",
  "familyId": "family-uuid",
  "purpose": "call",
  "circleSubjectId": "cs1_abcdefghijklmnopqrstuv",
  "mediaSessionId": "ms1_abcdefghijklmnopqrstuv",
  "requestedTurnClusterId": "turn-eu-1"
}
```

## Logging

The service writes one JSON log line for every `/v1/ice-servers` request. Logs
include `serverId`, `keyId`, `vpsId`, `familyId`, opaque Circle/media subjects,
selected `turnClusterId`, HTTP status, and request duration.

Secrets, signatures, request bodies, TURN credentials, and shared keys are not
logged.

Response:

```json
{
  "iceServers": [
    { "urls": ["stun:stun.l.google.com:19302"] },
    {
      "urls": ["turn:turn-eu-1.example.com:3478?transport=udp"],
      "username": "1777597200:v1:prod-eu-1:prod-eu-1:cs1_abcdefghijklmnopqrstuv:ms1_abcdefghijklmnopqrstuv:turn-eu-1:k1",
      "credential": "...",
      "expiresAt": "2026-05-01T01:00:00.000Z"
    }
  ],
  "ttlSeconds": 3600,
  "expiresAt": "2026-05-01T01:00:00.000Z",
  "assignment": {
    "turnClusterId": "turn-eu-1",
    "mode": "fixed",
    "selectionSource": "requested",
    "circleSubjectId": "cs1_abcdefghijklmnopqrstuv",
    "mediaSessionId": "ms1_abcdefghijklmnopqrstuv"
  }
}
```

The family server derives both subject ids with a domain-separated HMAC. Raw
Circle and call identifiers are never placed in TURN usernames. Call requests
must include `mediaSessionId`; bootstrap requests only require
`circleSubjectId`.

`POST /v1/turn-clusters` uses the same S2S request signature and returns only
safe metadata for clusters allowed to the calling server. It never returns
TURN or S2S secrets.
