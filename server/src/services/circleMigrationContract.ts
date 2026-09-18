import crypto from 'node:crypto';

export const CIRCLE_MIGRATION_FORMAT = 'circlus-circle-migration-v2' as const;
export const CIRCLE_MIGRATION_FORMAT_VERSION = 2 as const;

export const CIRCLE_MIGRATION_FIXED_SCOPES = [
  'core',
  'direct_guest_links',
  'public_circle_site'
] as const;

export const CIRCLE_MIGRATION_V2_EXPORT_TABLES = [
  'signed_operation_results',
  'signed_resource_versions',
  'message_send_receipts',
  'family_config',
  'identities',
  'devices',
  'vaults',
  'identity_backups',
  'messages',
  'identity_read_cursors',
  'direct_chat_epoch_keys',
  'direct_chat_epoch_state',
  'direct_chat_key_envelopes',
  'direct_chat_seq',
  'group_chats',
  'group_chat_participants',
  'group_chat_messages',
    'message_reaction_states',
  'group_chat_reads',
  'group_chat_epoch_keys',
  'group_chat_key_envelopes',
  'group_chat_seq',
  'direct_guest_links',
  'direct_guest_link_defaults',
  'announcement_channels',
  'announcement_channel_links',
  'direct_guest_registrations',
  'announcement_channel_subscriptions',
  'announcement_channel_epoch_keys',
  'announcement_channel_key_envelopes',
  'announcement_channel_posts',
  'announcement_channel_reactions',
  'circle_site_settings',
  'circle_site_publications',
  'trusted_device_rekey_jobs',
  'trusted_device_rekey_targets'
] as const;

export type CircleMigrationTableAction = 'copy' | 'transform' | 'derive' | 'reset' | 'drop';

/**
 * The v2 table contract is intentionally closed. Adding/removing a table
 * changes both fingerprints and therefore makes old/new servers incompatible
 * until a new migration format is introduced deliberately.
 */
export const CIRCLE_MIGRATION_V2_TABLE_CONTRACT = {
  copy: [
    'signed_operation_results',
    'signed_resource_versions',
    'message_send_receipts',
    'identities',
    'devices',
    'vaults',
    'identity_backups',
    'messages',
    'identity_read_cursors',
    'group_chats',
    'group_chat_participants',
    'group_chat_messages',
    'message_reaction_states',
    'group_chat_reads',
    'group_chat_epoch_keys',
    'group_chat_key_envelopes',
    'group_chat_seq',
    'direct_chat_epoch_keys',
    'direct_chat_epoch_state',
    'direct_chat_key_envelopes',
    'direct_chat_seq',
    'direct_guest_links',
    'direct_guest_link_defaults',
    'announcement_channels',
    'announcement_channel_links',
    'direct_guest_registrations',
    'announcement_channel_subscriptions',
    'announcement_channel_epoch_keys',
    'announcement_channel_key_envelopes',
    'announcement_channel_posts',
    'announcement_channel_reactions',
    'circle_site_settings',
    'circle_site_publications',
    'trusted_device_rekey_jobs',
    'trusted_device_rekey_targets'
  ],
  transform: [
    'family_config'
  ],
  derive: [
    'family_domains'
  ],
  reset: [
    'message_device_sync',
    'system_device_sync',
    'call_device_sync',
    'circle_media_routing_settings',
    'circle_membership_states',
    'circle_profile_epochs',
    'circle_profile_epoch_envelopes',
    'circle_encrypted_identity_profiles'
  ],
  drop: [
    'attachment_blobs',
    'attachment_upload_reservations',
    'circle_site_publication_assets',
    'circle_file_access',
    'message_archive_jobs',
    'message_archive_segments',
    'call_logs',
    'call_sessions',
    'call_links',
    'call_whitelist_entries',
    'invites',
    'invite_acceptances',
    'system_events',
    'device_enrollments',
    'temporary_access_requests',
    'temporary_devices',
    'temporary_device_chat_access',
    'temporary_device_direct_chat_key_envelopes',
    'temporary_device_group_chat_key_envelopes',
    'circle_inspector_requests',
    'circle_inspector_sessions',
    'call_ice_diagnostics',
    'call_client_diagnostics',
    'call_quality_daily',
    'call_handling_events',
    'announcement_channel_push_outbox',
    'direct_file_quick_receive_controls',
    'push_subscriptions',
    'device_notification_bindings',
    'server_admins',
    'server_admin_claims',
    'tenant_owner_claims'
  ]
} as const satisfies Record<CircleMigrationTableAction, readonly string[]>;

export const CIRCLE_MIGRATION_V2_FIELD_TRANSFORMS = {
  'family_config.status': 'pending_import_then_active',
  'family_config.circle_id': 'destination_circle_id',
  'family_config.public_base_url': 'target_public_base_url',
  'family_config.used_attachment_storage_bytes': 0,
  'family_config.reserved_attachment_storage_bytes': 0,
  'identities.avatar_blob_id': null,
  'identities.avatar_updated_at': null,
  'circle_site_settings.cover_image_url': 'clear_local_attachment_url',
  'announcement_channels.public_site_intro_image_url': 'clear_local_attachment_url',
  'direct_guest_links.presentation_image_url': 'clear_local_attachment_url',
  'direct_guest_link_defaults.presentation_image_url': 'clear_local_attachment_url',
  'direct_guest_links.public_site_intro_image_url': 'clear_local_attachment_url',
  'direct_guest_links.public_site_guest_link_url': 'replace_standard_server_parameter'
} as const;

export const CIRCLE_MIGRATION_V2_SCHEMA_DESCRIPTOR = {
  format: CIRCLE_MIGRATION_FORMAT,
  version: CIRCLE_MIGRATION_FORMAT_VERSION,
  scopes: CIRCLE_MIGRATION_FIXED_SCOPES,
  tables: CIRCLE_MIGRATION_V2_TABLE_CONTRACT,
  fieldTransforms: CIRCLE_MIGRATION_V2_FIELD_TRANSFORMS
} as const;

function normalizeCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical JSON does not support non-finite numbers');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeCanonicalValue);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) {
        throw new Error(`Canonical JSON does not support undefined at ${key}`);
      }
      normalized[key] = normalizeCanonicalValue(child);
    }
    return normalized;
  }
  throw new Error(`Canonical JSON does not support ${typeof value}`);
}

export function canonicalizeCircleMigrationJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

export function sha256Fingerprint(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export const CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT = sha256Fingerprint(
  canonicalizeCircleMigrationJson({
    scopes: CIRCLE_MIGRATION_FIXED_SCOPES,
    tables: CIRCLE_MIGRATION_V2_TABLE_CONTRACT
  })
);

export const CIRCLE_MIGRATION_SCHEMA_FINGERPRINT = sha256Fingerprint(
  canonicalizeCircleMigrationJson(CIRCLE_MIGRATION_V2_SCHEMA_DESCRIPTOR)
);

export function isSupportedCircleMigrationContract(params: {
  migrationFormatVersion: unknown;
  schemaFingerprint: unknown;
  dataScopeFingerprint?: unknown;
}): boolean {
  return (
    params.migrationFormatVersion === CIRCLE_MIGRATION_FORMAT_VERSION
    && params.schemaFingerprint === CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
    && (
      params.dataScopeFingerprint === undefined
      || params.dataScopeFingerprint === CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT
    )
  );
}
