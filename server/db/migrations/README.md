# Database Migrations

Circlus Server applies these migrations in order. Existing installations skip
files already recorded in `schema_migrations`:

| Migration | Description |
|-----------|-------------|
| `001_initial_schema.sql` | Initial schema; fresh installations then apply all forward migrations |
| `002_managed_push_configuration.sql` | Managed Notification Central connection |
| `003_archive_legacy_circle_membership_v1.sql` | Archive obsolete V1 membership state before signed V2 replacement |
| `004_remove_server_admin_owner_recovery.sql` | Remove unsigned server-admin Circle ownership recovery |
| `005_forbid_plaintext_identity_names.sql` | Clear and reject legacy plaintext participant names |
| `006_encrypt_circle_names_and_statuses.sql` | Store Circle names and participant statuses only as encrypted signed records |
| `007_correct_avatar_storage_comment.sql` | Correct the legacy database comment for encrypted avatars |
| `008_remove_legacy_plaintext_and_quota_fields.sql` | Remove obsolete plaintext status, quota, invite projection, recovery archive, and ambiguous attachment fields |
| `009_require_group_chat_protocol_v2.sql` | Prevent creation of obsolete protocol-v1 group chats |
| `010_delete_legacy_identity_backups.sql` | Remove obsolete lookup-secret identity backups |
| `011_encrypt_private_link_and_device_metadata.sql` | Remove plaintext private link and device labels |
| `012_encrypt_channel_metadata_and_reaction_codes.sql` | Encrypt channel metadata and make reaction values opaque to the server |
| `013_call_handling_blocking_session.sql` | Track the session blocking call handling |
| `014_direct_message_read_proof.sql` | Store signed direct-message read proofs |
| `015_circle_membership_snapshot_action.sql` | Record membership snapshot actions |
| `016_nullable_rekey_device_id.sql` | Allow rekey operations without an initiating device |
| `017_device_client_version.sql` | Store device client version metadata |
| `018_device_client_protocols.sql` | Store supported device protocol versions |
| `019_tenant_suspension_lifecycle.sql` | Add Circle suspension fields and statuses missing from the public baseline |
| `020_mobile_route_calls_policy.sql` | Persist the explicit no-call policy of a mobile notification binding |
| `021_mobile_call_readiness_expiry.sql` | Expire mobile call readiness and separate standard and VoIP bindings |
| `022_call_admission_journal.sql` | Persist call admission and cancellation outcomes |
| `023_call_runtime_recovery.sql` | Persist selected call devices, SDP outcomes and pending deliveries across API restarts |

Migration 019 preserves the published initial schema. It converts revoked Circles
that retain an owner to suspended, preserving data and timestamps; ownerless
revoked Circles remain revoked. Do not copy private migration history into a
public installation.

Fresh installations apply all migrations through `npm run migrate` or the
bundled Docker Compose migrator service.

Back up the database before updating. Do not edit migrations that have
already been applied; the migrator checks their recorded checksums.
