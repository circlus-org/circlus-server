# Server capabilities endpoint

This document describes the compatibility information a self-hosted Circlus
server provides to Circlus clients. The endpoint is:

```http
GET /api/config/capabilities
```

The endpoint is public but tenant-scoped: `limits`, `canonical`, and
`migration` describe the Circle selected from the request host and, when an
origin hosts more than one Circle, the `X-Circlus-Circle-ID` header.

## Purpose

Before displaying UI or calling a newer API, a client uses this response to
answer two independent questions:

1. Does the installed server code support this capability?
2. Has the server owner disabled the capability at runtime?

The build version (`serverVersion`) is diagnostic information only. Clients
must not use it instead of `apiLevel` when deciding whether a capability is
available.

## Response shape

The compatibility-relevant part of the response has this shape:

```json
{
  "status": "ok",
  "result": {
    "circleId": "circle-1",
    "vpsId": "vps-1",
    "capabilitiesVersion": 1,
    "protocols": {
      "signedRequestEnvelope": 2,
      "circleMembership": 1,
      "linkCapability": 1,
      "circleMigration": 1,
      "deviceEnrollment": 2
    },
    "apiLevel": 2,
    "serverVersion": "1.0.0",
    "enabled": {},
    "limits": {
      "messageTtlHours": 720,
      "attachmentsEnabled": true,
      "maxAttachmentFileSizeBytes": 52428800,
      "attachmentStorageQuotaBytes": null,
      "attachmentRetentionSeconds": null,
      "membersCanUseGuestServerAttachments": true
    }
  }
}
```

Clients must reject an unsupported `capabilitiesVersion` or any unsupported
signed protocol version. They may ignore unknown response fields and unknown
keys in `enabled`. Servers must not remove published fields or change their
meaning in an incompatible way without incrementing the relevant version.

Signed-request envelope version 2 binds `circleId` into the canonical signed
message. On shared origins the same value is sent as
`X-Circlus-Circle-ID`; WebSocket handshakes use the `circleId` query parameter.
The server rejects a selector that does not match the signed destination.

## `apiLevel`

`apiLevel` is a positive integer that identifies a cumulative level of the
public server API.

Rules:

- level `N` includes every capability from levels `1..N`;
- a published level must never be reused with a different meaning;
- later releases must not decrease the level;
- `apiLevel` is not SemVer, a build number, or a database schema version;
- a release without new client-visible capabilities keeps the existing level.

Increase the level when a newer client must distinguish a server that provides
a capability from a server that does not. Internal refactoring, database
migrations, bug fixes, and optional response fields with a safe fallback do not
by themselves require a new level.

## `enabled`

`enabled` is a sparse map of runtime overrides controlled by the server owner:

```json
{
  "enabled": {
    "attachments": false
  }
}
```

Each entry has the following meaning:

- missing key: there is no administrative override;
- `false`: a capability supported by the code is disabled;
- `true`: the capability is explicitly enabled, which is equivalent to a
  missing key;
- `true` cannot add a capability to a server whose `apiLevel` is too low.

Until the server exposes runtime feature switches to its owner, it returns
`"enabled": {}`.

Circle-owner settings must not be added to `enabled` automatically. They belong
to tenant policy or to the API of the corresponding feature. The server must
always enforce capability state and permissions when handling a request. A
client-side check exists for compatibility and user experience, not for
authorization.

## Client algorithm

For a feature that needs API level `N`, the client enables it only when:

```ts
capabilities.apiLevel >= N && capabilities.enabled?.[feature] !== false
```

An `enabled: true` override does not make an unsupported feature available.

If the endpoint is unavailable or the response does not contain a valid
`apiLevel`, the client must not use capabilities that require a capability
check. A capabilities error must never optimistically enable a feature.

## `limits`

`limits` contains effective tenant/Circle values that a client can use for
display or validation before a user action. A value in `limits` does not prove
that the corresponding feature is supported; `apiLevel` determines support.

The response includes effective values for messages, attachments, and guest
links. `null` means that the Circle has no configured limit; it does
not guarantee that the server has no transport or physical constraint.

Do not expose every internal implementation limit through capabilities. For
example, rate limiting is communicated through HTTP `429` and `retryAfterMs`.
Add a limit here or to a feature-specific policy endpoint only when a client can
apply it before a request, such as limiting the size of a file, message, group,
or other user input.

`attachmentsEnabled` and `membersCanUseGuestServerAttachments` are located
under `limits` although they are Circle policies. Permission to create guest
invitations is identity-scoped and therefore is deliberately not published as
a Circle-wide capability. New policy fields should be grouped separately or
returned by the corresponding feature API. They must not be added to `enabled`
without an explicit revision of this contract.

## Sources of truth in the published server code

- response type: `shared/types.ts`, `ServerCapabilitiesResponse`;
- server API level and response construction: `server/src/routes/config.ts`;
- server contract tests: `server/src/routes/config.test.ts`.
