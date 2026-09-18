import { transaction } from '../db';

export type GuestInvitePermissionResult =
  | { kind: 'updated'; revokedLinks: number }
  | { kind: 'not_found' | 'owner' | 'invalid' };

export async function setGuestInvitePermission(params: {
  familyId: string;
  identityId: string;
  enabled: boolean;
}): Promise<GuestInvitePermissionResult> {
  return transaction(async (client) => {
    const target = await client.query<{ role: string | null; status: string }>(
      'SELECT role, status FROM identities WHERE family_id = $1 AND identity_id = $2 FOR UPDATE',
      [params.familyId, params.identityId]
    );
    const identity = target.rows[0];
    if (!identity) return { kind: 'not_found' };
    if (identity.role === 'owner') return { kind: 'owner' };
    if (identity.status !== 'active' || (identity.role !== 'member' && identity.role !== 'guest')) {
      return { kind: 'invalid' };
    }
    await client.query(
      'UPDATE identities SET can_create_guest_invites = $3 WHERE family_id = $1 AND identity_id = $2',
      [params.familyId, params.identityId, params.enabled]
    );
    let revokedLinks = 0;
    if (!params.enabled) {
      const revoked = await client.query(
        `UPDATE direct_guest_links
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW()), updated_at = NOW()
         WHERE family_id = $1 AND host_identity_id = $2 AND status = 'active'`,
        [params.familyId, params.identityId]
      );
      revokedLinks = revoked.rowCount || 0;
    }
    return { kind: 'updated', revokedLinks };
  });
}
