import { pool } from '../index';

export interface BackupRecord {
  backup_id: string;
  family_id: string;
  last_uploader_identity_id: string;
  last_uploader_device_id: string;
  backup_slot_id: string;
  encrypted_backup: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export class BackupRepository {
  /**
   * Upsert the latest backup for one profile-device slot in this Circle.
   * Version is incremented server-side on each update.
   */
  async upsert(data: {
    familyId: string;
    uploaderIdentityId: string;
    uploaderDeviceId: string;
    backupSlotId: string;
    encryptedBackup: unknown;
    lookupSecretHash: string;
  }): Promise<{ backupId: string; version: number; updatedAt: Date }> {
    const result = await pool.query<{ backup_id: string; version: number; updated_at: Date }>(
      `INSERT INTO identity_backups (
         family_id,
         last_uploader_identity_id,
         last_uploader_device_id,
         backup_slot_id,
         encrypted_backup,
         lookup_secret_hash,
         version
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 1)
       ON CONFLICT (family_id, lookup_secret_hash, backup_slot_id) DO UPDATE SET
         last_uploader_identity_id = EXCLUDED.last_uploader_identity_id,
         last_uploader_device_id = EXCLUDED.last_uploader_device_id,
         encrypted_backup = EXCLUDED.encrypted_backup,
         version = identity_backups.version + 1,
         updated_at = NOW()
       RETURNING backup_id, version, updated_at`,
      [
        data.familyId,
        data.uploaderIdentityId,
        data.uploaderDeviceId,
        data.backupSlotId,
        JSON.stringify(data.encryptedBackup),
        data.lookupSecretHash
      ]
    );
    const row = result.rows[0];
    return { backupId: row.backup_id, version: row.version, updatedAt: row.updated_at };
  }

  /**
   * List the latest backup from every device slot in a secret namespace.
   */
  async listByLookupSecretHash(
    familyId: string,
    lookupSecretHash: string
  ): Promise<Array<{ encryptedBackup: unknown; version: number }>> {
    const result = await pool.query<{ encrypted_backup: unknown; version: number }>(
      `SELECT encrypted_backup, version FROM identity_backups
       WHERE family_id = $1 AND lookup_secret_hash = $2`,
      [familyId, lookupSecretHash]
    );
    return result.rows.map((r) => ({ encryptedBackup: r.encrypted_backup, version: r.version }));
  }
}

export const backupRepository = new BackupRepository();
