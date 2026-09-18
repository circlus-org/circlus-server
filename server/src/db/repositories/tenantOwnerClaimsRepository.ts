import { nanoid } from 'nanoid';
import { query } from '../index';

export type TenantOwnerClaimRecord = {
  claim_id: string;
  family_id: string;
  token_hash: string;
  status: 'pending' | 'used' | 'expired' | 'revoked';
  expires_at: Date;
  created_at: Date;
  used_at: Date | null;
  used_by_identity_id: string | null;
};

export class TenantOwnerClaimsRepository {
  async create(params: {
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<TenantOwnerClaimRecord> {
    const claimId = `toc_${nanoid(18)}`;
    const result = await query<TenantOwnerClaimRecord>(
      `INSERT INTO tenant_owner_claims (
         claim_id, family_id, token_hash, status, expires_at
       ) VALUES ($1, $2, $3, 'pending', $4)
       RETURNING *`,
      [claimId, params.familyId, params.tokenHash, params.expiresAt.toISOString()]
    );
    return result.rows[0];
  }

  async findByTokenHash(tokenHash: string): Promise<TenantOwnerClaimRecord | null> {
    const result = await query<TenantOwnerClaimRecord>(
      `SELECT * FROM tenant_owner_claims WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    return result.rows[0] || null;
  }

  async revokePending(familyId: string): Promise<void> {
    await query(
      `UPDATE tenant_owner_claims SET status = 'revoked'
       WHERE family_id = $1 AND status = 'pending'`,
      [familyId]
    );
  }

  async markUsed(tokenHash: string, identityId: string): Promise<void> {
    await query(
      `UPDATE tenant_owner_claims
       SET status = 'used', used_at = NOW(), used_by_identity_id = $2
       WHERE token_hash = $1`,
      [tokenHash, identityId]
    );
  }

  async deleteByFamilyId(familyId: string): Promise<void> {
    await query(`DELETE FROM tenant_owner_claims WHERE family_id = $1`, [familyId]);
  }
}

export const tenantOwnerClaimsRepository = new TenantOwnerClaimsRepository();
