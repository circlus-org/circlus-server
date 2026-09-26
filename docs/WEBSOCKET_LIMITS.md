# WebSocket resource limits

The limits below apply across all Circles and WebSocket registration modes.
When a limit is reached, the server rejects a connection or closes the affected
socket; it does not silently drop individual messages from an open connection.

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

## HTTP fallback

[HTTP signaling](HTTP_SIGNALING.md) documents protocol 2, HTTP resource limits,
and the WebSocket handover policy.
