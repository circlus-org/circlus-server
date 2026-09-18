import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { MigrationSlotRecord } from '../db/repositories/circleMigrationRepository';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import {
  getCircleMigrationRuntimeConfig,
  getServerIdentityRuntimeConfig
} from '../config/serverRuntimeConfig';
import {
  canonicalizeCircleMigrationJson,
  CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT,
  CIRCLE_MIGRATION_FIXED_SCOPES,
  CIRCLE_MIGRATION_FORMAT,
  CIRCLE_MIGRATION_FORMAT_VERSION,
  CIRCLE_MIGRATION_SCHEMA_FINGERPRINT,
  CIRCLE_MIGRATION_V2_EXPORT_TABLES
} from './circleMigrationContract';
import {
  decryptMigrationChunk,
  decryptMigrationSecret,
  migrationChunkAssociatedData,
  type EncryptedMigrationChunk
} from './circleMigrationCrypto';
import {
  CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES,
  type CircleMigrationExportManifest
} from './circleMigrationExportService';
import { CircleMigrationServiceError } from './circleMigrationSlotService';

const MANIFEST_KEYS = [
  'format',
  'migrationFormatVersion',
  'sourceSchemaFingerprint',
  'destinationSchemaFingerprint',
  'dataScopeFingerprint',
  'migrationId',
  'migrationSlotId',
  'familyId',
  'sourceServerId',
  'destinationServerId',
  'sourceCircleId',
  'destinationCircleId',
  'sourceServerUrl',
  'destinationServiceEndpoint',
  'oldPublicBaseUrl',
  'targetPublicBaseUrl',
  'createdAt',
  'snapshot',
  'dataScopes',
  'dataLossPolicy',
  'configAdjustments',
  'excludedMessageCountByTargetTtl',
  'counts',
  'byteSizes',
  'tableExports',
  'checksums',
  'encryption',
  'ownerSignedMigrationIntent'
].sort();

function importRoot(): string {
  return getCircleMigrationRuntimeConfig().importDir;
}

function stagingDirectory(slot: MigrationSlotRecord): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(slot.migration_slot_id)) {
    throw new Error('Unsafe migration slot id for staging path');
  }
  return path.join(importRoot(), slot.migration_slot_id);
}

export async function removeCircleMigrationStaging(slot: MigrationSlotRecord): Promise<void> {
  const expected = stagingDirectory(slot);
  if (slot.staging_path && path.resolve(slot.staging_path) !== expected) {
    throw new Error('Migration staging path is invalid');
  }
  await fs.promises.rm(expected, { recursive: true, force: true });
}

function validateManifest(
  slot: MigrationSlotRecord,
  value: unknown
): CircleMigrationExportManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CircleMigrationServiceError(400, 'MIGRATION_MANIFEST_INVALID', 'Migration manifest is required');
  }
  const manifest = value as CircleMigrationExportManifest;
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(MANIFEST_KEYS)) {
    throw new CircleMigrationServiceError(400, 'MIGRATION_MANIFEST_INVALID', 'Migration manifest fields are invalid');
  }
  if (
    manifest.format !== CIRCLE_MIGRATION_FORMAT
    || manifest.migrationFormatVersion !== CIRCLE_MIGRATION_FORMAT_VERSION
    || manifest.sourceSchemaFingerprint !== CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
    || manifest.destinationSchemaFingerprint !== CIRCLE_MIGRATION_SCHEMA_FINGERPRINT
    || manifest.dataScopeFingerprint !== CIRCLE_MIGRATION_DATA_SCOPE_FINGERPRINT
    || manifest.migrationSlotId !== slot.migration_slot_id
    || manifest.migrationId !== slot.source_migration_id
    || manifest.familyId !== slot.expected_family_id
    || manifest.sourceServerId !== slot.source_server_id
    || manifest.destinationServerId !== getServerIdentityRuntimeConfig().vpsId
    || manifest.sourceCircleId !== slot.source_circle_id
    || manifest.destinationCircleId !== slot.destination_circle_id
    || manifest.targetPublicBaseUrl !== slot.target_public_base_url
    || canonicalizeCircleMigrationJson(manifest.ownerSignedMigrationIntent)
      !== canonicalizeCircleMigrationJson(slot.owner_signed_migration_intent)
    || canonicalizeCircleMigrationJson(manifest.dataScopes)
      !== canonicalizeCircleMigrationJson(CIRCLE_MIGRATION_FIXED_SCOPES)
    || manifest.encryption?.algorithm !== 'xchacha20-poly1305'
    || manifest.encryption?.chunkBytes !== CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES
  ) {
    throw new CircleMigrationServiceError(
      409,
      'MIGRATION_MANIFEST_INVALID',
      'Migration manifest does not match the reserved slot'
    );
  }
  if (!Array.isArray(manifest.tableExports)) {
    throw new CircleMigrationServiceError(400, 'MIGRATION_MANIFEST_INVALID', 'tableExports is required');
  }
  const expectedTables = [...CIRCLE_MIGRATION_V2_EXPORT_TABLES];
  const actualTables = manifest.tableExports.map((entry) => entry.table);
  if (
    canonicalizeCircleMigrationJson(actualTables) !== canonicalizeCircleMigrationJson(expectedTables)
    || new Set(actualTables).size !== expectedTables.length
  ) {
    throw new CircleMigrationServiceError(400, 'MIGRATION_MANIFEST_INVALID', 'Export table list is invalid');
  }
  for (const entry of manifest.tableExports) {
    if (
      entry.path !== `db/${entry.table}.jsonl`
      || entry.rowCount !== manifest.counts[entry.table]
      || entry.byteSize !== manifest.byteSizes[entry.table]
      || entry.checksum !== manifest.checksums[entry.path]
      || !Number.isInteger(entry.rowCount)
      || entry.rowCount < 0
      || !Number.isInteger(entry.byteSize)
      || entry.byteSize < 0
      || !Number.isInteger(entry.chunkCount)
      || entry.chunkCount !== Math.max(1, Math.ceil(entry.byteSize / CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES))
      || !/^sha256:[a-f0-9]{64}$/.test(entry.checksum)
    ) {
      throw new CircleMigrationServiceError(
        400,
        'MIGRATION_MANIFEST_INVALID',
        `Invalid export metadata for ${entry.table}`
      );
    }
  }
  return manifest;
}

function sessionKeyForSlot(slot: MigrationSlotRecord): string {
  const decrypted = decryptMigrationSecret<{ sessionKey: string }>(slot.session_key_encrypted);
  if (!decrypted.sessionKey) throw new Error('Destination migration session key is missing');
  return decrypted.sessionKey;
}

function entryForPath(manifest: CircleMigrationExportManifest, filePath: string) {
  return manifest.tableExports.find((entry) => entry.path === filePath) || null;
}

function chunkFramePath(directory: string, table: string, chunkIndex: number): string {
  return path.join(directory, 'chunks', table, `${String(chunkIndex).padStart(8, '0')}.frame.json`);
}

export async function* iterateCircleMigrationStagedRows(
  slot: MigrationSlotRecord,
  table: typeof CIRCLE_MIGRATION_V2_EXPORT_TABLES[number]
): AsyncGenerator<Record<string, unknown>> {
  if (
    !['importing', 'imported', 'waiting_cutover'].includes(slot.status)
    || !slot.import_manifest
    || !slot.staging_path
  ) {
    throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration slot is ${slot.status}`);
  }
  if (path.resolve(slot.staging_path) !== stagingDirectory(slot)) {
    throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration staging path is invalid');
  }
  const manifest = validateManifest(slot, slot.import_manifest);
  const entry = manifest.tableExports.find((candidate) => candidate.table === table);
  if (!entry) {
    throw new CircleMigrationServiceError(400, 'MIGRATION_MANIFEST_INVALID', `Missing export for ${table}`);
  }
  const key = sessionKeyForSlot(slot);
  const decoder = new StringDecoder('utf8');
  let carry = '';

  for (let chunkIndex = 0; chunkIndex < entry.chunkCount; chunkIndex += 1) {
    const framePath = chunkFramePath(slot.staging_path, entry.table, chunkIndex);
    let frame: EncryptedMigrationChunk;
    try {
      frame = JSON.parse(await fs.promises.readFile(framePath, 'utf8')) as EncryptedMigrationChunk;
    } catch {
      throw new CircleMigrationServiceError(
        409,
        'MIGRATION_CHUNKS_INCOMPLETE',
        `Missing chunk ${chunkIndex} for ${entry.path}`
      );
    }
    const associatedData = migrationChunkAssociatedData({
      migrationSlotId: slot.migration_slot_id,
      migrationId: manifest.migrationId,
      filePath: entry.path,
      chunkIndex,
      chunkCount: entry.chunkCount
    });
    let plaintext: Buffer;
    try {
      plaintext = decryptMigrationChunk(key, frame, associatedData);
    } catch {
      throw new CircleMigrationServiceError(
        400,
        'MIGRATION_CHUNK_INVALID',
        `Chunk authentication failed for ${entry.path}`
      );
    }
    const parts = `${carry}${decoder.write(plaintext)}`.split('\n');
    carry = parts.pop() || '';
    for (const line of parts) {
      if (!line) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new CircleMigrationServiceError(400, 'MIGRATION_ROW_INVALID', `Invalid JSONL row in ${entry.path}`);
      }
      if (String(row.family_id || '') !== manifest.familyId) {
        throw new CircleMigrationServiceError(400, 'MIGRATION_ROW_INVALID', `Foreign family_id in ${entry.path}`);
      }
      yield row;
    }
  }
  carry += decoder.end();
  if (carry) {
    throw new CircleMigrationServiceError(400, 'MIGRATION_ROW_INVALID', `${entry.path} must end with a newline`);
  }
}

async function writeFrameIdempotently(filePath: string, frame: EncryptedMigrationChunk): Promise<void> {
  const canonical = `${canonicalizeCircleMigrationJson(frame)}\n`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.promises.writeFile(filePath, canonical, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await fs.promises.readFile(filePath, 'utf8');
    if (existing !== canonical) {
      throw new CircleMigrationServiceError(
        409,
        'MIGRATION_CHUNK_CONFLICT',
        'Chunk index was already uploaded with different ciphertext'
      );
    }
  }
}

class CircleMigrationImportService {
  async start(slot: MigrationSlotRecord, rawManifest: unknown): Promise<MigrationSlotRecord> {
    const manifest = validateManifest(slot, rawManifest);
    if (
      (slot.status === 'importing' || slot.status === 'imported' || slot.status === 'waiting_cutover')
      && slot.import_manifest
    ) {
      if (
        canonicalizeCircleMigrationJson(slot.import_manifest)
        !== canonicalizeCircleMigrationJson(manifest)
      ) {
        throw new CircleMigrationServiceError(409, 'MIGRATION_MANIFEST_CONFLICT', 'Import already uses another manifest');
      }
      return slot;
    }
    if (slot.status !== 'reserved') {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration slot is ${slot.status}`);
    }
    const directory = stagingDirectory(slot);
    await fs.promises.rm(directory, { recursive: true, force: true });
    await fs.promises.mkdir(path.join(directory, 'chunks'), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(
      path.join(directory, 'manifest.json'),
      `${canonicalizeCircleMigrationJson(manifest)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    const importing = await circleMigrationRepository.startSlotImport({
      migrationSlotId: slot.migration_slot_id,
      manifest,
      stagingPath: directory
    });
    if (!importing) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration slot changed concurrently');
    }
    return importing;
  }

  async uploadChunk(slot: MigrationSlotRecord, input: {
    filePath: string;
    chunkIndex: number;
    chunkCount: number;
    encrypted: EncryptedMigrationChunk;
  }): Promise<{ received: true }> {
    if (
      (slot.status !== 'importing' && slot.status !== 'imported')
      || !slot.import_manifest
      || !slot.staging_path
    ) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration slot is ${slot.status}`);
    }
    if (path.resolve(slot.staging_path) !== stagingDirectory(slot)) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration staging path is invalid');
    }
    const manifest = validateManifest(slot, slot.import_manifest);
    const entry = entryForPath(manifest, input.filePath);
    if (
      !entry
      || input.chunkCount !== entry.chunkCount
      || !Number.isInteger(input.chunkIndex)
      || input.chunkIndex < 0
      || input.chunkIndex >= entry.chunkCount
    ) {
      throw new CircleMigrationServiceError(400, 'MIGRATION_CHUNK_INVALID', 'Chunk metadata is invalid');
    }
    const associatedData = migrationChunkAssociatedData({
      migrationSlotId: slot.migration_slot_id,
      migrationId: manifest.migrationId,
      filePath: input.filePath,
      chunkIndex: input.chunkIndex,
      chunkCount: input.chunkCount
    });
    let plaintext: Buffer;
    try {
      plaintext = decryptMigrationChunk(sessionKeyForSlot(slot), input.encrypted, associatedData);
    } catch {
      throw new CircleMigrationServiceError(400, 'MIGRATION_CHUNK_INVALID', 'Chunk authentication failed');
    }
    const expectedMax = Math.min(
      CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES,
      Math.max(0, entry.byteSize - input.chunkIndex * CIRCLE_MIGRATION_TRANSFER_CHUNK_BYTES)
    );
    if (
      plaintext.length !== expectedMax
      && !(entry.byteSize === 0 && input.chunkIndex === 0 && plaintext.length === 0)
    ) {
      throw new CircleMigrationServiceError(400, 'MIGRATION_CHUNK_INVALID', 'Chunk plaintext size is invalid');
    }
    await writeFrameIdempotently(
      chunkFramePath(slot.staging_path, entry.table, input.chunkIndex),
      input.encrypted
    );
    return { received: true };
  }

  async complete(slot: MigrationSlotRecord): Promise<MigrationSlotRecord> {
    if (slot.status === 'imported' && slot.import_report) return slot;
    if (slot.status !== 'importing' || !slot.import_manifest || !slot.staging_path) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', `Migration slot is ${slot.status}`);
    }
    if (path.resolve(slot.staging_path) !== stagingDirectory(slot)) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration staging path is invalid');
    }
    const manifest = validateManifest(slot, slot.import_manifest);
    const key = sessionKeyForSlot(slot);
    const reportFiles: Record<string, { rowCount: number; byteSize: number; checksum: string }> = {};

    for (const entry of manifest.tableExports) {
      const hash = crypto.createHash('sha256');
      const decoder = new StringDecoder('utf8');
      let carry = '';
      let byteSize = 0;
      let rowCount = 0;
      for (let chunkIndex = 0; chunkIndex < entry.chunkCount; chunkIndex += 1) {
        const framePath = chunkFramePath(slot.staging_path, entry.table, chunkIndex);
        let frame: EncryptedMigrationChunk;
        try {
          frame = JSON.parse(await fs.promises.readFile(framePath, 'utf8')) as EncryptedMigrationChunk;
        } catch {
          throw new CircleMigrationServiceError(
            409,
            'MIGRATION_CHUNKS_INCOMPLETE',
            `Missing chunk ${chunkIndex} for ${entry.path}`
          );
        }
        const associatedData = migrationChunkAssociatedData({
          migrationSlotId: slot.migration_slot_id,
          migrationId: manifest.migrationId,
          filePath: entry.path,
          chunkIndex,
          chunkCount: entry.chunkCount
        });
        let plaintext: Buffer;
        try {
          plaintext = decryptMigrationChunk(key, frame, associatedData);
        } catch {
          throw new CircleMigrationServiceError(400, 'MIGRATION_CHUNK_INVALID', `Chunk authentication failed for ${entry.path}`);
        }
        hash.update(plaintext);
        byteSize += plaintext.length;
        const parts = `${carry}${decoder.write(plaintext)}`.split('\n');
        carry = parts.pop() || '';
        for (const line of parts) {
          if (!line) continue;
          let row: Record<string, unknown>;
          try {
            row = JSON.parse(line) as Record<string, unknown>;
          } catch {
            throw new CircleMigrationServiceError(400, 'MIGRATION_ROW_INVALID', `Invalid JSONL row in ${entry.path}`);
          }
          if (String(row.family_id || '') !== manifest.familyId) {
            throw new CircleMigrationServiceError(400, 'MIGRATION_ROW_INVALID', `Foreign family_id in ${entry.path}`);
          }
          rowCount += 1;
        }
      }
      carry += decoder.end();
      if (carry) {
        throw new CircleMigrationServiceError(400, 'MIGRATION_ROW_INVALID', `${entry.path} must end with a newline`);
      }
      const checksum = `sha256:${hash.digest('hex')}`;
      if (byteSize !== entry.byteSize || rowCount !== entry.rowCount || checksum !== entry.checksum) {
        throw new CircleMigrationServiceError(400, 'MIGRATION_CHECKSUM_MISMATCH', `Validation failed for ${entry.path}`);
      }
      reportFiles[entry.path] = { rowCount, byteSize, checksum };
    }

    const report = {
      status: 'staging_validated',
      migrationId: manifest.migrationId,
      validatedAt: new Date().toISOString(),
      files: reportFiles
    };
    const imported = await circleMigrationRepository.completeSlotStagingValidation({
      migrationSlotId: slot.migration_slot_id,
      importReport: report
    });
    if (!imported) {
      throw new CircleMigrationServiceError(409, 'INVALID_STATE', 'Migration slot changed concurrently');
    }
    return imported;
  }
}

export const circleMigrationImportService = new CircleMigrationImportService();
