# Database Migrations

Circlus Server applies these migrations in order. Existing installations skip
files already recorded in `schema_migrations`:

| Migration | Description |
|-----------|-------------|
| `001_initial_schema.sql` | Initial schema; fresh installations then apply `002`–`012` |
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

Fresh installations apply all migrations through `npm run migrate` or the
bundled Docker Compose migrator service.

Back up the database before updating. Do not edit migrations that have
already been applied; the migrator checks their recorded checksums.
