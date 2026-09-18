import { query } from '../index';

export interface CircleFileAccess {
  access_id: string;
  family_id: string;
  blob_id: string;
  granted_at: Date;
  purpose: string;
}

export class CircleFileAccessRepository {
  /**
   * Grant a circle access to a blob.
   * Uses ON CONFLICT DO NOTHING so duplicate calls are safe.
   */
  async grantAccess(params: {
    familyId: string;
    blobId: string;
    purpose?: string;
  }): Promise<void> {
    await query(
      `INSERT INTO circle_file_access (family_id, blob_id, purpose)
       VALUES ($1, $2, $3)
       ON CONFLICT (family_id, blob_id) DO NOTHING`,
      [params.familyId, params.blobId, params.purpose ?? 'avatar']
    );
  }

  /**
   * Check whether a circle has access to a blob.
   */
  async hasAccess(familyId: string, blobId: string): Promise<boolean> {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM circle_file_access
         WHERE family_id = $1 AND blob_id = $2
       ) AS exists`,
      [familyId, blobId]
    );
    return result.rows[0]?.exists ?? false;
  }

  /**
   * List all file access records for a circle.
   */
  async listByFamily(familyId: string): Promise<CircleFileAccess[]> {
    const result = await query<CircleFileAccess>(
      `SELECT * FROM circle_file_access WHERE family_id = $1 ORDER BY granted_at DESC`,
      [familyId]
    );
    return result.rows;
  }

  /**
   * Revoke a circle's access to a blob.
   */
  async revokeAccess(familyId: string, blobId: string): Promise<void> {
    await query(
      `DELETE FROM circle_file_access WHERE family_id = $1 AND blob_id = $2`,
      [familyId, blobId]
    );
  }
}

export const circleFileAccessRepository = new CircleFileAccessRepository();
