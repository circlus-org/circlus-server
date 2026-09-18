import { transaction } from '../db';
import type { CircleMembershipEntry, CircleMembershipStateRecord } from '../../../shared/types';
import {
  appendCircleMembershipState,
  listCircleMembershipStates
} from './circleMembershipStateService';

export type CircleInvitePermissionUpdate = {
  identityId: string;
  canCreateInvites: boolean;
  revokedInvites: number;
};

/**
 * Changes invitation creation permission and, when disabling it, revokes all
 * active invitations created by that identity in the same transaction.
 */
export async function setCircleInvitePermission(params: {
  familyId: string;
  identityId: string;
  enabled: boolean;
  membershipState?: CircleMembershipStateRecord;
}): Promise<CircleInvitePermissionUpdate | null> {
  return transaction(async (client) => {
    const updated = await client.query<{ identity_id: string; can_create_invites: boolean }>(
      `UPDATE identities
          SET can_create_invites = $1
        WHERE identity_id = $2
          AND family_id = $3
        RETURNING identity_id, can_create_invites`,
      [params.enabled, params.identityId, params.familyId]
    );
    if ((updated.rowCount || 0) === 0) return null;

    if (params.membershipState) {
      await appendCircleMembershipState({
        familyId: params.familyId,
        record: params.membershipState,
        client,
      });
    }

    const membershipStates = await listCircleMembershipStates(params.familyId, client);
    const headMember = membershipStates[membershipStates.length - 1]?.claim.payload.members
      .find((entry) => entry.identityId === params.identityId);
    if (
      (params.enabled && !headMember)
      || (headMember && circleMembershipEntryCanCreateInvites(headMember) !== params.enabled)
    ) {
      throw new Error('Signed Circle membership state does not match invitation permission');
    }

    let revokedInvites = 0;
    if (!params.enabled) {
      const revoked = await client.query(
        `UPDATE invites
            SET status = 'revoked'
          WHERE family_id = $1
            AND created_by = $2
            AND status = 'active'`,
        [params.familyId, params.identityId]
      );
      revokedInvites = revoked.rowCount || 0;
    }

    return {
      identityId: updated.rows[0].identity_id,
      canCreateInvites: updated.rows[0].can_create_invites,
      revokedInvites
    };
  });
}

function circleMembershipEntryCanCreateInvites(entry: CircleMembershipEntry): boolean {
  return entry.role === 'owner' || entry.permissions?.canCreateInvites === true;
}
