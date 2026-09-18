import type { PoolClient } from 'pg';
import {
  circleMigrationRepository,
  type MigrationSlotRecord,
  type PendingCircleImportReport
} from '../db/repositories/circleMigrationRepository';
import {
  CIRCLE_MIGRATION_V2_EXPORT_TABLES
} from './circleMigrationContract';
import {
  iterateCircleMigrationStagedRows
} from './circleMigrationImportService';
import type { CircleMigrationExportManifest } from './circleMigrationExportService';
import { CircleMigrationServiceError } from './circleMigrationSlotService';

const IMPORT_BATCH_SIZE = 250;
const COPIED_TABLES = CIRCLE_MIGRATION_V2_EXPORT_TABLES.filter(
  (table) => table !== 'family_config'
);
const NORMALIZED_FIELDS = [
  'family_config.server_name',
  'family_config.circle_id',
  'family_config.first_owner_invite_token',
  'family_config.public_base_url',
  'family_config.extra_trusted_client_origins',
  'family_config.attachments_*',
  'family_config.status',
  'family_config.created_by_server_admin_id',
  'family_config.revoked_at',
  'family_config.join_invite_id',
  'family_config.message_archive_*',
  'family_config.max_member_identities',
  'family_config.max_total_identities',
  'family_domains',
  'circle_site_settings.cover_image_url',
  'announcement_channels.public_site_intro_image_url',
  'direct_guest_links.presentation_image_url',
  'direct_guest_links.public_site_intro_image_url',
  'direct_guest_links.public_site_guest_link_url'
];

type MigrationTable = typeof CIRCLE_MIGRATION_V2_EXPORT_TABLES[number];
type JsonRow = Record<string, unknown>;

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function stringPolicy(
  value: unknown,
  fallback: 'disabled' | 'text' | 'text_with_attachments'
): 'disabled' | 'text' | 'text_with_attachments' {
  return value === 'disabled' || value === 'text' || value === 'text_with_attachments'
    ? value
    : fallback;
}

export function isRecognizedSourceAttachmentUrl(value: unknown, sourceOrigin: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== sourceOrigin) return false;
    return (
      /^\/api\/direct-guest-links\/presentation-images\/[^/]+\/?$/.test(parsed.pathname)
      || /^\/api\/attachments\/(?:uploads|blobs)\/[^/]+(?:\/(?:read|metadata))?\/?$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function normalizeOpenGuestLink(
  value: unknown,
  sourceOrigin: string,
  targetPublicBaseUrl: string
): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    const parsed = new URL(value);
    if (!/\/open\/?$/.test(parsed.pathname)) return value;
    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    if (fragment.get('type') !== 'direct-link') return value;
    const rawServer = fragment.get('server');
    if (!rawServer) return value;
    const serverOrigin = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(rawServer) ? rawServer : `https://${rawServer}`
    ).origin;
    if (serverOrigin !== sourceOrigin) return value;
    const target = new URL(targetPublicBaseUrl);
    fragment.set('server', target.protocol === 'https:' ? target.host : target.origin);
    parsed.hash = fragment.toString();
    return parsed.toString();
  } catch {
    return value;
  }
}

export function transformFamilyConfig(
  row: JsonRow,
  slot: MigrationSlotRecord,
  manifest: CircleMigrationExportManifest
): JsonRow {
  const policies = slot.settings || {};
  const limits = slot.limits || {};
  const targetTtl = numberOrNull(policies.messageTtlHours)
    ?? numberOrNull((manifest.configAdjustments as JsonRow | undefined)?.messageTtlHours)
    ?? numberOrNull(row.message_ttl_hours);
  if (!targetTtl || targetTtl > 24 * 365) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_DESTINATION_POLICY_INVALID',
      'Destination message TTL is invalid'
    );
  }
  const archivePolicy = stringPolicy(policies.messageArchivePolicyAfterActivation, 'text');
  return {
    ...row,
    circle_id: slot.destination_circle_id,
    server_name: slot.server_name,
    first_owner_invite_token: null,
    public_base_url: slot.target_public_base_url,
    message_ttl_hours: targetTtl,
    extra_trusted_client_origins: [],
    attachments_enabled: policies.attachmentsEnabledAfterActivation === true,
    max_attachment_file_size_bytes: null,
    attachment_storage_quota_bytes: null,
    attachment_retention_seconds: null,
    used_attachment_storage_bytes: 0,
    reserved_attachment_storage_bytes: 0,
    status: 'pending_import',
    owner_identity_id: slot.expected_owner_identity_id,
    created_by_server_admin_id: slot.created_by_server_admin_id,
    claimed_at: new Date().toISOString(),
    revoked_at: null,
    join_invite_id: null,
    message_archive_server_policy: archivePolicy,
    message_archive_server_max_bytes: null,
    message_archive_circle_policy: archivePolicy,
    message_archive_circle_max_bytes: null,
    max_member_identities: numberOrNull(limits.maxMemberIdentities),
    max_total_identities: numberOrNull(limits.maxTotalIdentities),
    updated_at: new Date().toISOString()
  };
}

export function transformCopiedRow(
  table: MigrationTable,
  row: JsonRow,
  manifest: CircleMigrationExportManifest
): JsonRow {
  const sourceOrigin = new URL(manifest.oldPublicBaseUrl).origin;
  if (table === 'circle_site_settings') {
    return {
      ...row,
      // Public-site images are server-owned assets and are uploaded again after migration.
      cover_image_url: null
    };
  }
  if (table === 'announcement_channels') {
    return {
      ...row,
      public_site_intro_image_url: null
    };
  }
  if (table === 'direct_guest_link_defaults') {
    return {
      ...row,
      presentation_image_url: isRecognizedSourceAttachmentUrl(row.presentation_image_url, sourceOrigin)
        ? null
        : row.presentation_image_url
    };
  }
  if (table === 'direct_guest_links') {
    return {
      ...row,
      presentation_image_url: isRecognizedSourceAttachmentUrl(row.presentation_image_url, sourceOrigin)
        ? null
        : row.presentation_image_url,
      public_site_intro_image_url: null,
      public_site_guest_link_url: normalizeOpenGuestLink(
        row.public_site_guest_link_url,
        sourceOrigin,
        manifest.targetPublicBaseUrl
      )
    };
  }
  return row;
}

async function insertRows(
  client: PoolClient,
  table: MigrationTable,
  rows: JsonRow[]
): Promise<void> {
  if (rows.length === 0) return;
  // table is taken exclusively from the closed, versioned migration contract.
  await client.query(
    `INSERT INTO ${table}
     SELECT (jsonb_populate_record(NULL::${table}, value)).*
       FROM jsonb_array_elements($1::jsonb) AS value`,
    [JSON.stringify(rows)]
  );
}

async function importTable(
  client: PoolClient,
  slot: MigrationSlotRecord,
  manifest: CircleMigrationExportManifest,
  table: MigrationTable
): Promise<number> {
  let count = 0;
  let batch: JsonRow[] = [];
  for await (const rawRow of iterateCircleMigrationStagedRows(slot, table)) {
    batch.push(transformCopiedRow(table, rawRow, manifest));
    count += 1;
    if (batch.length >= IMPORT_BATCH_SIZE) {
      await insertRows(client, table, batch);
      batch = [];
    }
  }
  await insertRows(client, table, batch);
  return count;
}

async function assertImportedRelationships(
  client: PoolClient,
  slot: MigrationSlotRecord
): Promise<void> {
  const familyId = slot.expected_family_id!;
  const owner = await client.query<{ valid: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM identities
        WHERE family_id = $1::uuid
          AND identity_id = $2
          AND role = 'owner'
          AND status = 'active'
     ) AS valid`,
    [familyId, slot.expected_owner_identity_id]
  );
  if (owner.rows[0]?.valid !== true) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_OWNER_MISMATCH',
      'Imported Circle does not contain the reserved active owner'
    );
  }

  const identityCounts = await client.query<{ member_count: number; total_count: number }>(
    `SELECT COUNT(*) FILTER (WHERE role IN ('owner', 'member'))::bigint AS member_count,
            COUNT(*)::bigint AS total_count
       FROM identities
      WHERE family_id = $1::uuid`,
    [familyId]
  );
  const memberLimit = numberOrNull(slot.limits.maxMemberIdentities);
  const totalLimit = numberOrNull(slot.limits.maxTotalIdentities);
  const memberCount = Number(identityCounts.rows[0]?.member_count || 0);
  const totalCount = Number(identityCounts.rows[0]?.total_count || 0);
  if (
    (memberLimit !== null && memberCount > memberLimit)
    || (totalLimit !== null && totalCount > totalLimit)
  ) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_DESTINATION_LIMIT_EXCEEDED',
      'Imported identity count exceeds the destination slot limits'
    );
  }

  const orphanChecks = await client.query<{ relation: string }>(
    `SELECT relation
       FROM (
         SELECT 'devices.identity_id' AS relation
          WHERE EXISTS (
            SELECT 1 FROM devices child
             WHERE child.family_id = $1::uuid
               AND NOT EXISTS (
                 SELECT 1 FROM identities parent
                  WHERE parent.family_id = $1::uuid
                    AND parent.identity_id = child.identity_id
               )
          )
         UNION ALL
         SELECT 'vaults.identity_id'
          WHERE EXISTS (
            SELECT 1 FROM vaults child
             WHERE child.family_id = $1::uuid
               AND NOT EXISTS (
                 SELECT 1 FROM identities parent
                  WHERE parent.family_id = $1::uuid
                    AND parent.identity_id = child.identity_id
               )
          )
         UNION ALL
         SELECT 'messages.identities'
          WHERE EXISTS (
            SELECT 1 FROM messages child
             WHERE child.family_id = $1::uuid
               AND (
                 NOT EXISTS (
                   SELECT 1 FROM identities parent
                    WHERE parent.family_id = $1::uuid
                      AND parent.identity_id = child.sender_identity_id
                 )
                 OR NOT EXISTS (
                   SELECT 1 FROM identities parent
                    WHERE parent.family_id = $1::uuid
                      AND parent.identity_id = child.recipient_identity_id
                 )
               )
          )
         UNION ALL
         SELECT 'announcement_channel_links.parents'
          WHERE EXISTS (
            SELECT 1 FROM announcement_channel_links child
             WHERE child.family_id = $1::uuid
               AND (
                 NOT EXISTS (
                   SELECT 1 FROM announcement_channels channel_parent
                    WHERE channel_parent.family_id = $1::uuid
                      AND channel_parent.channel_id = child.channel_id
                 )
                 OR NOT EXISTS (
                   SELECT 1 FROM direct_guest_links link_parent
                    WHERE link_parent.family_id = $1::uuid
                      AND link_parent.link_id = child.link_id
                 )
               )
          )
         UNION ALL
         SELECT 'announcement_channel_subscriptions.parents'
          WHERE EXISTS (
            SELECT 1 FROM announcement_channel_subscriptions child
             WHERE child.family_id = $1::uuid
               AND (
                 NOT EXISTS (
                   SELECT 1 FROM announcement_channels channel_parent
                    WHERE channel_parent.family_id = $1::uuid
                      AND channel_parent.channel_id = child.channel_id
                 )
                 OR NOT EXISTS (
                   SELECT 1 FROM identities identity_parent
                    WHERE identity_parent.family_id = $1::uuid
                      AND identity_parent.identity_id = child.subscriber_identity_id
                 )
               )
          )
         UNION ALL
         SELECT 'direct_guest_registrations.link_id'
          WHERE EXISTS (
            SELECT 1 FROM direct_guest_registrations child
             WHERE child.family_id = $1::uuid
               AND NOT EXISTS (
                 SELECT 1 FROM direct_guest_links parent
                  WHERE parent.family_id = $1::uuid
                    AND parent.link_id = child.link_id
               )
          )
         UNION ALL
         SELECT 'circle_site_publications.source'
          WHERE EXISTS (
            SELECT 1 FROM circle_site_publications child
             WHERE child.family_id = $1::uuid
               AND (
                 (child.source_link_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM direct_guest_links link
                    WHERE link.family_id = $1::uuid
                      AND link.link_id = child.source_link_id
                 ))
                 OR NOT EXISTS (
                   SELECT 1 FROM announcement_channel_posts post
                    WHERE post.family_id = $1::uuid
                      AND post.post_id = child.source_channel_post_id
                      AND post.channel_id = child.channel_id
                 )
               )
          )
       ) broken`,
    [familyId]
  );
  if (orphanChecks.rows.length > 0) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_REFERENTIAL_INTEGRITY_FAILED',
      `Imported relationships are invalid: ${orphanChecks.rows.map((row) => row.relation).join(', ')}`
    );
  }
}

class CircleMigrationPendingImportService {
  async apply(slot: MigrationSlotRecord): Promise<MigrationSlotRecord> {
    if (
      slot.status === 'waiting_cutover'
      && slot.imported_family_id === slot.expected_family_id
    ) {
      return slot;
    }
    if (
      slot.status !== 'imported'
      || !slot.expected_family_id
      || !slot.expected_owner_identity_id
      || !slot.import_manifest
    ) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration slot is ${slot.status}`);
    }
    const manifest = slot.import_manifest as CircleMigrationExportManifest;
    const familyRows: JsonRow[] = [];
    for await (const row of iterateCircleMigrationStagedRows(slot, 'family_config')) {
      familyRows.push(row);
    }
    if (
      familyRows.length !== 1
      || familyRows[0]?.family_id !== slot.expected_family_id
      || familyRows[0]?.owner_identity_id !== slot.expected_owner_identity_id
    ) {
      throw new CircleMigrationServiceError(
        409,
        'MIGRATION_FAMILY_CONFIG_INVALID',
        'Migration package must contain exactly one matching Circle configuration'
      );
    }

    try {
      const waiting = await circleMigrationRepository.applyPendingTenantImport({
        migrationSlotId: slot.migration_slot_id,
        familyId: slot.expected_family_id,
        importRows: async (client): Promise<PendingCircleImportReport> => {
          const importedRows: Record<string, number> = {};
          await insertRows(
            client,
            'family_config',
            [transformFamilyConfig(familyRows[0]!, slot, manifest)]
          );
          importedRows.family_config = 1;
          await client.query(
            `INSERT INTO family_domains (
               family_id,
               host,
               public_base_url,
               role,
               status,
               is_current,
               source
             ) VALUES ($1::uuid, $2, $3, 'primary', 'pending_verification', true, 'circle_migration')`,
            [slot.expected_family_id, slot.target_host, slot.target_public_base_url]
          );

          for (const table of COPIED_TABLES) {
            importedRows[table] = await importTable(client, slot, manifest, table);
          }
          for (const entry of manifest.tableExports) {
            if (importedRows[entry.table] !== entry.rowCount) {
              throw new CircleMigrationServiceError(
                409,
                'MIGRATION_ROW_COUNT_MISMATCH',
                `Imported row count changed for ${entry.table}`
              );
            }
          }
          await assertImportedRelationships(client, slot);
          return {
            familyId: slot.expected_family_id!,
            importedRows,
            normalizedFields: NORMALIZED_FIELDS
          };
        }
      });
      if (!waiting) {
        throw new CircleMigrationServiceError(
          409,
          'INVALID_STATE',
          'Migration slot changed concurrently during pending import'
        );
      }
      return waiting;
    } catch (error: any) {
      if (error instanceof CircleMigrationServiceError) throw error;
      const code = String(error?.code || '');
      if (code === 'MIGRATION_FAMILY_CONFLICT' || code === 'MIGRATION_TARGET_HOST_ALREADY_USED') {
        throw new CircleMigrationServiceError(409, code, error.message);
      }
      if (code === '23505' || code === '23503') {
        throw new CircleMigrationServiceError(
          409,
          'MIGRATION_IMPORT_CONFLICT',
          'Imported rows conflict with destination data'
        );
      }
      if (code === '23514' || code === '22P02' || code === '22007') {
        throw new CircleMigrationServiceError(
          400,
          'MIGRATION_ROW_INVALID',
          'Imported row does not satisfy destination schema'
        );
      }
      throw error;
    }
  }
}

export const circleMigrationPendingImportService = new CircleMigrationPendingImportService();
