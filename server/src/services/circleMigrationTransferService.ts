import fs from 'node:fs';
import path from 'node:path';
import { circleMigrationRepository, type CircleMigrationRecord } from '../db/repositories/circleMigrationRepository';
import {
  canonicalizeCircleMigrationJson,
  CIRCLE_MIGRATION_V2_EXPORT_TABLES
} from './circleMigrationContract';
import {
  decryptMigrationSecret,
  encryptMigrationChunk,
  encryptMigrationSecret,
  migrationChunkAssociatedData,
  type MigrationSessionCredentials
} from './circleMigrationCrypto';
import {
  CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES,
  getCircleMigrationExportDirectory,
  type CircleMigrationExportManifest
} from './circleMigrationExportService';
import { postCircleMigrationJson } from './circleMigrationHttpClient';

export async function refreshCircleMigrationSession(
  migration: CircleMigrationRecord,
  credentials: MigrationSessionCredentials
): Promise<{ credentials: MigrationSessionCredentials; expiresAt: Date }> {
  if (migration.session_expires_at && migration.session_expires_at.getTime() > Date.now() + 60_000) {
    return { credentials, expiresAt: migration.session_expires_at };
  }
  const response = await postCircleMigrationJson<{
    status: 'ok';
    result: { sessionToken: string; sessionExpiresAt: string };
  }>(
    migration.destination_service_endpoint,
    '/api/migration/session/refresh',
    {
      migrationSlotId: migration.migration_slot_id,
      sessionKey: credentials.sessionKey
    }
  );
  const expiresAt = new Date(response?.result?.sessionExpiresAt);
  if (
    response?.status !== 'ok'
    || typeof response.result?.sessionToken !== 'string'
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= Date.now()
  ) {
    throw new Error('Destination did not refresh the migration transfer session');
  }
  const nextCredentials = { ...credentials, sessionToken: response.result.sessionToken };
  await circleMigrationRepository.updateSourceSessionCredentials({
    migrationId: migration.migration_id,
    sessionCredentialsEncrypted: encryptMigrationSecret(nextCredentials),
    sessionExpiresAt: expiresAt
  });
  migration.session_expires_at = expiresAt;
  return { credentials: nextCredentials, expiresAt };
}

function requireTransferManifest(migration: CircleMigrationRecord): CircleMigrationExportManifest {
  const manifest = migration.manifest as CircleMigrationExportManifest | null;
  if (
    !manifest
    || manifest.migrationId !== migration.migration_id
    || manifest.migrationSlotId !== migration.migration_slot_id
    || canonicalizeCircleMigrationJson(manifest.tableExports.map((entry) => entry.table))
      !== canonicalizeCircleMigrationJson(CIRCLE_MIGRATION_V2_EXPORT_TABLES)
  ) {
    throw new Error('Source export manifest is missing or invalid');
  }
  return manifest;
}

class CircleMigrationTransferService {
  async completePendingImport(migration: CircleMigrationRecord): Promise<CircleMigrationRecord> {
    if (migration.status !== 'waiting_import') {
      throw new Error(`Migration cannot apply pending import from ${migration.status}`);
    }
    let credentials = decryptMigrationSecret<MigrationSessionCredentials>(
      migration.session_credentials_encrypted
    );
    ({ credentials } = await refreshCircleMigrationSession(migration, credentials));
    const applied = await postCircleMigrationJson<{
      status: 'ok';
      result: { migrationSlotId: string; slotStatus: string; importedFamilyId: string };
    }>(
      migration.destination_service_endpoint,
      '/api/migration/import/apply',
      { migrationSlotId: migration.migration_slot_id },
      { authorization: `MigrationSession ${credentials.sessionToken}` }
    );
    if (
      applied?.status !== 'ok'
      || applied.result?.migrationSlotId !== migration.migration_slot_id
      || applied.result?.slotStatus !== 'waiting_cutover'
      || applied.result?.importedFamilyId !== migration.family_id
    ) {
      throw new Error('Destination did not create the pending Circle import');
    }
    const waitingCutover = await circleMigrationRepository.transitionSourceMigration(
      migration.migration_id,
      'waiting_import',
      'waiting_cutover'
    );
    if (!waitingCutover) throw new Error('Migration changed concurrently after destination import');
    return waitingCutover;
  }

  async transfer(migration: CircleMigrationRecord): Promise<CircleMigrationRecord> {
    if (migration.status !== 'transferring') {
      throw new Error(`Migration cannot transfer from ${migration.status}`);
    }
    const manifest = requireTransferManifest(migration);
    let credentials = decryptMigrationSecret<MigrationSessionCredentials>(
      migration.session_credentials_encrypted
    );
    ({ credentials } = await refreshCircleMigrationSession(migration, credentials));

    const started = await postCircleMigrationJson<{
      status: 'ok';
      result: { migrationSlotId: string; slotStatus: string };
    }>(
      migration.destination_service_endpoint,
      '/api/migration/import/start',
      {
        migrationSlotId: migration.migration_slot_id,
        manifest
      },
      { authorization: `MigrationSession ${credentials.sessionToken}` }
    );
    if (
      started?.status !== 'ok'
      || started.result?.migrationSlotId !== migration.migration_slot_id
    ) {
      throw new Error('Destination did not start the package import');
    }
    if (started.result.slotStatus === 'waiting_cutover') {
      const waitingImport = await circleMigrationRepository.transitionSourceMigration(
        migration.migration_id,
        'transferring',
        'waiting_import'
      );
      if (!waitingImport) throw new Error('Migration changed concurrently during import reconciliation');
      const waitingCutover = await circleMigrationRepository.transitionSourceMigration(
        migration.migration_id,
        'waiting_import',
        'waiting_cutover'
      );
      if (!waitingCutover) throw new Error('Migration changed concurrently after import reconciliation');
      return waitingCutover;
    }

    const exportDirectory = getCircleMigrationExportDirectory(migration.migration_id);
    for (const entry of manifest.tableExports) {
      const sourcePath = path.resolve(exportDirectory, entry.path);
      if (!sourcePath.startsWith(`${path.resolve(exportDirectory)}${path.sep}`)) {
        throw new Error(`Unsafe export file path: ${entry.path}`);
      }
      const file = await fs.promises.open(sourcePath, 'r');
      try {
        for (let chunkIndex = 0; chunkIndex < entry.chunkCount; chunkIndex += 1) {
          ({ credentials } = await refreshCircleMigrationSession(migration, credentials));
          const offset = chunkIndex * CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES;
          const expectedBytes = Math.min(
            CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES,
            Math.max(0, entry.byteSize - offset)
          );
          const plaintext = Buffer.alloc(expectedBytes);
          if (expectedBytes > 0) {
            const read = await file.read(plaintext, 0, expectedBytes, offset);
            if (read.bytesRead !== expectedBytes) {
              throw new Error(`Export file changed during transfer: ${entry.path}`);
            }
          }
          const associatedData = migrationChunkAssociatedData({
            migrationSlotId: migration.migration_slot_id,
            migrationId: migration.migration_id,
            filePath: entry.path,
            chunkIndex,
            chunkCount: entry.chunkCount
          });
          const encrypted = encryptMigrationChunk(credentials.sessionKey, plaintext, associatedData);
          await postCircleMigrationJson(
            migration.destination_service_endpoint,
            '/api/migration/import/chunk',
            {
              migrationSlotId: migration.migration_slot_id,
              filePath: entry.path,
              chunkIndex,
              chunkCount: entry.chunkCount,
              encrypted
            },
            { authorization: `MigrationSession ${credentials.sessionToken}` }
          );
        }
      } finally {
        await file.close();
      }
    }

    ({ credentials } = await refreshCircleMigrationSession(migration, credentials));
    const completed = await postCircleMigrationJson<{
      status: 'ok';
      result: { migrationSlotId: string; slotStatus: string };
    }>(
      migration.destination_service_endpoint,
      '/api/migration/import/complete',
      { migrationSlotId: migration.migration_slot_id },
      { authorization: `MigrationSession ${credentials.sessionToken}` }
    );
    if (
      completed?.status !== 'ok'
      || completed.result?.migrationSlotId !== migration.migration_slot_id
      || completed.result?.slotStatus !== 'imported'
    ) {
      throw new Error('Destination did not validate the transferred package');
    }
    const waitingImport = await circleMigrationRepository.transitionSourceMigration(
      migration.migration_id,
      'transferring',
      'waiting_import'
    );
    if (!waitingImport) throw new Error('Migration changed concurrently after transfer');

    return this.completePendingImport(waitingImport);
  }
}

export const circleMigrationTransferService = new CircleMigrationTransferService();
