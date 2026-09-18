# Signed request reliability

This protocol is included in the first public baseline `001_initial_schema.sql`.
Deploy the updated client and server together. Older clients lack required fields
on affected mutations and will receive a validation error; do not silently fall
back to unversioned writes.

## Authentication and retries

Every transport attempt needs a fresh timestamp, nonce and signature, with the
route's exact signed `type`. Verified nonces are atomically consumed in PostgreSQL
before the handler runs. They remain consumed if the business operation fails.
HTTP, standalone signed endpoints and WebSocket registrations share this durable
protection. Reconnect by signing a new WebSocket registration.

Nonce rows contain hashes and expire only after the envelope validity window.
Authentication fails closed when PostgreSQL is unavailable. The deployment still
supports one active API process: connection state and rate limits are process-local.
Restoring an older database backup also restores older replay state; persistence
does not provide protection against rolling the database itself back in time.

## Operation identity and results

The operation types listed in `shared/reliableOperations.ts` require a root-level
signed `operationId`. Its format is a 16-digit hexadecimal millisecond timestamp,
a hyphen, and 64 lowercase hexadecimal digits of random entropy. Keep this ID,
the payload and path parameters unchanged when retrying one logical action.
Create a new ID only for an intentional new action. Do not reuse IDs for modified
payloads and do not automatically replace an expected revision on conflict.

The server scopes results by Circle, signer, signed type and operation-ID hash;
it also compares a canonical fingerprint of payload and path parameters. Database
effects and the successful response commit together under transaction locks.
Concurrent retries return the same result. Reusing an ID with different content
returns HTTP 409. Authentication and access middleware still run on retries.

Cached responses are encrypted with a key derived from the secret operation ID
and its scope. Keep IDs private; the logger redacts `operationId`. Results remain
retrievable for 30 days. Thereafter the server returns a conflict and retains a
tombstone, rather than executing the action again. Expired response bodies are
removed in bounded batches. Result tombstones, resource versions and message-send
receipts are retained without a time limit; include them in database backups and
capacity planning. Circle migration transfers these three tables too, changing
the migration-contract fingerprint: both migration endpoints must be updated.
The global short-lived nonce table is not transferred by a Circle migration.

The web client journals pending IDs by signer/type/payload fingerprint in local
storage and preserves them after transport failures, authentication failures and
transient server errors. It removes them after success or terminal validation/
conflict responses. Regenerating encrypted content creates a different payload
and is therefore a new intent; an arbitrary manual UI repetition is not always
a retry. The native call-event sender derives a stable ID from the event itself.

## Conflicts and destructive operations

- Vault writes require `expectedRevision`: zero creates, a positive observed
  revision updates. The comparison is atomic with the write.
- Direct and group message edits/deletes compare the identity-signed author
  claim's next revision under a row lock. An identical claim identifies a retry.
- Clear operations require `clearThroughSequence`. Obtain it from the signed
  `/messages/clear-boundary` or `/group-chats/:chatId/messages/clear-boundary`
  endpoint. The boundary covers committed server history at that read, rather
  than only the messages currently displayed on screen. Later messages survive
  retries of the same clear request. Send receipts survive deletion and TTL.
- Archive segment `expectedRevision: null` means insert only. It cannot replace
  an existing segment. Updates require its current revision.
- Mobile delivery, push binding changes and backup writes serialize
  by resource and compare ordered operation IDs. A delayed older intent cannot
  overwrite a newer accepted intent. This is client-time ordering, not a strict
  expected-version snapshot: concurrent devices need reasonably synchronized
  clocks; equal timestamps use the random suffix as a tie breaker. More than
  60 seconds in the future is rejected. Recovery now uses strict server versions
  (initial public baseline, below); revoked binding IDs still cannot be activated again.
- Admin and owner claims are consumed in the same transaction as the grant.
  The same recipient can recover the original result; another recipient cannot
  redeem the used claim. Replaying a consumed claim never re-grants revoked rights.

## Temporary access delivery

Reading an approved trusted-access or renewal payload does not consume it. The
original temporary device can read it again until the request expires. After
installing the result locally, the client signs `/temporary-access/trusted/ack`
with the installed trusted device, or `/temporary-access/renewal/ack` with the
original temporary device. The signed type matches that route.

ACK is idempotent. Trusted ACK consumes the request and revokes the temporary
device in one transaction. Renewal approval and extension also commit together.
The client journals pending ACK metadata and retries it through the foreground/
online grant supervisor, including after restart; no transferred keys are stored
in this journal. Request expiry still bounds payload availability.

## Limits and verification

These guarantees cover local database effects. WebSocket notifications and
external push delivery remain best effort; an external service cannot be made
exactly-once by a local transaction. Presentation-image retries reuse a deterministic
storage key, but filesystem writes are not part of PostgreSQL rollback. Existing
cleanup and reconciliation remain necessary after partial storage failures.
Ordinary settings and permission mutations outside the explicit operation list
retain their existing conflict semantics. Never retry every mutation indiscriminately.

Run `npm run build`, `npm test -- --runInBand` and `npm run lint` in `server`.
For real PostgreSQL regressions, create a disposable empty database whose name
ends with `_reliability_test`, set `RELIABILITY_TEST_DATABASE_URL` to its URL, then
run `npm run test:reliability`. The script refuses a nonempty database, installs
the public baseline, reapplies the upgrade, and exercises concurrency, pool
reinitialization, lost-response retries, expiry and transaction rollback. Exported
CI runs these checks against its own disposable PostgreSQL service.

## Server versions for access changes (initial public baseline)

The first public baseline and the matching client/server release
add strict server-issued revisions for the 20 operations in
`shared/accessOperations.ts`: recovery bind/revoke, call whitelist add/remove,
participant role/invitation permission/disable/enable, guest permission/revoke,
server-admin grant/revoke, Circle suspend/resume, channel subscription and author
remove/restore, public-site visibility and administrator-status disclosure.
Channel titles/descriptions, guest presentation defaults and group mute settings
are not rights grants and keep their existing behavior. Membership/group admission
continues to require its existing signed chain/proofs; these guards do not replace it.

Before the **first transport attempt** of a new action, the client signs
`access-state:version` and POSTs `/api/access-state/version` with
`{type, path, payload}` identifying the proposed mutation. The endpoint returns only
an opaque version (`"0"` for an untouched resource), not the resource state or
permission to mutate it. The mutation additionally signs root-level
`expectedVersion`, `accessPath` (the `/api`-relative destination) and `operationId`.
All original authorization and payload/proof checks remain in force.

The client persists the observed version and a destination/server-scoped intent
ID before sending the mutation. A transport retry retains both. The server locks
the resource, compares the version, and commits rights, a new revision and the
cached result together. An already committed retry returns its previous result
without executing again, even if the rights have since changed. Reusing that ID
with another version/path/payload is rejected. Revision comparison does not use
client clocks; the general timestamp/operation-ID age validation still applies.

A stale new mutation returns HTTP 409 `ACCESS_VERSION_CONFLICT`. The web client
shows a localized instruction to refresh the screen, review current rights and
confirm the action again; it does not silently refresh the version and retry.
The preflight version protects an action from changes **after its first attempt**;
it is not a claim that an arbitrary UI draft was based on the latest displayed
state. Where signed membership transitions already carry their own predecessor,
that stronger state-level check also remains in force.

Database triggers invalidate revisions for other writers too (membership
projection, cleanup, CLI, recovery claims), while presence, read cursors and other
unrelated updates do not invalidate rights. Whole-channel revisions deliberately
serialize access/publication changes within a channel. Server-admin grants use
one server-wide revision regardless of the administrator's carrier Circle.
An external write and a versioned mutation can produce a PostgreSQL deadlock;
the aborted transaction rolls back, and a retry retains its original expected
version. External notifications/files are still not atomic with the database.

Old clients fail closed on these mutations. New clients do not attempt a mutation
if the new version endpoint is unavailable; there is no unversioned fallback.
Deploy the migration, API and web bundle together, including the Android embedded
web bundle. Recovery discovery/restoration after total server loss remains a
separate deferred feature.

Validation: the disposable PostgreSQL reliability script installs the public baseline
without private migrations and tests competing writes, external-writer invalidation, cached replay
without regrant, failed-transaction rollback, scope and validation errors. The
HTTP operation registry test requires every listed route to have the versioned
wrapper. Client tests cover persisted versions, new explicit intent after conflict
and separation by server/destination. The system suite adds a delayed permission
grant behind a newer grant/revoke; run that suite on fresh candidate images.

## Temporary call-event compatibility for the server-first rollout

`POST /api/calls/handling-event` temporarily accepts an absent `operationId` using
its previous handler. Signature/nonce validation, active-identity and call-participant
checks still apply. A supplied ID always uses strict reliable-operation validation;
null, empty or malformed IDs are rejected, not downgraded. Valid new requests keep
transactional replay protection. Legacy requests can repeat their effects after a
lost response. This exception is local to handling-event and is intended for removal
in the next release after clients update; it does not enable legacy access
mutations. Push registration has its own narrow exception below. No database migration or automatic time-based cutoff is introduced.

## Temporary push-registration compatibility for the server-first rollout

`POST /api/mobile/devices/delivery-tokens/register` and `POST /api/push/subscribe`
accept authenticated legacy requests with no `operationId`. This permits token
renewal and subscription registration while an Android client still runs an old
web bundle. Signature, timestamp, nonce, device-status and payload checks remain
in place. A supplied null, empty or malformed ID is rejected; valid IDs retain
the existing transactional replay handling.

This exception does not cover unbinding, unsubscribing or access mutations. Old
registrations do not get operation-level replay or ordering protection: a newly
signed retry can register again. Remove `compatiblePushRegistration` and restore
`reliableOperation` at both registration routes after clients update, alongside
the planned removal of the call-event exception. There is no automatic deadline
and no schema change.

Validation: route tests cover absent and malformed IDs, payload validation,
authentication middleware placement and the transactional path for new clients.
These checks do not replace testing a released Android build against the candidate
server; the extended system suite was not rerun for this adapter.
