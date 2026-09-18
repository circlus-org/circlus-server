import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import {
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FIXED_SCOPES,
  CIRCLE_MIGRATION_FORMAT,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
  CIRCLE_MIGRATION_V2_EXPORT_TABLES
} from './circleMigrationContract';
import {
  encryptMigrationChunk,
  encryptMigrationSecret,
  migrationChunkAssociatedData
} from './circleMigrationCrypto';
import { CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES } from './circleMigrationExportService';
import { circleMigrationImportService } from './circleMigrationImportService';
import { FIXED_DATA_LOSS_POLICY } from './circleMigrationScheduleService';

jest.mock('../db/repositories/circleMigrationRepository', () => ({
  circleMigrationRepository: {
    startSlotImport: jest.fn(),
    completeSlotStagingValidation: jest.fn()
  }
}));

describe('Circle migration encrypted staging import', () => {
  let root: string;
  const familyId = '11111111-1111-4111-8111-111111111111';
  const sessionKey = Buffer.alloc(32, 12).toString('base64');
  const ownerIntent = { payload: { migrationId: 'migjob_test' }, signature: 'signature' };

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'circlus-migration-import-'));
    process.env.CIRCLE_MIGRATION_IMPORT_DIR = root;
    process.env.CIRCLE_MIGRATION_SECRET_KEY_BASE64 = Buffer.alloc(32, 13).toString('base64');
    process.env.VPS_ID = 'destination-server';
  });

  afterEach(async () => {
    delete process.env.CIRCLE_MIGRATION_IMPORT_DIR;
    delete process.env.CIRCLE_MIGRATION_SECRET_KEY_BASE64;
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  function slot(overrides: Record<string, unknown> = {}) {
    return {
      migration_slot_id: 'mslot_test',
      status: 'reserved',
      source_migration_id: 'migjob_test',
      expected_family_id: familyId,
      source_server_id: 'source-server',
      source_circle_id: 'circle_source_1234567890',
      destination_circle_id: 'circle_destination_123456',
      target_public_base_url: 'https://circle.example',
      owner_signed_migration_intent: ownerIntent,
      session_key_encrypted: encryptMigrationSecret({ sessionKey }),
      ...overrides
    } as any;
  }

  function manifest() {
    const emptyChecksum = `sha256:${crypto.createHash('sha256').digest('hex')}`;
    const counts = Object.fromEntries(CIRCLE_MIGRATION_V2_EXPORT_TABLES.map((table) => [table, 0]));
    const byteSizes = { ...counts };
    const checksums = Object.fromEntries(
      CIRCLE_MIGRATION_V2_EXPORT_TABLES.map((table) => [`db/${table}.jsonl`, emptyChecksum])
    );
    return {
      format: CIRCLE_MIGRATION_FORMAT,
      migrationFormatVersion: CIRCLE_MIGRATION_FORMAT_VERSION,
      sourceSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
      destinationSchemaFingerprint: CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
      dataScopeFingerprint: CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
      migrationId: 'migjob_test',
      migrationSlotId: 'mslot_test',
      familyId,
      sourceServerId: 'source-server',
      destinationServerId: 'destination-server',
      sourceCircleId: 'circle_source_1234567890',
      destinationCircleId: 'circle_destination_123456',
      sourceServerUrl: 'https://source.example',
      destinationServiceEndpoint: 'https://destination.example',
      oldPublicBaseUrl: 'https://source.example',
      targetPublicBaseUrl: 'https://circle.example',
      createdAt: new Date().toISOString(),
      snapshot: {
        id: 'snapshot_test',
        startedAt: new Date().toISOString(),
        isolation: 'repeatable_read_after_write_freeze'
      },
      dataScopes: CIRCLE_MIGRATION_FIXED_SCOPES,
      dataLossPolicy: FIXED_DATA_LOSS_POLICY,
      configAdjustments: {},
      excludedMessageCountByTargetTtl: 0,
      counts,
      byteSizes,
      tableExports: CIRCLE_MIGRATION_V2_EXPORT_TABLES.map((table) => ({
        table,
        path: `db/${table}.jsonl`,
        rowCount: 0,
        byteSize: 0,
        checksum: emptyChecksum,
        chunkCount: 1
      })),
      checksums,
      encryption: {
        algorithm: 'xchacha20-poly1305',
        keyId: 'migration-session:mslot_test',
        chunkBytes: CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES
      },
      ownerSignedMigrationIntent: ownerIntent
    };
  }

  it('accepts authenticated chunks and validates the complete package', async () => {
    const sourceManifest = manifest();
    (circleMigrationRepository.startSlotImport as jest.Mock).mockImplementation(async (data) => (
      slot({
        status: 'importing',
        import_manifest: data.manifest,
        staging_path: data.stagingPath,
        import_started_at: new Date()
      })
    ));
    (circleMigrationRepository.completeSlotStagingValidation as jest.Mock).mockImplementation(async (data) => (
      slot({
        status: 'imported',
        import_manifest: sourceManifest,
        staging_path: path.join(root, 'mslot_test'),
        import_report: data.importReport
      })
    ));

    const importing = await circleMigrationImportService.start(slot(), sourceManifest);
    for (const entry of sourceManifest.tableExports) {
      const associatedData = migrationChunkAssociatedData({
        migrationSlotId: 'mslot_test',
        migrationId: 'migjob_test',
        filePath: entry.path,
        chunkIndex: 0,
        chunkCount: 1
      });
      await circleMigrationImportService.uploadChunk(importing, {
        filePath: entry.path,
        chunkIndex: 0,
        chunkCount: 1,
        encrypted: encryptMigrationChunk(sessionKey, Buffer.alloc(0), associatedData)
      });
    }
    const imported = await circleMigrationImportService.complete(importing);
    expect(imported.status).toBe('imported');
    expect(circleMigrationRepository.completeSlotStagingValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        migrationSlotId: 'mslot_test',
        importReport: expect.objectContaining({ status: 'staging_validated' })
      })
    );
  });

  it('rejects a chunk whose associated metadata was substituted', async () => {
    const sourceManifest = manifest();
    (circleMigrationRepository.startSlotImport as jest.Mock).mockImplementation(async (data) => (
      slot({ status: 'importing', import_manifest: data.manifest, staging_path: data.stagingPath })
    ));
    const importing = await circleMigrationImportService.start(slot(), sourceManifest);
    const entry = sourceManifest.tableExports[0]!;
    const encrypted = encryptMigrationChunk(
      sessionKey,
      Buffer.alloc(0),
      migrationChunkAssociatedData({
        migrationSlotId: 'another-slot',
        migrationId: 'migjob_test',
        filePath: entry.path,
        chunkIndex: 0,
        chunkCount: 1
      })
    );
    await expect(circleMigrationImportService.uploadChunk(importing, {
      filePath: entry.path,
      chunkIndex: 0,
      chunkCount: 1,
      encrypted
    })).rejects.toMatchObject({ code: 'MIGRATION_CHUNK_INVALID' });
  });
});
