import { inTransactionContext, transaction } from '../db';
import { serverAdminRepository } from '../db/repositories';

export class ClaimRedemptionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
/** Serializes claims and ownership/bootstrap changes, and commits the result with the grant. */
export async function redeemClaim<T>(kind: 'admin' | 'owner', tokenHash: string, identityId: string,
  familyId: string, perform: () => Promise<T>): Promise<T> {
  return transaction(client => inTransactionContext(client, async () => {
    // One lock also protects concurrent bootstrap/owner claims for different tokens.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['claim-redemption']);
    if (kind === 'owner') {
      // The ownership-transfer service locks this same row before changing roles.
      await client.query('SELECT family_id FROM family_config WHERE family_id=$1 FOR UPDATE', [familyId]);
    }
    const table = kind === 'admin' ? 'server_admin_claims' : 'tenant_owner_claims';
    const result = await client.query(`SELECT * FROM ${table} WHERE token_hash=$1 FOR UPDATE`, [tokenHash]);
    const claim = result.rows[0];
    if (!claim) throw new ClaimRedemptionError(404, 'Claim not found');
    if (kind === 'owner' && String(claim.family_id) !== familyId) throw new ClaimRedemptionError(403, 'Wrong Circle');
    if (claim.status === 'used' && claim.used_by_identity_id === identityId && claim.redemption_result) {
      if (kind === 'admin' && !await serverAdminRepository.findActiveByIdentityId(identityId)) {
        throw new ClaimRedemptionError(409, 'Granted access was revoked');
      }
      return claim.redemption_result as T;
    }
    if (claim.status !== 'pending') throw new ClaimRedemptionError(409, 'Claim is no longer pending');
    if (new Date(claim.expires_at).getTime() <= Date.now()) throw new ClaimRedemptionError(410, 'Claim expired');
    const response = await perform();
    await client.query(`UPDATE ${table} SET status='used',used_at=NOW(),used_by_identity_id=$2,redemption_result=$3::jsonb WHERE token_hash=$1`,
      [tokenHash,identityId,JSON.stringify(response)]);
    return response;
  }));
}
