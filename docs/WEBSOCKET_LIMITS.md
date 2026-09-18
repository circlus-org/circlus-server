# WebSocket resource limits

One resource guard covers every Circle and all four registration modes: local,
external guest, call runtime and direct-file-transfer runtime. Existing signed
registration formats and signaling messages do not change.

Incoming messages are admitted before JSON parsing, database calls and the
per-operation rate limiter. Each socket processes admitted messages in order.
The message currently executing still consumes its queue budget. Closing a socket
discards waiting work immediately; an already executing handler may finish its
current operation and releases its accounting in `finally`. Closed sockets cannot
register later, and cleanup runs again if an in-flight handler finishes after close.

All `send`, `ping` and `pong` paths share outgoing budgets, including automatic
ping replies. Accounting lasts until the underlying write callback completes,
and also checks the socket's actual `bufferedAmount`. Counts and bytes are bounded
separately, so many empty frames cannot bypass the byte limit. Outbound byte
accounting includes a conservative 16-byte frame allowance.

| Environment variable | Default | Meaning |
|---|---:|---|
| `WS_MAX_CONNECTIONS` | 256 | Total connections, including pending upgrades and closing sockets until transport close |
| `WS_MAX_CONNECTIONS_PER_IP` | 128 | Connections per address, using the HTTP `TRUST_PROXY` policy |
| `WS_MAX_UNREGISTERED_CONNECTIONS` | 64 | Global pending-upgrade/unregistered connection budget |
| `WS_HANDSHAKE_TIMEOUT_MS` | 10000 | Time allowed for asynchronous upgrade checks |
| `WS_REGISTRATION_TIMEOUT_MS` | 30000 | Time from upgrade until authenticated registration response |
| `WS_MAX_QUEUED_MESSAGES` | 128 | Incoming messages per registered socket, including running work |
| `WS_MAX_QUEUED_BYTES` | 4194304 | Incoming bytes per registered socket: 4 MiB |
| `WS_MAX_UNREGISTERED_MESSAGES` | 8 | Incoming messages before registration |
| `WS_MAX_UNREGISTERED_BYTES` | 262144 | Incoming bytes before registration: 256 KiB |
| `WS_MAX_GLOBAL_QUEUED_MESSAGES` | 4096 | Incoming messages across all sockets, including running work |
| `WS_MAX_GLOBAL_QUEUED_BYTES` | 33554432 | Incoming bytes across all sockets: 32 MiB |
| `WS_MAX_OUTGOING_MESSAGES` | 256 | Outstanding writes per socket, including control frames |
| `WS_MAX_OUTGOING_BYTES` | 8388608 | Outstanding bytes per socket: 8 MiB |
| `WS_MAX_GLOBAL_OUTGOING_MESSAGES` | 8192 | Outstanding writes across all sockets |
| `WS_MAX_GLOBAL_OUTGOING_BYTES` | 67108864 | Outstanding bytes across all sockets: 64 MiB |

`WS_MAX_PAYLOAD_BYTES` remains the separate transport limit for a single incoming
message (default 1 MiB). All numeric settings have validated finite ranges; zero,
negative, fractional and out-of-range settings fail startup. When limits overlap,
the first limit reached wins. The pre-registration budget never exceeds the
registered-socket budget.

Set overrides in the server environment or the public deployment's `deploy/.env`;
Compose already passes that file to the server. Full defaults are documented in
`server/.env.example`. Keep the proxy hop/address policy correct and overwrite
forwarded headers at the trusted proxy. Do not enable blanket trust merely to
make IP limits appear to work. One IP can represent many users behind NAT.

Admission overflow returns HTTP 503. Incoming/outgoing overflow closes the socket
with code 1013; registration timeout uses 1008. A resource-triggered close is
force-terminated after one second if the peer does not finish closing. Limits
do not silently discard individual messages while leaving the socket usable.
Clients must reconnect, sign a fresh registration and resynchronize state. A
transport close can interrupt a call; successful reconnect alone does not prove
that a live media session survives every network failure.

These budgets bound tracked WS queues, not the process RSS. JSON objects, active
business logic, socket/TLS buffers, partially assembled messages and PostgreSQL
connections use additional memory. The transport message limit and connection
limits constrain additional exposure but do not replace workload testing. The
defaults are conservative starting limits, not a claim of capacity on a specific
VPS. Tune against the smallest supported VPS and mobile reconnect/ICE bursts.
Warnings use the `ws_resource_limit` event with reason and aggregate counters.

Verification:

```bash
cd server
npm run build
npm test -- --runInBand
npm run lint
npm run test:ws-resources
```

Unit tests cover slow/failed handlers, FIFO order, socket close during queued work,
byte/count/global admission limits, registration/upgrade deadlines, outgoing errors,
control frames, accounting and trust-proxy behavior. The integration script uses
real loopback WebSockets to test overload, registration deadline, reconnect/order,
automatic pong and outgoing burst limits. It needs no application DB or external
service and is included in exported CI. Real mobile calls through TURN still
belong to the release acceptance test.

## HTTP fallback and soft limit

See [HTTP_SIGNALING.md](HTTP_SIGNALING.md) in the public docs for protocol 2,
HTTP budgets, the soft WS threshold and client cooldown. In the source repository
the document is named SERVER_HTTP_SIGNALING.md.
