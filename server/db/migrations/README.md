# Database Migrations

The public Circlus Server repository starts from an open-source baseline and
forward-only upgrades:

| Migration | Description |
|-----------|-------------|
| `001_initial_schema.sql` | Complete schema at the first public server release |
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

Fresh installations apply this baseline automatically through `npm run migrate`
or the bundled Docker Compose migrator service.

Future public schema changes should be added as new numbered migrations:

```text
010_describe_change.sql
011_describe_next_change.sql
```

Do not edit migrations that may already have been published and deployed.
