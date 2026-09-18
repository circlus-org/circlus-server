import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import type { PoolClient } from 'pg';
import { getClient } from '../db';
import {
  getCircleMigrationRuntimeConfig,
  getServerIdentityRuntimeConfig
} from '../config/serverRuntimeConfig';
import type { CircleMigrationRecord } from '../db/repositories/circleMigrationRepository';
import {
  canonicalizeCircleMigrationJson,
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FIXED_SCOPES,
  CIRCLE_MIGRATION_FORMAT,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
  CIRCLE_MIGRATION_V2_EXPORT_TABLES
} from './circleMigrationContract';
import { FIXED_DATA_LOSS_POLICY } from './circleMigrationScheduleService';

const EXPORT_BATCH_SIZE = 500;
const SAFE_MIGRATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES = 128 * 1024;

export interface CircleMigrationExportManifest extends Record<string, unknown> {
  format: typeof CIRCLE_MIGRATION_FORMAT;
  migrationFormatVersion: typeof CIRCLE_MIGRATION_FORMAT_VERSION;
  sourceSchemaFingerprint: string;
  destinationSchemaFingerprint: string;
  dataScopeFingerprint: string;
  migrationId: string;
  migrationSlotId: string;
  familyId: string;
  sourceServerId: string;
  destinationServerId: string;
  sourceCircleId: string;
  destinationCircleId: string;
  sourceServerUrl: string;
  destinationServiceEndpoint: string;
  oldPublicBaseUrl: string;
  targetPublicBaseUrl: string;
  createdAt: string;
  snapshot: {
    id: string;
    startedAt: string;
    isolation: 'repeatable_read_after_write_freeze';
  };
  dataScopes: readonly string[];
  dataLossPolicy: typeof FIXED_DATA_LOSS_POLICY;
  configAdjustments: Record<string, unknown>;
  excludedMessageCountByTargetTtl: number;
  counts: Record<string, number>;
  byteSizes: Record<string, number>;
  tableExports: Array<{
    table: string;
    path: string;
    rowCount: number;
    byteSize: number;
    checksum: string;
    chunkCount: number;
  }>;
  checksums: Record<string, string>;
  encryption: {
    algorithm: 'xchacha20-poly1305';
    keyId: string;
    chunkBytes: number;
  };
  ownerSignedMigrationIntent: Record<string, unknown>;
}

function exportRoot(): string {
  return getCircleMigrationRuntimeConfig().exportDir;
}

export function getCircleMigrationExportDirectory(migrationId: string): string {
  if (!SAFE_MIGRATION_ID.test(migrationId)) {
    throw new Error('Unsafe migration id for export path');
  }
  return path.join(exportRoot(), migrationId, 'export');
}

export async function removeCircleMigrationExport(migrationId: string): Promise<void> {
  const directory = getCircleMigrationExportDirectory(migrationId);
  await fs.promises.rm(path.dirname(directory), { recursive: true, force: true });
}

function tableExportSql(table: string, targetMessageCutoff: number): string {
  if (table === 'identities') {
    return `
      SELECT (
        to_jsonb(row_data)
        || jsonb_build_object('avatar_blob_id', NULL, 'avatar_updated_at', NULL)
      )::text AS row_json
        FROM identities AS row_data
       WHERE family_id = $1::uuid
       ORDER BY (
         to_jsonb(row_data)
         || jsonb_build_object('avatar_blob_id', NULL, 'avatar_updated_at', NULL)
       )::text`;
  }
  if (table === 'message_reaction_states') {
    return `SELECT to_jsonb(row_data)::text AS row_json FROM message_reaction_states AS row_data
      WHERE family_id=$1::uuid AND (scope='group' OR EXISTS (
        SELECT 1 FROM messages m WHERE m.server_message_id=row_data.direct_message_id
          AND m.created_at >= ${Math.floor(targetMessageCutoff)}))
      ORDER BY to_jsonb(row_data)::text`;
  }
  if (table === 'messages') {
    return `
      SELECT to_jsonb(row_data)::text AS row_json
        FROM messages AS row_data
       WHERE family_id = $1::uuid
         AND created_at >= ${Math.floor(targetMessageCutoff)}
       ORDER BY to_jsonb(row_data)::text`;
  }

  return `
    SELECT to_jsonb(row_data)::text AS row_json
      FROM ${table} AS row_data
     WHERE family_id::text = $1
     ORDER BY to_jsonb(row_data)::text`;
}

async function assertExportTables(client: PoolClient): Promise<void> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'family_id'
        AND table_name = ANY($1::text[])`,
    [[...CIRCLE_MIGRATION_V2_EXPORT_TABLES]]
  );
  const available = new Set(result.rows.map((row) => row.table_name));
  const missing = CIRCLE_MIGRATION_V2_EXPORT_TABLES.filter((table) => !available.has(table));
  if (missing.length > 0) {
    throw new Error(`Migration export schema is missing tables: ${missing.join(', ')}`);
  }
}

async function exportTable(params: {
  client: PoolClient;
  table: string;
  cursorIndex: number;
  familyId: string;
  targetMessageCutoff: number;
  outputPath: string;
}): Promise<{ rowCount: number; byteSize: number; checksum: string }> {
  const cursorName = `circle_migration_export_${params.cursorIndex}`;
  await params.client.query(
    `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${tableExportSql(params.table, params.targetMessageCutoff)}`,
    [params.familyId]
  );
  const stream = fs.createWriteStream(params.outputPath, {
    encoding: 'utf8',
    flags: 'wx',
    mode: 0o600
  });
  const hash = crypto.createHash('sha256');
  let rowCount = 0;
  let byteSize = 0;
  try {
    while (true) {
      const batch = await params.client.query<{ row_json: string }>(
        `FETCH FORWARD ${EXPORT_BATCH_SIZE} FROM ${cursorName}`
      );
      if (batch.rows.length === 0) break;
      for (const row of batch.rows) {
        const line = `${row.row_json}\n`;
        const bytes = Buffer.byteLength(line);
        hash.update(line, 'utf8');
        rowCount += 1;
        byteSize += bytes;
        if (!stream.write(line)) {
          await once(stream, 'drain');
        }
      }
    }
  } finally {
    await params.client.query(`CLOSE ${cursorName}`).catch(() => undefined);
    stream.end();
    await once(stream, 'close');
  }
  return {
    rowCount,
    byteSize,
    checksum: `sha256:${hash.digest('hex')}`
  };
}

class CircleMigrationExportService {
  async export(migration: CircleMigrationRecord): Promise<{
    directory: string;
    snapshotId: string;
    manifest: CircleMigrationExportManifest;
  }> {
    if (
      migration.status !== 'exporting'
      || !migration.freeze_started_at
      || !migration.preflight_summary
      || !migration.owner_signed_migration_intent
      || !migration.destination_server_id
    ) {
      throw new Error('Migration is not ready for a frozen export');
    }
    const targetMessageTtlHours = Number(migration.preflight_summary.targetMessageTtlHours);
    if (!Number.isFinite(targetMessageTtlHours) || targetMessageTtlHours < 1) {
      throw new Error('Migration preflight does not contain a valid target message TTL');
    }

    const snapshotId = `snapshot_${crypto.randomUUID().replace(/-/g, '')}`;
    const startedAt = new Date();
    const migrationRoot = path.dirname(getCircleMigrationExportDirectory(migration.migration_id));
    const temporaryDirectory = path.join(migrationRoot, `.export-${snapshotId}.tmp`);
    const finalDirectory = getCircleMigrationExportDirectory(migration.migration_id);
    await fs.promises.mkdir(path.join(temporaryDirectory, 'db'), { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(path.join(temporaryDirectory, 'signatures'), { recursive: true, mode: 0o700 });

    const counts: Record<string, number> = {};
    const byteSizes: Record<string, number> = {};
    const checksums: Record<string, string> = {};
    const tableExports: CircleMigrationExportManifest['tableExports'] = [];
    const targetMessageCutoff = startedAt.getTime() - targetMessageTtlHours * 60 * 60 * 1000;
    const client = await getClient();

    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await assertExportTables(client);
      for (let index = 0; index < CIRCLE_MIGRATION_V2_EXPORT_TABLES.length; index += 1) {
        const table = CIRCLE_MIGRATION_V2_EXPORT_TABLES[index]!;
        const relativePath = `db/${table}.jsonl`;
        const tableResult = await exportTable({
          client,
          table,
          cursorIndex: index,
          familyId: migration.family_id,
          targetMessageCutoff,
          outputPath: path.join(temporaryDirectory, relativePath)
        });
        counts[table] = tableResult.rowCount;
        byteSizes[table] = tableResult.byteSize;
        checksums[relativePath] = tableResult.checksum;
        tableExports.push({
          table,
          path: relativePath,
          rowCount: tableResult.rowCount,
          byteSize: tableResult.byteSize,
          checksum: tableResult.checksum,
          chunkCount: Math.max(1, Math.ceil(tableResult.byteSize / CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES))
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      client.release();
    }

    const excludedMessageCountByTargetTtl = Number(
      migration.preflight_summary.excludedMessageCountByTargetTtl || 0
    );
    const manifest: CircleMigrationExportManifest = {
      format: CIRCLE_MIGRATION_FORMAT,
      migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
      sourceSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
      destinationSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
      dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
      migrationId: migration.migration_id,
      migrationSlotId: migration.migration_slot_id,
      familyId: migration.family_id,
      sourceServerId: getServerIdentityRuntimeConfig().vpsId,
      destinationServerId: migration.destination_server_id,
      sourceCircleId: String((migration.preflight_summary.migrationBinding as Record<string, unknown> | undefined)?.sourceCircleId || ''),
      destinationCircleId: String((migration.preflight_summary.migrationBinding as Record<string, unknown> | undefined)?.destinationCircleId || ''),
      sourceServerUrl: String(migration.owner_signed_migration_intent.payload
        && (migration.owner_signed_migration_intent.payload as Record<string, unknown>).oldPublicBaseUrl || ''),
      destinationServiceEndpoint: migration.destination_service_endpoint,
      oldPublicBaseUrl: String(migration.owner_signed_migration_intent.payload
        && (migration.owner_signed_migration_intent.payload as Record<string, unknown>).oldPublicBaseUrl || ''),
      targetPublicBaseUrl: migration.destination_public_base_url,
      createdAt: new Date().toISOString(),
      snapshot: {
        id: snapshotId,
        startedAt: startedAt.toISOString(),
        isolation: 'repeatable_read_after_write_freeze'
      },
      dataScopes: CIRCLE_MIGRATION_FIXED_SCOPES,
      dataLossPolicy: FIXED_DATA_LOSS_POLICY,
      configAdjustments: {},
      excludedMessageCountByTargetTtl,
      counts,
      byteSizes,
      tableExports,
      checksums,
      encryption: {
        algorithm: 'xchacha20-poly1305',
        keyId: `migration-session:${migration.migration_slot_id}`,
        chunkBytes: CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES
      },
      ownerSignedMigrationIntent: migration.owner_signed_migration_intent
    };

    const ownerIntent = `${canonicalizeCircleMigrationJson(migration.owner_signed_migration_intent)}\n`;
    await fs.promises.writeFile(
      path.join(temporaryDirectory, 'signatures', 'owner-intent.json'),
      ownerIntent,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    checksums['signatures/owner-intent.json'] = `sha256:${crypto
      .createHash('sha256')
      .update(ownerIntent, 'utf8')
      .digest('hex')}`;
    const checksumsJson = `${canonicalizeCircleMigrationJson(checksums)}\n`;
    await fs.promises.writeFile(
      path.join(temporaryDirectory, 'checksums.json'),
      checksumsJson,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    const manifestJson = `${canonicalizeCircleMigrationJson(manifest)}\n`;
    await fs.promises.writeFile(
      path.join(temporaryDirectory, 'manifest.json'),
      manifestJson,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );

    await fs.promises.rm(finalDirectory, { recursive: true, force: true });
    await fs.promises.rename(temporaryDirectory, finalDirectory);
    return { directory: finalDirectory, snapshotId, manifest };
  }
}

export const circleMigrationExportService = new CircleMigrationExportService();
