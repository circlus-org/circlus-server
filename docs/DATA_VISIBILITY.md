# What the server can see

Circlus clients encrypt private content before sending it to the server. This
page describes the boundary visible in the server code. It is a guide for
reviewing the implementation, not an independent security audit or a claim
that the server sees no sensitive data.

## Private content stored as ciphertext

The server stores private direct and group messages, private channel posts,
ordinary attachments, Circle and participant profile details, vaults, and
backups as encrypted records or blobs. It routes encrypted key envelopes but
does not hold the content keys needed to decrypt them. A database or attachment
backup still contains sensitive ciphertext and must be protected.

Call media is encrypted between call endpoints. The optional TURN service
relays encrypted media packets; the Circlus API server handles call signaling
and session state, not media plaintext.

## Data the server can read

The server needs some readable information to route requests, enforce access,
deliver messages, and run the service. Examples include:

- Circle domains and identifiers; identity and device identifiers and public
  keys; roles, permissions, membership and revocation state;
- message participants, sequence numbers, timestamps, delivery and read state,
  and encrypted payload sizes;
- attachment ownership, size, retention and storage identifiers, but not the
  original filename or MIME type of an ordinary encrypted attachment;
- IP addresses, browser origins, activity times, push endpoints and delivery
  tokens, call participants, and WebRTC signaling such as SDP and ICE
  candidates.

Even without message plaintext, this metadata can reveal relationships and
activity. Operators should protect the database, logs, backups and server
credentials accordingly.

## Deliberately readable content and exceptions

- Public Circle sites and their published articles, images and presentation
  assets are readable by the server because it renders or serves them.
- When a user requests a link preview, the client can send a URL from that
  user's decrypted message to the server for fetching. This reveals that URL
  to the server and to the site it contacts.
- The server administrator's display label is operator data stored in
  plaintext. A short-lived initial owner invitation token is stored in usable
  form during the first-Circle bootstrap flow.
- Deployment secrets and push delivery credentials are available to the server
  or its companion services as needed for operation.

This repository lets you inspect what the server accepts, stores and returns.
It cannot by itself verify how the official client creates keys, encrypts
content, or protects decrypted data on a device. Reverse-proxy logs, hosting
infrastructure, and external notification services also sit outside this
server-code review.

Start with the schema in `server/db/migrations/`, then inspect
`server/src/routes/`, `server/src/db/repositories/`, `server/src/ws/`,
and `ice_config_service/src/`. The [security policy](../SECURITY.md)
explains how to report a suspected vulnerability privately.
