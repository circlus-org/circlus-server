import type { CircleMembershipStateRecord } from '@shared/types';
import { transaction } from '../db';
import { appendCircleMembershipState, listCircleMembershipStates } from './circleMembershipStateService';

/** Commit the signed membership transition and the access-control projection together. */
export async function setCircleMemberStatus(params: {
  familyId: string;
  ownerIdentityId: string;
  subjectIdentityId: string;
  status: 'active' | 'disabled';
  membershipState?: CircleMembershipStateRecord;
}): Promise<'updated' | 'not_found' | 'invalid_state'> {
  const { familyId, ownerIdentityId, subjectIdentityId, status, membershipState } = params;
  const action = status === 'disabled' ? 'remove' : 'restore';
  if (membershipState && (membershipState.claim?.payload?.action !== action
    || membershipState.claim.signerId !== ownerIdentityId
    || membershipState.claim.payload.subjectIdentityId !== subjectIdentityId
    || membershipState.claim.payload.ownerIdentityId !== ownerIdentityId)) {
    return 'invalid_state';
  }

  return transaction(async (client) => {
    const result = await client.query<{ role: string; status: string }>(
      `SELECT role, status FROM identities
        WHERE family_id = $1 AND identity_id = $2 FOR UPDATE`,
      [familyId, subjectIdentityId]
    );
    const subject = result.rows[0];
    if (!subject) return 'not_found';
    if (subject.role !== 'member'
      || subject.status !== (status === 'disabled' ? 'active' : 'disabled')) return 'invalid_state';

    if (membershipState) {
      await appendCircleMembershipState({ familyId, record: membershipState, client });
    } else {
      // Legacy repair may leave an active database identity absent from the
      // signed membership. Disabling that record needs no new transition.
      if (status !== 'disabled') return 'invalid_state';
      const states = await listCircleMembershipStates(familyId, client);
      const head = states.at(-1)?.claim.payload;
      if (!head || (head.action !== 'genesis' && head.action !== 'repair')
        || head.ownerIdentityId !== ownerIdentityId
        || head.members.some((member) => member.identityId === subjectIdentityId)) return 'invalid_state';
    }
    await client.query(
      `UPDATE identities SET status = $3
        WHERE family_id = $1 AND identity_id = $2`,
      [familyId, subjectIdentityId, status]
    );
    return 'updated';
  });
}
