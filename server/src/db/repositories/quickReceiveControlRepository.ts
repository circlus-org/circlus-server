import { query } from '../index';
import type { DeviceId, IdentityId, PublicKey } from '@shared/types';

export type QuickReceiveControlRecord = {
  sequence: number;
  controlId: string;
  issuerIdentityId: IdentityId;
  issuerPublicKey: PublicKey;
  ciphertext: string;
  createdAt: Date;
};

export class QuickReceiveControlRepository {
  async upsert(params: {
    controlId: string;
    familyId: string;
    issuerIdentityId: IdentityId;
    recipientIdentityId: IdentityId;
    issuerDeviceId: DeviceId;
    ciphertext: string;
  }): Promise<{ sequence: number; createdAt: Date }> {
    const inserted = await query<{ sequence: number; created_at: Date }>(
      `INSERT INTO direct_file_quick_receive_controls
        (control_id, family_id, issuer_identity_id, recipient_identity_id, issuer_device_id, ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (family_id, control_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext
       RETURNING sequence, created_at`,
      [
        params.controlId,
        params.familyId,
        params.issuerIdentityId,
        params.recipientIdentityId,
        params.issuerDeviceId,
        params.ciphertext
      ]
    );
    const row = inserted.rows[0];
    return {
      sequence: Number(row?.sequence || 0),
      createdAt: row?.created_at || new Date()
    };
  }

  async listAfter(params: {
    familyId: string;
    recipientIdentityId: IdentityId;
    afterSequence: number;
    limit: number;
  }): Promise<QuickReceiveControlRecord[]> {
    const rows = await query<{
      sequence: number;
      control_id: string;
      issuer_identity_id: string;
      ciphertext: string;
      created_at: Date;
      public_key_algorithm: 'ed25519' | 'x25519';
      public_key_value: string;
    }>(
      `SELECT c.sequence, c.control_id, c.issuer_identity_id, c.ciphertext, c.created_at,
              i.public_key_algorithm, i.public_key_value
         FROM direct_file_quick_receive_controls c
         JOIN identities i
           ON i.family_id = c.family_id AND i.identity_id = c.issuer_identity_id
        WHERE c.family_id = $1 AND c.recipient_identity_id = $2 AND c.sequence > $3
        ORDER BY c.sequence ASC
        LIMIT $4`,
      [params.familyId, params.recipientIdentityId, params.afterSequence, params.limit]
    );
    return rows.rows.map((row) => ({
      sequence: Number(row.sequence),
      controlId: row.control_id,
      issuerIdentityId: row.issuer_identity_id as IdentityId,
      issuerPublicKey: {
        algorithm: row.public_key_algorithm,
        value: row.public_key_value
      },
      ciphertext: row.ciphertext,
      createdAt: row.created_at
    }));
  }

  async deleteOlderThanDays(retentionDays: number): Promise<void> {
    await query(
      `DELETE FROM direct_file_quick_receive_controls WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
      [retentionDays]
    );
  }
}

export const quickReceiveControlRepository = new QuickReceiveControlRepository();
