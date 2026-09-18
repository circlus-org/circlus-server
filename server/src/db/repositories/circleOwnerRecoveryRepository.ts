import { nanoid } from 'nanoid';
import { query } from '../index';

export type CircleOwnerRecoveryClaimRecord = {
  claim_id: string;
  family_id: string;
  token_hash: string;
  expected_owner_identity_id: string;
  created_by_server_admin_id: string;
  created_authorization: unknown;
  status: 'pending' | 'used' | 'expired' | 'revoked';
  expires_at: Date;
  created_at: Date;
  used_at: Date | null;
  used_by_identity_id: string | null;
};

export class CircleOwnerRecoveryRepository {
  createClaimId(): string {
    return `cor_${nanoid(18)}`;
  }

  async createClaim(params: {
    familyId: string;
    tokenHash: string;
    expectedOwnerIdentityId: string;
    createdByServerAdminId: string;
    createdAuthorization: unknown;
    expiresAt: Date;
  }): Promise<CircleOwnerRecoveryClaimRecord> {
    const result = await query<CircleOwnerRecoveryClaimRecord>(
      `INSERT INTO circle_owner_recovery_claims (
         claim_id, family_id, token_hash, expected_owner_identity_id,
         created_by_server_admin_id, created_authorization, status, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', $7)
       RETURNING *`,
      [
        this.createClaimId(),
        params.familyId,
        params.tokenHash,
        params.expectedOwnerIdentityId,
        params.createdByServerAdminId,
        JSON.stringify(params.createdAuthorization),
        params.expiresAt.toISOString()
      ]
    );
    return result.rows[0];
  }

  async findByTokenHash(tokenHash: string): Promise<CircleOwnerRecoveryClaimRecord | null> {
    const result = await query<CircleOwnerRecoveryClaimRecord>(
      `SELECT * FROM circle_owner_recovery_claims WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    return result.rows[0] || null;
  }

  async revokePending(familyId: string): Promise<void> {
    await query(
      `UPDATE circle_owner_recovery_claims
       SET status = 'revoked'
       WHERE family_id = $1 AND status = 'pending'`,
      [familyId]
    );
  }
}

export const circleOwnerRecoveryRepository = new CircleOwnerRecoveryRepository();
