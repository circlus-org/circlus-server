# Security Policy

## Supported Versions

Security fixes are currently applied to the latest public `main` branch.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately instead of opening a public issue.

Use one of these channels:

- GitHub Security Advisories for the public repository, if available.
- A private message to the maintainer through the GitHub profile listed in `package.json`.

Include:

- affected component and version or commit;
- reproduction steps;
- impact;
- any logs or traces with secrets removed.

## Deployment Security Checklist

Before running a public server:

- Replace every example secret in `.env`.
- Never commit or publish `.env`.
- Use HTTPS in front of the server.
- Preserve the original `Host` header in the reverse proxy.
- Set `TRUST_PROXY=1` only when the app is reachable through one trusted proxy.
- Do not enable `TENANCY_TRUST_FORWARDED_HOST` unless your proxy fully controls `X-Forwarded-Host`.
- Keep `CALL_SIGNALING_DIAGNOSTICS=false` and `CALL_ICE_DIAGNOSTICS=false` in normal production.
- Restrict SSH and database access at the VPS/firewall level.
- Keep PostgreSQL and Node.js patched.

## Diagnostic Logs

Call diagnostics can include stable identity IDs, device IDs, call session IDs, and ICE candidate addresses. These logs are useful for debugging but may be sensitive. Enable them only temporarily:

```env
CALL_SIGNALING_DIAGNOSTICS=true
CALL_ICE_DIAGNOSTICS=true
```

Disable them again after collecting the needed information.

## Client Origins

`https://web.circlus.org`, the official web client, may always call the API from
browsers. This origin is built in and no setting removes it.
`TRUSTED_CLIENT_ORIGINS` adds custom client origins globally; configure only web
clients you operate or trust. A Circle owner can also add origins for one Circle
through `extra_trusted_client_origins`.

A trusted origin is a browser-level allowance, not an authentication decision.
Signed identity operations require a device-key signature. Other endpoints use
their own controls: for example, Inspector request polling requires the request
token, and session reads require the approved session token. The server grants
access to neither endpoint on the strength of the origin alone.

## Secrets

Use unique random values for:

- `POSTGRES_PASSWORD`
- `PUSH_SERVICE_SHARED_SECRET`
- `ICE_CONFIG_SHARED_SECRET`
- `MOBILE_CALL_ACTION_SECRET`, if set

Example:

```bash
openssl rand -base64 32
```

## ICE/TURN Secrets

The main Circlus server should not store coturn `static-auth-secret` values.
Those belong in the ICE config service, which returns short-lived TURN
credentials to the main server after a signed server-to-server request.

`ICE_CONFIG_SERVER_ID` identifies the family server instance to the ICE config
service. It is not a circle id and should not be used as the future key for
per-circle TURN routing.
