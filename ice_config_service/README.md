# Circlus ICE Config Service

The Docker Compose setup starts this service automatically. It gives the
Circlus Server STUN addresses and short-lived TURN credentials for calls.
Follow the [server installation guide](../README.md); there is no separate
installation step for the ICE Config Service.

`deploy/init-local-turn.sh` creates
`deploy/ice/turn-clusters.json` and the required files in
`deploy/secrets/`. Keep those files when updating or restoring the server.
The local TURN profile starts coturn alongside this service.

The Circlus Server authenticates requests to the ICE Config Service with a
server-to-server HMAC key. The service selects an allowed TURN cluster and
returns credentials that expire after the configured TTL. The main server does
not need the coturn shared secret. Configuration fields and supported cluster
types are shown in [config.example.json](config.example.json).

## Data visible to this service

ICE requests contain the server and Circle identifiers plus opaque Circle and
media-session subjects. The service logs the server ID, key ID, VPS ID, Circle
ID, opaque subjects, selected cluster, status, and request duration. It does
not log request bodies, HMAC secrets, signatures, or issued TURN credentials.

TURN usernames contain opaque Circle and media-session subjects rather than
raw Circle or call identifiers. Coturn relays encrypted WebRTC media packets;
it does not decrypt call media.

The implementation is in [src/](src/). The main server's handling of private
content and metadata is summarized in [data visibility](../docs/DATA_VISIBILITY.md).
