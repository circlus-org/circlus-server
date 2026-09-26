# HTTP signaling and WS handover

Protocol 2 provides acknowledged HTTP signaling for clients that cannot keep
a WebSocket connection. It uses the same authenticated registration and message
handlers as WebSocket signaling, including Circle and call authorization.

## Delivery contract

The existing `/api/mobile/calls/signaling/*` routes accept protocol 2:

- `register`: POST `{protocol: 2, registration: <WS registration message>}`.
  Native callers may supply their existing `signedRequest` instead. Every new
  registration attempt uses a fresh signed timestamp/nonce, including WS→HTTP.
- `send`: POST `{sequence, message}` with `Authorization: Bearer <sessionId>`.
  Sequence starts at 1. Clients serialize sends and preserve sequence/content
  when retrying a lost response. Replaying the last identical send is acknowledged
  without executing it again; changed/out-of-order sends receive a conflict.
- `poll`: POST `{ack}` with the bearer header. Start at 0. The response contains
  ordered `{sequence, message}` events. They remain buffered until the client
  acknowledges their sequence in a later poll. Only one poll per session is
  allowed; a cancelled request releases the poll slot.
- `close`: POST with the bearer header. Sessions also expire after inactivity.

Tokens are random bearer credentials, held in memory and kept out of URLs.
Requests are scoped to the original Circle and browser Origin. Native protocol 1
remains accepted, but its destructive reads do not provide protocol 2's
lost-response guarantee.

Delivery state lives in this API process. Session restart, server restart and
switching transports require fresh registration and existing application/call
state reconciliation. The sequence guarantee applies within one HTTP session,
not as an exactly-once promise across server crashes. Client event handling has
the same asynchronous application semantics as WS delivery.

## Resource bounds

| Setting | Default |
|---|---:|
| `WS_SOFT_MAX_CONNECTIONS` | 192 |
| `WS_MAX_CONNECTIONS` | 256 |
| `HTTP_SIGNALING_MAX_SESSIONS` | 512 |
| `HTTP_SIGNALING_MAX_SESSIONS_PER_IP` | 128 |
| `HTTP_CALL_SIGNALING_MAX_QUEUE` | 500 |
| `HTTP_SIGNALING_MAX_QUEUE_BYTES` | 4 MiB per session |
| `HTTP_SIGNALING_MAX_GLOBAL_BYTES` | 32 MiB |
| `HTTP_CALL_SIGNALING_MAX_POLL_MS` | 10 seconds |
| `HTTP_CALL_SIGNALING_SESSION_TTL_MS` | 15 minutes idle |

Registration is limited to 10 seconds; message and registration payloads are
limited to 1 MiB, additionally subject to the configured HTTP body parser limit.
HTTP writes are serialized with at most one active handler per session. Queue
or byte overflow closes the session; signals are not silently discarded from a
live production session. The web sender also limits queued messages/bytes.
The general HTTP rate limiter remains in force. These are separate transport
budgets, not a bound on total process RSS or a measured capacity for a 2 GiB VPS.
Long polling still holds an HTTP request open; handover does not make an idle
client free of server resource cost.

## Handover policy

The web client advertises top-level `httpFallback: true` on the WS registration frame,
outside the signed `data`. This
only opts that connection into optional handover; it is not an authorization or
priority claim. Connections without this opt-in are not voluntarily evicted by the soft policy.
Above the soft limit (clamped to the hard limit), at most one eligible connection
per second is sent `transport:defer` with `retryAfterMs: 60000`, then closed with
1013. Candidates are registered, idle for at least 30 seconds, have no running
handler, and are not participating in a call or direct file transfer. Native
scoped runtime connections are protected. Hard limits continue to apply to all
connections, including calls, and no admission beyond the hard limit is promised.

The client changes to HTTP with jitter and postpones WS retry for roughly a
minute. WS failure/1013 also activates fallback. An HTTP client tries WS again
only after the cooldown, while authenticated and without known active realtime
sessions or pending writes. A failed attempt restores HTTP fallback. Direct
messages use their ordinary HTTP API while the WS transport is absent; other
existing control events can travel through the HTTP event queue.

## Destination isolation

The web client's WS-to-HTTP cooldown is scoped to the destination origin
(hostname, scheme and port), retained when switching circles and discarded on
expiry. Distinct domains remain independent even when they share a physical
server. A repeated defer cannot shorten an existing cooldown.
