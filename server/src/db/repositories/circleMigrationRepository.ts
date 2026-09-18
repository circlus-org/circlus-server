import type { PoolClient } from 'pg';
import { createOpaqueClaimToken } from '../../utils/claimTokens';
import { pool, transaction } from '../index';
import {
  assertMigrationSlotTransition,
  assertSourceMigrationTransition,
  type MigrationSlotStatus,
  type SourceMigrationStatus
} from '../../services/circleMigrationStateMachine';
import {
  CIRCLE_MIGRATION_V2_EXPORT_TABLES,
  CIRCLE_MIGRATION_V2_TABLE_CONTRACT
} from '../../services/circleMigrationContract';
import { getServerIdentityRuntimeConfig } from '../../config/serverRuntimeConfig';

export interface MigrationSlotRecord {
  migration_slot_id: string;
  migration_code_hash: string;
  migration_code_encrypted: Record<string, unknown>;
  migration_code_consumed_at: Date | null;
  destination_circle_id: string;
  source_circle_id: string | null;
  target_public_base_url: string;
  target_host: string;
  service_endpoint: string;
  server_name: string;
  created_by_server_admin_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: MigrationSlotStatus;
  expires_at: Date;
  settings: Record<string, unknown>;
  limits: Record<string, unknown>;
  migration_format_version: number;
  data_scope_fingerprint: string;
  expected_family_id: string | null;
  expected_owner_identity_id: string | null;
  source_migration_id: string | null;
  source_server_id: string | null;
  source_server_url: string | null;
  source_session_public_key: Record<string, unknown> | null;
  owner_identity_public_key: Record<string, unknown> | null;
  owner_signed_migration_intent: Record<string, unknown> | null;
  owner_signed_cutover_confirmation: Record<string, unknown> | null;
  source_schema_fingerprint: string | null;
  destination_schema_fingerprint: string;
  session_token_hash: string | null;
  session_key_hash: string | null;
  session_key_encrypted: Record<string, unknown> | null;
  session_key_envelope: string | null;
  session_expires_at: Date | null;
  imported_family_id: string | null;
  created_at: Date;
  updated_at: Date;
  verified_at: Date | null;
  reserved_at: Date | null;
  import_started_at: Date | null;
  activated_at: Date | null;
  revoked_at: Date | null;
  failure_code: string | null;
  failure_message: string | null;
  import_manifest: Record<string, unknown> | null;
  import_report: Record<string, unknown> | null;
  activation_report: Record<string, unknown> | null;
  staging_path: string | null;
}

export interface CircleMigrationRecord {
  migration_id: string;
  family_id: string;
  destination_service_endpoint: string;
  destination_public_base_url: string;
  migration_slot_id: string;
  status: SourceMigrationStatus;
  started_by_identity_id: string;
  destination_server_id: string | null;
  data_scope_fingerprint: string;
  session_credentials_encrypted: Record<string, unknown> | null;
  session_expires_at: Date | null;
  preflight_summary: Record<string, unknown> | null;
  scheduled_at: Date | null;
  members_notified_at: Date | null;
  confirmed_data_loss: Record<string, unknown> | null;
  owner_signed_migration_intent: Record<string, unknown> | null;
  owner_signed_cutover_confirmation: Record<string, unknown> | null;
  manifest: Record<string, unknown> | null;
  export_snapshot_id: string | null;
  last_progress_at: Date | null;
  freeze_started_at: Date | null;
  export_started_at: Date | null;
  transfer_started_at: Date | null;
  cutover_started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  failure_code: string | null;
  failure_message: string | null;
}

export interface FamilyMigrationRedirectRecord {
  family_id: string;
  host: string;
  moved_to: string;
  source_server_id: string;
  destination_server_id: string;
  owner_identity_id: string;
  owner_public_key: Record<string, unknown>;
  owner_signed_migration_proof: Record<string, unknown>;
  migrated_at: Date;
  bridge_expires_at: Date;
  disabled_at: Date | null;
}

export interface CircleMigrationPreflightStats {
  counts: Record<string, number>;
  byteSizes: Record<string, number>;
  dataLossCounts: Record<string, number>;
  dataLossByteSizes: Record<string, number>;
  estimatedTransferBytes: number;
  excludedMessageCountByTargetTtl: number;
  memberIdentityCount: number;
  totalIdentityCount: number;
  publicSiteEnabled: boolean;
  publicGuestLinkCount: number;
}

export interface PendingCircleImportReport {
  familyId: string;
  importedRows: Record<string, number>;
  normalizedFields: string[];
}

async function findSlotForUpdate(client: PoolClient, migrationSlotId: string): Promise<MigrationSlotRecord | null> {
  const result = await client.query<MigrationSlotRecord>(
    `SELECT *
       FROM migration_slots
      WHERE migration_slot_id = $1
      FOR UPDATE`,
    [migrationSlotId]
  );
  return result.rows[0] || null;
}

async function findSourceMigrationForUpdate(
  client: PoolClient,
  migrationId: string
): Promise<CircleMigrationRecord | null> {
  const result = await client.query<CircleMigrationRecord>(
    `SELECT *
       FROM circle_migrations
      WHERE migration_id = $1
      FOR UPDATE`,
    [migrationId]
  );
  return result.rows[0] || null;
}

async function insertMigrationEvent(client: PoolClient, data: {
  migrationSlotId?: string | null;
  migrationId?: string | null;
  familyId?: string | null;
  eventType: string;
  actorType: 'server_admin' | 'circle_owner' | 'source_server' | 'destination_server' | 'system';
  actorId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO circle_migration_events (
       event_id,
       migration_slot_id,
       migration_id,
       family_id,
       event_type,
       actor_type,
       actor_id,
       payload
     ) VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8::jsonb)`,
    [
      createOpaqueClaimToken('mev'),
      data.migrationSlotId || null,
      data.migrationId || null,
      data.familyId || null,
      data.eventType,
      data.actorType,
      data.actorId || null,
      JSON.stringify(data.payload || {})
    ]
  );
}

class CircleMigrationRepository {
  async appendEvent(data: {
    migrationSlotId?: string | null;
    migrationId?: string | null;
    familyId?: string | null;
    eventType: string;
    actorType: 'server_admin' | 'circle_owner' | 'source_server' | 'destination_server' | 'system';
    actorId?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    if (!data.migrationSlotId && !data.migrationId) {
      throw new Error('Migration audit event requires a slot or source migration');
    }
    await transaction((client) => insertMigrationEvent(client, data));
  }

  async createSlot(data: {
    migrationSlotId: string;
    migrationCodeHash: string;
    migrationCodeEncrypted: Record<string, unknown>;
    destinationCircleId: string;
    targetPublicBaseUrl: string;
    targetHost: string;
    serviceEndpoint: string;
    serverName: string;
    createdByServerAdminId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expiresAt: Date;
    settings: Record<string, unknown>;
    limits: Record<string, unknown>;
    migrationFormatVersion: number;
    dataScopeFingerprint: string;
    destinationSchemaFingerprint: string;
    expectedFamilyId?: string | null;
    expectedOwnerIdentityId?: string | null;
  }): Promise<MigrationSlotRecord> {
    return transaction(async (client) => {
      const result = await client.query<MigrationSlotRecord>(
        `INSERT INTO migration_slots (
         migration_slot_id,
         migration_code_hash,
         migration_code_encrypted,
         destination_circle_id,
         target_public_base_url,
         target_host,
         service_endpoint,
         server_name,
         created_by_server_admin_id,
         idempotency_key,
         request_fingerprint,
         expires_at,
         settings,
         limits,
         migration_format_version,
         data_scope_fingerprint,
         destination_schema_fingerprint,
         expected_family_id,
         expected_owner_identity_id
       ) VALUES (
         $1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19
       )
         RETURNING *`,
        [
          data.migrationSlotId,
          data.migrationCodeHash,
          JSON.stringify(data.migrationCodeEncrypted),
          data.destinationCircleId,
          data.targetPublicBaseUrl,
          data.targetHost,
          data.serviceEndpoint,
          data.serverName,
          data.createdByServerAdminId,
          data.idempotencyKey,
          data.requestFingerprint,
          data.expiresAt,
          JSON.stringify(data.settings),
          JSON.stringify(data.limits),
          data.migrationFormatVersion,
          data.dataScopeFingerprint,
          data.destinationSchemaFingerprint,
          data.expectedFamilyId || null,
          data.expectedOwnerIdentityId || null
        ]
      );
      await insertMigrationEvent(client, {
        migrationSlotId: data.migrationSlotId,
        eventType: 'migration_slot_created',
        actorType: 'server_admin',
        actorId: data.createdByServerAdminId,
        payload: {
          targetPublicBaseUrl: data.targetPublicBaseUrl,
          expiresAt: data.expiresAt.toISOString(),
          requestFingerprint: data.requestFingerprint
        }
      });
      return result.rows[0]!;
    });
  }

  async findSlotById(migrationSlotId: string): Promise<MigrationSlotRecord | null> {
    const result = await pool.query<MigrationSlotRecord>(
      `SELECT * FROM migration_slots WHERE migration_slot_id = $1`,
      [migrationSlotId]
    );
    return result.rows[0] || null;
  }

  async findSlotByAdminIdempotency(
    serverAdminId: string,
    idempotencyKey: string
  ): Promise<MigrationSlotRecord | null> {
    const result = await pool.query<MigrationSlotRecord>(
      `SELECT *
         FROM migration_slots
        WHERE created_by_server_admin_id = $1
          AND idempotency_key = $2`,
      [serverAdminId, idempotencyKey]
    );
    return result.rows[0] || null;
  }

  async listSlots(limit = 100): Promise<MigrationSlotRecord[]> {
    const result = await pool.query<MigrationSlotRecord>(
      `SELECT *
         FROM migration_slots
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(limit, 500))]
    );
    return result.rows;
  }

  async updateSlotVerification(data: {
    migrationSlotId: string;
    expectedStatus: 'pending';
    expectedFamilyId: string;
    expectedOwnerIdentityId: string;
    sourceMigrationId: string;
    sourceServerId: string;
    sourceServerUrl: string;
    sourceCircleId: string;
    sourceSessionPublicKey: Record<string, unknown>;
    ownerIdentityPublicKey: Record<string, unknown>;
    sourceSchemaFingerprint: string;
    sessionTokenHash: string;
    sessionKeyHash: string;
    sessionKeyEncrypted: Record<string, unknown>;
    sessionKeyEnvelope: string;
    sessionExpiresAt: Date;
  }): Promise<MigrationSlotRecord | null> {
    return transaction(async (client) => {
      const current = await findSlotForUpdate(client, data.migrationSlotId);
      if (!current || current.status !== data.expectedStatus) return null;
      assertMigrationSlotTransition(current.status, 'verified');

      const result = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
            SET status = 'verified',
                migration_code_consumed_at = NOW(),
                expected_family_id = COALESCE(expected_family_id, $2::uuid),
                expected_owner_identity_id = COALESCE(expected_owner_identity_id, $3),
                source_migration_id = $4,
                source_server_id = $5,
                source_server_url = $6,
                source_circle_id = $7,
                source_session_public_key = $8::jsonb,
                owner_identity_public_key = $9::jsonb,
                source_schema_fingerprint = $10,
                session_token_hash = $11,
                session_key_hash = $12,
                session_key_encrypted = $13::jsonb,
                session_key_envelope = $14,
                session_expires_at = $15,
                verified_at = NOW(),
                updated_at = NOW()
          WHERE migration_slot_id = $1
            AND (expected_family_id IS NULL OR expected_family_id = $2::uuid)
            AND (expected_owner_identity_id IS NULL OR expected_owner_identity_id = $3)
          RETURNING *`,
        [
          data.migrationSlotId,
          data.expectedFamilyId,
          data.expectedOwnerIdentityId,
          data.sourceMigrationId,
          data.sourceServerId,
          data.sourceServerUrl,
          data.sourceCircleId,
          JSON.stringify(data.sourceSessionPublicKey),
          JSON.stringify(data.ownerIdentityPublicKey),
          data.sourceSchemaFingerprint,
          data.sessionTokenHash,
          data.sessionKeyHash,
          JSON.stringify(data.sessionKeyEncrypted),
          data.sessionKeyEnvelope,
          data.sessionExpiresAt
        ]
      );
      const updated = result.rows[0] || null;
      if (updated) {
        await insertMigrationEvent(client, {
          migrationSlotId: data.migrationSlotId,
          familyId: data.expectedFamilyId,
          eventType: 'migration_slot_verified',
          actorType: 'source_server',
          actorId: data.sourceServerId,
          payload: {
            sourceServerUrl: data.sourceServerUrl,
            sourceSchemaFingerprint: data.sourceSchemaFingerprint
          }
        });
      }
      return updated;
    });
  }

  async markSlotExpired(migrationSlotId: string): Promise<MigrationSlotRecord | null> {
    const result = await pool.query<MigrationSlotRecord>(
      `UPDATE migration_slots
          SET status = 'expired', updated_at = NOW()
        WHERE migration_slot_id = $1
          AND status IN ('pending', 'verified')
          AND expires_at <= NOW()
        RETURNING *`,
      [migrationSlotId]
    );
    return result.rows[0] || null;
  }

  async reserveSlot(data: {
    migrationSlotId: string;
    familyId: string;
    ownerSignedMigrationIntent: Record<string, unknown>;
  }): Promise<MigrationSlotRecord | null> {
    return transaction(async (client) => {
      const current = await findSlotForUpdate(client, data.migrationSlotId);
      if (!current || current.status !== 'verified' || current.expected_family_id !== data.familyId) return null;
      assertMigrationSlotTransition(current.status, 'reserved');
      const result = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
            SET status = 'reserved',
                owner_signed_migration_intent = $2::jsonb,
                reserved_at = NOW(),
                updated_at = NOW()
          WHERE migration_slot_id = $1
          RETURNING *`,
        [data.migrationSlotId, JSON.stringify(data.ownerSignedMigrationIntent)]
      );
      const reserved = result.rows[0] || null;
      if (reserved) {
        await insertMigrationEvent(client, {
          migrationSlotId: data.migrationSlotId,
          familyId: data.familyId,
          eventType: 'migration_slot_reserved',
          actorType: 'circle_owner',
          actorId: reserved.expected_owner_identity_id
        });
      }
      return reserved;
    });
  }

  async refreshSlotSession(data: {
    migrationSlotId: string;
    sessionTokenHash: string;
    sessionExpiresAt: Date;
  }): Promise<MigrationSlotRecord | null> {
    const result = await pool.query<MigrationSlotRecord>(
      `UPDATE migration_slots
          SET session_token_hash = $2,
              session_expires_at = $3,
              updated_at = NOW()
        WHERE migration_slot_id = $1
          AND status NOT IN ('revoked', 'expired')
          AND (
            expires_at > NOW()
            OR status NOT IN ('pending', 'verified')
          )
        RETURNING *`,
      [data.migrationSlotId, data.sessionTokenHash, data.sessionExpiresAt]
    );
    return result.rows[0] || null;
  }

  async startSlotImport(data: {
    migrationSlotId: string;
    manifest: Record<string, unknown>;
    stagingPath: string;
  }): Promise<MigrationSlotRecord | null> {
    assertMigrationSlotTransition('reserved', 'importing');
    return transaction(async (client) => {
      const current = await findSlotForUpdate(client, data.migrationSlotId);
      if (!current || current.status !== 'reserved') return null;
      const result = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
            SET status = 'importing',
                import_manifest = $2::jsonb,
                staging_path = $3,
                import_started_at = NOW(),
                updated_at = NOW(),
                failure_code = NULL,
                failure_message = NULL
          WHERE migration_slot_id = $1
            AND status = 'reserved'
          RETURNING *`,
        [data.migrationSlotId, JSON.stringify(data.manifest), data.stagingPath]
      );
      const importing = result.rows[0] || null;
      if (importing) {
        await insertMigrationEvent(client, {
          migrationSlotId: data.migrationSlotId,
          familyId: importing.expected_family_id,
          eventType: 'destination_import_started',
          actorType: 'source_server',
          actorId: importing.source_server_id,
          payload: {
            migrationId: importing.source_migration_id,
            stagingPath: data.stagingPath
          }
        });
      }
      return importing;
    });
  }

  async completeSlotStagingValidation(data: {
    migrationSlotId: string;
    importReport: Record<string, unknown>;
  }): Promise<MigrationSlotRecord | null> {
    assertMigrationSlotTransition('importing', 'imported');
    return transaction(async (client) => {
      const result = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
            SET status = 'imported',
                import_report = $2::jsonb,
                updated_at = NOW(),
                failure_code = NULL,
                failure_message = NULL
          WHERE migration_slot_id = $1
            AND status = 'importing'
          RETURNING *`,
        [data.migrationSlotId, JSON.stringify(data.importReport)]
      );
      const imported = result.rows[0] || null;
      if (imported) {
        await insertMigrationEvent(client, {
          migrationSlotId: data.migrationSlotId,
          familyId: imported.expected_family_id,
          eventType: 'destination_staging_validated',
          actorType: 'destination_server',
          actorId: getServerIdentityRuntimeConfig().vpsId,
          payload: data.importReport
        });
      }
      return imported;
    });
  }

  async applyPendingTenantImport(data: {
    migrationSlotId: string;
    familyId: string;
    importRows: (client: PoolClient) => Promise<PendingCircleImportReport>;
  }): Promise<MigrationSlotRecord | null> {
    assertMigrationSlotTransition('imported', 'waiting_cutover');
    return transaction(async (client) => {
      const current = await findSlotForUpdate(client, data.migrationSlotId);
      if (!current) return null;
      if (
        current.status === 'waiting_cutover'
        && current.imported_family_id === data.familyId
      ) {
        return current;
      }
      if (
        current.status !== 'imported'
        || current.expected_family_id !== data.familyId
        || current.imported_family_id !== null
      ) {
        return null;
      }

      const existingFamily = await client.query(
        `SELECT 1 FROM family_config WHERE family_id = $1::uuid LIMIT 1`,
        [data.familyId]
      );
      if (existingFamily.rowCount) {
        throw Object.assign(
          new Error('Circle already exists on destination'),
          { code: 'MIGRATION_FAMILY_CONFLICT' }
        );
      }
      const report = await data.importRows(client);
      if (report.familyId !== data.familyId) {
        throw new Error('Pending import report belongs to another Circle');
      }
      const combinedReport = {
        ...(current.import_report || {}),
        status: 'pending_import_created',
        pendingImportCreatedAt: new Date().toISOString(),
        importedRows: report.importedRows,
        normalizedFields: report.normalizedFields
      };
      const result = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
            SET status = 'waiting_cutover',
                imported_family_id = $2::uuid,
                import_report = $3::jsonb,
                updated_at = NOW(),
                failure_code = NULL,
                failure_message = NULL
          WHERE migration_slot_id = $1
            AND status = 'imported'
            AND imported_family_id IS NULL
          RETURNING *`,
        [
          data.migrationSlotId,
          data.familyId,
          JSON.stringify(combinedReport)
        ]
      );
      const waiting = result.rows[0] || null;
      if (waiting) {
        await insertMigrationEvent(client, {
          migrationSlotId: data.migrationSlotId,
          familyId: data.familyId,
          eventType: 'destination_pending_import_created',
          actorType: 'destination_server',
          actorId: getServerIdentityRuntimeConfig().vpsId,
          payload: combinedReport
        });
      }
      return waiting;
    });
  }

  async beginSlotActivation(data: {
    migrationSlotId: string;
    ownerSignedCutoverConfirmation: Record<string, unknown>;
  }): Promise<MigrationSlotRecord | null> {
    return transaction(async (client) => {
      const current = await findSlotForUpdate(client, data.migrationSlotId);
      if (!current) return null;
      if (current.status === 'activating') return current;
      if (
        (current.status !== 'waiting_cutover' && current.status !== 'failed')
        || !current.imported_family_id
      ) {
        return null;
      }
      assertMigrationSlotTransition(current.status, 'activating');
      const result = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
            SET status = 'activating',
                owner_signed_cutover_confirmation = $2::jsonb,
                updated_at = NOW(),
                failure_code = NULL,
                failure_message = NULL
          WHERE migration_slot_id = $1
            AND status = $3
          RETURNING *`,
        [
          data.migrationSlotId,
          JSON.stringify(data.ownerSignedCutoverConfirmation),
          current.status
        ]
      );
      const activating = result.rows[0] || null;
      if (activating) {
        await insertMigrationEvent(client, {
          migrationSlotId: data.migrationSlotId,
          familyId: activating.imported_family_id,
          eventType: 'destination_activation_started',
          actorType: 'circle_owner',
          actorId: activating.expected_owner_identity_id
        });
      }
      return activating;
    });
  }

  async completeSlotActivation(data: {
    migrationSlotId: string;
    familyId: string;
    activationReport: Record<string, unknown>;
  }): Promise<MigrationSlotRecord | null> {
    assertMigrationSlotTransition('activating', 'active');
    return transaction(async (client) => {
      const current = await findSlotForUpdate(client, data.migrationSlotId);
      if (
        !current
        || current.status !== 'activating'
        || current.imported_family_id !== data.familyId
      ) {
        return null;
      }
      const config = await client.query(
        `UPDATE family_config
            SET status = 'active',
                updated_at = NOW()
          WHERE family_id = $1::uuid
            AND status = 'pending_import'`,
        [data.familyId]
      );
      const domain = await client.query(
        `UPDATE family_domains
            SET status = 'active',
                role = 'primary',
                is_current = true,
                verified_at = NOW(),
                disabled_at = NULL
          WHERE family_id = $1::uuid
            AND host = $2
            AND status = 'pending_verification'`,
        [data.familyId, current.target_host]
      );
      if (config.rowCount !== 1 || domain.rowCount !== 1) {
        throw new Error('Pending Circle or target domain is missing during activation');
      }
      const result = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
            SET status = 'active',
                activation_report = $2::jsonb,
                activated_at = NOW(),
                updated_at = NOW(),
                failure_code = NULL,
                failure_message = NULL
          WHERE migration_slot_id = $1
            AND status = 'activating'
          RETURNING *`,
        [data.migrationSlotId, JSON.stringify(data.activationReport)]
      );
      const active = result.rows[0] || null;
      if (active) {
        await insertMigrationEvent(client, {
          migrationSlotId: data.migrationSlotId,
          familyId: data.familyId,
          eventType: 'destination_import_activated',
          actorType: 'destination_server',
          actorId: getServerIdentityRuntimeConfig().vpsId,
          payload: data.activationReport
        });
      }
      return active;
    });
  }

  async abortSlotImport(data: {
    migrationSlotId: string;
    reason: string;
  }): Promise<MigrationSlotRecord | null> {
    return transaction(async (client) => {
      const current = await findSlotForUpdate(client, data.migrationSlotId);
      if (!current) return null;
      if (current.status === 'aborted') return current;
      if (
        !['verified', 'reserved', 'importing', 'imported', 'waiting_cutover', 'failed'].includes(current.status)
      ) {
        return null;
      }
      assertMigrationSlotTransition(current.status, 'aborted');
      const familyId = current.imported_family_id;
      if (familyId) {
        const pending = await client.query<{ status: string }>(
          `SELECT status
             FROM family_config
            WHERE family_id = $1::uuid
            FOR UPDATE`,
          [familyId]
        );
        if (pending.rows[0]?.status !== 'pending_import') {
          throw new Error('Destination Circle is no longer safe to abort');
        }
        for (const table of [...CIRCLE_MIGRATION_V2_EXPORT_TABLES].reverse()) {
          if (table === 'family_config') continue;
          // table comes exclusively from the closed migration contract.
          await client.query(`DELETE FROM ${table} WHERE family_id::text = $1`, [familyId]);
        }
        await client.query(`DELETE FROM family_domains WHERE family_id = $1::uuid`, [familyId]);
        await client.query(
          `DELETE FROM family_config
            WHERE family_id = $1::uuid
              AND status = 'pending_import'`,
          [familyId]
        );
      }
      const result = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
            SET status = 'aborted',
                updated_at = NOW(),
                failure_code = 'MIGRATION_ABORTED',
                failure_message = $2
          WHERE migration_slot_id = $1
            AND status = $3
          RETURNING *`,
        [data.migrationSlotId, data.reason.slice(0, 500), current.status]
      );
      const aborted = result.rows[0] || null;
      if (aborted) {
        await insertMigrationEvent(client, {
          migrationSlotId: data.migrationSlotId,
          familyId: familyId || current.expected_family_id,
          eventType: 'destination_import_aborted',
          actorType: 'source_server',
          actorId: current.source_server_id,
          payload: { reason: data.reason.slice(0, 500) }
        });
      }
      return aborted;
    });
  }

  async transitionSlot(
    migrationSlotId: string,
    expectedStatus: MigrationSlotStatus,
    nextStatus: MigrationSlotStatus,
    failure?: { code: string; message: string } | null
  ): Promise<MigrationSlotRecord | null> {
    assertMigrationSlotTransition(expectedStatus, nextStatus);
    return transaction(async (client) => {
      const result = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
          SET status = $3,
              updated_at = NOW(),
              revoked_at = CASE WHEN $3 = 'revoked' THEN NOW() ELSE revoked_at END,
              activated_at = CASE WHEN $3 = 'active' THEN NOW() ELSE activated_at END,
              failure_code = $4,
              failure_message = $5
        WHERE migration_slot_id = $1
          AND status = $2
         RETURNING *`,
        [migrationSlotId, expectedStatus, nextStatus, failure?.code || null, failure?.message || null]
      );
      const transitioned = result.rows[0] || null;
      if (transitioned) {
        await insertMigrationEvent(client, {
          migrationSlotId,
          familyId: transitioned.expected_family_id,
          eventType: 'migration_slot_status_changed',
          actorType: 'system',
          payload: {
            from: expectedStatus,
            to: nextStatus,
            failureCode: failure?.code || null
          }
        });
      }
      return transitioned;
    });
  }

  async createSourceMigration(data: {
    migrationId: string;
    familyId: string;
    destinationServiceEndpoint: string;
    destinationPublicBaseUrl: string;
    migrationSlotId: string;
    startedByIdentityId: string;
    dataScopeFingerprint: string;
    sessionCredentialsEncrypted: Record<string, unknown>;
  }): Promise<CircleMigrationRecord> {
    return transaction(async (client) => {
      const result = await client.query<CircleMigrationRecord>(
        `INSERT INTO circle_migrations (
         migration_id,
         family_id,
         destination_service_endpoint,
         destination_public_base_url,
         migration_slot_id,
         started_by_identity_id,
         data_scope_fingerprint,
         session_credentials_encrypted,
         last_progress_at
       ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, NOW())
         RETURNING *`,
        [
          data.migrationId,
          data.familyId,
          data.destinationServiceEndpoint,
          data.destinationPublicBaseUrl,
          data.migrationSlotId,
          data.startedByIdentityId,
          data.dataScopeFingerprint,
          JSON.stringify(data.sessionCredentialsEncrypted)
        ]
      );
      await insertMigrationEvent(client, {
        migrationId: data.migrationId,
        familyId: data.familyId,
        eventType: 'source_migration_created',
        actorType: 'circle_owner',
        actorId: data.startedByIdentityId,
        payload: {
          migrationSlotId: data.migrationSlotId,
          destinationServiceEndpoint: data.destinationServiceEndpoint,
          destinationPublicBaseUrl: data.destinationPublicBaseUrl
        }
      });
      return result.rows[0]!;
    });
  }

  async findSourceMigration(migrationId: string): Promise<CircleMigrationRecord | null> {
    const result = await pool.query<CircleMigrationRecord>(
      `SELECT * FROM circle_migrations WHERE migration_id = $1`,
      [migrationId]
    );
    return result.rows[0] || null;
  }

  async findOpenSourceMigrationByFamily(familyId: string): Promise<CircleMigrationRecord | null> {
    const result = await pool.query<CircleMigrationRecord>(
      `SELECT *
         FROM circle_migrations
        WHERE family_id = $1::uuid
          AND status NOT IN ('migrated', 'aborted')
        ORDER BY created_at DESC
        LIMIT 1`,
      [familyId]
    );
    return result.rows[0] || null;
  }

  async findFrozenSourceMigrationByFamily(familyId: string): Promise<CircleMigrationRecord | null> {
    const result = await pool.query<CircleMigrationRecord>(
      `SELECT *
         FROM circle_migrations
        WHERE family_id = $1::uuid
          AND freeze_started_at IS NOT NULL
          AND status NOT IN ('migrated', 'aborted')
        ORDER BY freeze_started_at DESC
        LIMIT 1`,
      [familyId]
    );
    return result.rows[0] || null;
  }

  async completeSourcePreflight(data: {
    migrationId: string;
    expectedStatus: 'preflight';
    destinationServerId: string;
    destinationPublicBaseUrl: string;
    sessionCredentialsEncrypted: Record<string, unknown>;
    sessionExpiresAt: Date;
    preflightSummary: Record<string, unknown>;
  }): Promise<CircleMigrationRecord | null> {
    assertSourceMigrationTransition(data.expectedStatus, 'ready');
    return transaction(async (client) => {
      const result = await client.query<CircleMigrationRecord>(
        `UPDATE circle_migrations
          SET status = 'ready',
              destination_server_id = $3,
              destination_public_base_url = $4,
              session_credentials_encrypted = $5::jsonb,
              session_expires_at = $6,
              preflight_summary = $7::jsonb,
              last_progress_at = NOW(),
              updated_at = NOW(),
              failure_code = NULL,
              failure_message = NULL
        WHERE migration_id = $1
          AND status = $2
         RETURNING *`,
        [
          data.migrationId,
          data.expectedStatus,
          data.destinationServerId,
          data.destinationPublicBaseUrl,
          JSON.stringify(data.sessionCredentialsEncrypted),
          data.sessionExpiresAt,
          JSON.stringify(data.preflightSummary)
        ]
      );
      const completed = result.rows[0] || null;
      if (completed) {
        await insertMigrationEvent(client, {
          migrationId: data.migrationId,
          familyId: completed.family_id,
          eventType: 'migration_preflight_completed',
          actorType: 'source_server',
          actorId: getServerIdentityRuntimeConfig().vpsId,
          payload: data.preflightSummary
        });
      }
      return completed;
    });
  }

  async scheduleSourceMigration(data: {
    migrationId: string;
    familyId: string;
    ownerIdentityId: string;
    scheduledAt: Date;
    confirmedDataLoss: Record<string, unknown>;
    ownerSignedMigrationIntent: Record<string, unknown>;
    destinationPublicBaseUrl: string;
    sessionCredentialsEncrypted: Record<string, unknown>;
    sessionExpiresAt: Date;
  }): Promise<CircleMigrationRecord | null> {
    assertSourceMigrationTransition('ready', 'scheduled');
    return transaction(async (client) => {
      const result = await client.query<CircleMigrationRecord>(
        `UPDATE circle_migrations
            SET status = 'scheduled',
                scheduled_at = $3,
                members_notified_at = NOW(),
                confirmed_data_loss = $4::jsonb,
                owner_signed_migration_intent = $5::jsonb,
                session_credentials_encrypted = $6::jsonb,
                session_expires_at = $7,
                last_progress_at = NOW(),
                updated_at = NOW(),
                failure_code = NULL,
                failure_message = NULL
          WHERE migration_id = $1
            AND family_id = $2::uuid
            AND status = 'ready'
          RETURNING *`,
        [
          data.migrationId,
          data.familyId,
          data.scheduledAt,
          JSON.stringify(data.confirmedDataLoss),
          JSON.stringify(data.ownerSignedMigrationIntent),
          JSON.stringify(data.sessionCredentialsEncrypted),
          data.sessionExpiresAt
        ]
      );
      const scheduled = result.rows[0] || null;
      if (!scheduled) return null;
      const circleConfig = await client.query<{ circle_id: string }>(
        'SELECT circle_id FROM family_config WHERE family_id = $1',
        [data.familyId]
      );
      const circleId = circleConfig.rows[0]?.circle_id;
      if (!circleId) throw new Error('Circle identity is not configured');

      await client.query(
        `INSERT INTO system_events (
           event_id,
           family_id,
           recipient_identity_id,
           circle_id,
           type,
           payload,
           created_at
         )
         SELECT 'sev_migration_' || REPLACE(gen_random_uuid()::text, '-', ''),
                $1::uuid,
                identity_id,
                $2,
                'circle:migration:scheduled',
                jsonb_build_object(
                  'migrationId', $3,
                  'scheduledAt', $4::text,
                  'destinationPublicBaseUrl', $5
                ),
                $6::bigint
           FROM identities
          WHERE family_id = $1::uuid
            AND status = 'active'`,
        [
          data.familyId,
          circleId,
          data.migrationId,
          data.scheduledAt.toISOString(),
          data.destinationPublicBaseUrl,
          Date.now()
        ]
      );
      await insertMigrationEvent(client, {
        migrationId: data.migrationId,
        familyId: data.familyId,
        eventType: 'source_migration_scheduled',
        actorType: 'circle_owner',
        actorId: data.ownerIdentityId,
        payload: {
          scheduledAt: data.scheduledAt.toISOString(),
          destinationPublicBaseUrl: data.destinationPublicBaseUrl
        }
      });
      return scheduled;
    });
  }

  async updateSourceSessionCredentials(data: {
    migrationId: string;
    sessionCredentialsEncrypted: Record<string, unknown>;
    sessionExpiresAt: Date;
  }): Promise<CircleMigrationRecord | null> {
    const result = await pool.query<CircleMigrationRecord>(
      `UPDATE circle_migrations
          SET session_credentials_encrypted = $2::jsonb,
              session_expires_at = $3,
              last_progress_at = NOW(),
              updated_at = NOW()
        WHERE migration_id = $1
          AND status NOT IN ('migrated', 'aborted')
        RETURNING *`,
      [
        data.migrationId,
        JSON.stringify(data.sessionCredentialsEncrypted),
        data.sessionExpiresAt
      ]
    );
    return result.rows[0] || null;
  }

  async collectSourcePreflightStats(
    familyId: string,
    targetMessageTtlHours: number
  ): Promise<CircleMigrationPreflightStats> {
    const transferTables = [
      ...CIRCLE_MIGRATION_V2_TABLE_CONTRACT.copy,
      ...CIRCLE_MIGRATION_V2_TABLE_CONTRACT.transform
    ];
    const lossTables = [...CIRCLE_MIGRATION_V2_TABLE_CONTRACT.drop];
    const requestedTables = Array.from(new Set([...transferTables, ...lossTables]));
    const available = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'family_id'
          AND table_name = ANY($1::text[])`,
      [requestedTables]
    );
    const availableTables = new Set(available.rows.map((row) => row.table_name));

    const countTable = async (tableName: string): Promise<{ count: number; bytes: number }> => {
      if (!availableTables.has(tableName)) return { count: 0, bytes: 0 };
      // tableName comes exclusively from the closed, versioned contract above.
      const result = await pool.query<{ count: number; bytes: number }>(
        `SELECT COUNT(*)::bigint AS count,
                COALESCE(SUM(pg_column_size(row_data)), 0)::bigint AS bytes
           FROM ${tableName} AS row_data
          WHERE family_id::text = $1`,
        [familyId]
      );
      return {
        count: Number(result.rows[0]?.count || 0),
        bytes: Number(result.rows[0]?.bytes || 0)
      };
    };

    const [transferRows, lossRows, identityCounts, ttlExcluded, siteState] = await Promise.all([
      Promise.all(transferTables.map(async (table) => [table, await countTable(table)] as const)),
      Promise.all(lossTables.map(async (table) => [table, await countTable(table)] as const)),
      pool.query<{ member_count: number; total_count: number }>(
        `SELECT COUNT(*) FILTER (WHERE role IN ('owner', 'member'))::bigint AS member_count,
                COUNT(*)::bigint AS total_count
           FROM identities
          WHERE family_id = $1::uuid`,
        [familyId]
      ),
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::bigint AS count
           FROM messages
          WHERE family_id = $1::uuid
            AND created_at < $2::bigint`,
        [familyId, Date.now() - targetMessageTtlHours * 60 * 60 * 1000]
      ),
      pool.query<{ enabled: boolean; public_link_count: number }>(
        `SELECT COALESCE(
                  (SELECT enabled FROM circle_site_settings WHERE family_id = $1::uuid),
                  FALSE
                ) AS enabled,
                (SELECT COUNT(*)::bigint
                   FROM direct_guest_links
                  WHERE family_id = $1::uuid
                    AND public_site_visible = TRUE) AS public_link_count`,
        [familyId]
      )
    ]);

    const counts: Record<string, number> = {};
    const byteSizes: Record<string, number> = {};
    const dataLossCounts: Record<string, number> = {};
    const dataLossByteSizes: Record<string, number> = {};
    for (const [table, stats] of transferRows) {
      counts[table] = stats.count;
      byteSizes[table] = stats.bytes;
    }
    for (const [table, stats] of lossRows) {
      if (stats.count > 0 || stats.bytes > 0) {
        dataLossCounts[table] = stats.count;
        dataLossByteSizes[table] = stats.bytes;
      }
    }

    return {
      counts,
      byteSizes,
      dataLossCounts,
      dataLossByteSizes,
      estimatedTransferBytes: Object.values(byteSizes).reduce((sum, value) => sum + value, 0),
      excludedMessageCountByTargetTtl: Number(ttlExcluded.rows[0]?.count || 0),
      memberIdentityCount: Number(identityCounts.rows[0]?.member_count || 0),
      totalIdentityCount: Number(identityCounts.rows[0]?.total_count || 0),
      publicSiteEnabled: siteState.rows[0]?.enabled === true,
      publicGuestLinkCount: Number(siteState.rows[0]?.public_link_count || 0)
    };
  }

  async transitionSourceMigration(
    migrationId: string,
    expectedStatus: SourceMigrationStatus,
    nextStatus: SourceMigrationStatus,
    failure?: { code: string; message: string } | null
  ): Promise<CircleMigrationRecord | null> {
    assertSourceMigrationTransition(expectedStatus, nextStatus);
    return transaction(async (client) => {
      const result = await client.query<CircleMigrationRecord>(
        `UPDATE circle_migrations
          SET status = $3,
              last_progress_at = NOW(),
              updated_at = NOW(),
              freeze_started_at = CASE WHEN $3 = 'freezing' THEN COALESCE(freeze_started_at, NOW()) ELSE freeze_started_at END,
              export_started_at = CASE WHEN $3 = 'exporting' THEN COALESCE(export_started_at, NOW()) ELSE export_started_at END,
              transfer_started_at = CASE WHEN $3 = 'transferring' THEN COALESCE(transfer_started_at, NOW()) ELSE transfer_started_at END,
              cutover_started_at = CASE WHEN $3 = 'cutover' THEN COALESCE(cutover_started_at, NOW()) ELSE cutover_started_at END,
              completed_at = CASE WHEN $3 IN ('migrated', 'aborted') THEN NOW() ELSE completed_at END,
              failure_code = $4,
              failure_message = $5
        WHERE migration_id = $1
          AND status = $2
         RETURNING *`,
        [migrationId, expectedStatus, nextStatus, failure?.code || null, failure?.message || null]
      );
      const transitioned = result.rows[0] || null;
      if (transitioned) {
        await insertMigrationEvent(client, {
          migrationId,
          familyId: transitioned.family_id,
          eventType: 'source_migration_status_changed',
          actorType: 'system',
          payload: {
            from: expectedStatus,
            to: nextStatus,
            failureCode: failure?.code || null
          }
        });
      }
      return transitioned;
    });
  }

  async beginSourceCutover(data: {
    migrationId: string;
    ownerSignedCutoverConfirmation: Record<string, unknown>;
  }): Promise<CircleMigrationRecord | null> {
    return transaction(async (client) => {
      const current = await findSourceMigrationForUpdate(client, data.migrationId);
      if (!current) return null;
      if (current.status === 'cutover') return current;
      if (
        (current.status !== 'waiting_cutover' && current.status !== 'failed')
        || !current.freeze_started_at
        || !current.manifest
      ) {
        return null;
      }
      assertSourceMigrationTransition(current.status, 'cutover');
      const result = await client.query<CircleMigrationRecord>(
        `UPDATE circle_migrations
            SET status = 'cutover',
                owner_signed_cutover_confirmation = $2::jsonb,
                cutover_started_at = COALESCE(cutover_started_at, NOW()),
                last_progress_at = NOW(),
                updated_at = NOW(),
                failure_code = NULL,
                failure_message = NULL
          WHERE migration_id = $1
            AND status = $3
          RETURNING *`,
        [
          data.migrationId,
          JSON.stringify(data.ownerSignedCutoverConfirmation),
          current.status
        ]
      );
      const cutover = result.rows[0] || null;
      if (cutover) {
        await insertMigrationEvent(client, {
          migrationId: data.migrationId,
          familyId: cutover.family_id,
          eventType: 'source_cutover_started',
          actorType: 'circle_owner',
          actorId: cutover.started_by_identity_id
        });
      }
      return cutover;
    });
  }

  async completeSourceCutover(data: {
    migrationId: string;
    familyId: string;
    oldHost: string;
    targetPublicBaseUrl: string;
    sourceServerId: string;
    destinationServerId: string;
    ownerIdentityId: string;
    ownerPublicKey: Record<string, unknown>;
    ownerSignedMigrationProof: Record<string, unknown>;
    movedAt: Date;
    bridgeExpiresAt: Date;
  }): Promise<CircleMigrationRecord | null> {
    assertSourceMigrationTransition('cutover', 'migrated');
    return transaction(async (client) => {
      const current = await findSourceMigrationForUpdate(client, data.migrationId);
      if (!current) return null;
      if (current.status === 'migrated') return current;
      if (
        current.status !== 'cutover'
        || current.family_id !== data.familyId
        || current.destination_server_id !== data.destinationServerId
      ) {
        return null;
      }
      await client.query(
        `INSERT INTO family_migration_redirects (
           family_id,
           host,
           moved_to,
           source_server_id,
           destination_server_id,
           owner_identity_id,
           owner_public_key,
           owner_signed_migration_proof,
           migrated_at,
           bridge_expires_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10
         )
         ON CONFLICT (family_id) DO UPDATE
           SET host = EXCLUDED.host,
               moved_to = EXCLUDED.moved_to,
               source_server_id = EXCLUDED.source_server_id,
               destination_server_id = EXCLUDED.destination_server_id,
               owner_identity_id = EXCLUDED.owner_identity_id,
               owner_public_key = EXCLUDED.owner_public_key,
               owner_signed_migration_proof = EXCLUDED.owner_signed_migration_proof,
               migrated_at = EXCLUDED.migrated_at,
               bridge_expires_at = EXCLUDED.bridge_expires_at,
               disabled_at = NULL,
               updated_at = NOW()`,
        [
          data.familyId,
          data.oldHost,
          data.targetPublicBaseUrl,
          data.sourceServerId,
          data.destinationServerId,
          data.ownerIdentityId,
          JSON.stringify(data.ownerPublicKey),
          JSON.stringify(data.ownerSignedMigrationProof),
          data.movedAt,
          data.bridgeExpiresAt
        ]
      );
      const disabled = await client.query(
        `UPDATE family_domains
            SET status = 'disabled',
                is_current = false,
                disabled_at = NOW()
          WHERE family_id = $1::uuid
            AND host = $2
            AND status = 'active'`,
        [data.familyId, data.oldHost]
      );
      if (disabled.rowCount !== 1) {
        throw new Error('Source primary domain is missing during cutover');
      }
      const result = await client.query<CircleMigrationRecord>(
        `UPDATE circle_migrations
            SET status = 'migrated',
                completed_at = NOW(),
                last_progress_at = NOW(),
                updated_at = NOW(),
                failure_code = NULL,
                failure_message = NULL
          WHERE migration_id = $1
            AND status = 'cutover'
          RETURNING *`,
        [data.migrationId]
      );
      const migrated = result.rows[0] || null;
      if (migrated) {
        await insertMigrationEvent(client, {
          migrationId: data.migrationId,
          familyId: data.familyId,
          eventType: 'source_migration_completed',
          actorType: 'source_server',
          actorId: data.sourceServerId,
          payload: {
            targetPublicBaseUrl: data.targetPublicBaseUrl,
            bridgeExpiresAt: data.bridgeExpiresAt.toISOString()
          }
        });
      }
      return migrated;
    });
  }

  async completeSourceExport(data: {
    migrationId: string;
    snapshotId: string;
    manifest: Record<string, unknown>;
  }): Promise<CircleMigrationRecord | null> {
    assertSourceMigrationTransition('exporting', 'transferring');
    return transaction(async (client) => {
      const result = await client.query<CircleMigrationRecord>(
        `UPDATE circle_migrations
            SET status = 'transferring',
                export_snapshot_id = $3,
                manifest = $4::jsonb,
                transfer_started_at = NOW(),
                last_progress_at = NOW(),
                updated_at = NOW(),
                failure_code = NULL,
                failure_message = NULL
          WHERE migration_id = $1
            AND status = $2
          RETURNING *`,
        [
          data.migrationId,
          'exporting',
          data.snapshotId,
          JSON.stringify(data.manifest)
        ]
      );
      const completed = result.rows[0] || null;
      if (completed) {
        await insertMigrationEvent(client, {
          migrationId: data.migrationId,
          familyId: completed.family_id,
          eventType: 'source_export_completed',
          actorType: 'source_server',
          actorId: getServerIdentityRuntimeConfig().vpsId,
          payload: {
            snapshotId: data.snapshotId,
            counts: data.manifest.counts || {},
            checksums: data.manifest.checksums || {}
          }
        });
      }
      return completed;
    });
  }

  async findActiveRedirectByHost(host: string): Promise<FamilyMigrationRedirectRecord | null> {
    const result = await pool.query<FamilyMigrationRedirectRecord>(
      `SELECT *
         FROM family_migration_redirects
        WHERE host = $1
          AND disabled_at IS NULL
          AND bridge_expires_at > NOW()`,
      [host]
    );
    return result.rows[0] || null;
  }

  async findStaleAbortableSourceMigrations(staleBefore: Date): Promise<CircleMigrationRecord[]> {
    const result = await pool.query<CircleMigrationRecord>(
      `SELECT *
         FROM circle_migrations
        WHERE status IN (
          'freezing', 'frozen', 'exporting', 'transferring',
          'waiting_import', 'waiting_cutover', 'failed'
        )
          AND freeze_started_at IS NOT NULL
          AND owner_signed_cutover_confirmation IS NULL
          AND COALESCE(last_progress_at, freeze_started_at, updated_at) < $1
        ORDER BY COALESCE(last_progress_at, freeze_started_at, updated_at) ASC`,
      [staleBefore]
    );
    return result.rows;
  }

  async hasAnyFrozenSourceMigrations(): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1
         FROM circle_migrations
        WHERE status IN (
          'freezing', 'frozen', 'exporting', 'transferring',
          'waiting_import', 'waiting_cutover', 'cutover', 'failed'
        )
          AND freeze_started_at IS NOT NULL
        LIMIT 1`
    );
    return Boolean(result.rowCount);
  }

  async expireUnusedSlots(now: Date): Promise<number> {
    return transaction(async (client) => {
      const expired = await client.query<MigrationSlotRecord>(
        `UPDATE migration_slots
            SET status = 'expired',
                updated_at = NOW(),
                failure_code = 'MIGRATION_SLOT_EXPIRED',
                failure_message = 'Migration slot expired before reservation'
          WHERE status IN ('pending', 'verified')
            AND expires_at <= $1
          RETURNING *`,
        [now]
      );
      for (const slot of expired.rows) {
        await insertMigrationEvent(client, {
          migrationSlotId: slot.migration_slot_id,
          familyId: slot.expected_family_id,
          eventType: 'migration_slot_status_changed',
          actorType: 'system',
          payload: { from: slot.status === 'expired' ? 'pending_or_verified' : slot.status, to: 'expired' }
        });
      }
      return expired.rowCount || 0;
    });
  }
}

export const circleMigrationRepository = new CircleMigrationRepository();
