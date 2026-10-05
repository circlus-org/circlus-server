import type { IdentityId } from '../../../shared/types';
import { query } from '../db';

type SelfDisableRow = {
  status: string;
  state_id: string | null;
  signer_id: string | null;
};

/** The latest removal/restoration decides whether this was a voluntary exit. */
const selfDisableStateSql = `SELECT identity.status, transition.state_id,
       transition.claim->>'signerId' AS signer_id
  FROM identities AS identity
  LEFT JOIN LATERAL (
    SELECT state_id, claim
      FROM circle_membership_states
     WHERE family_id = identity.family_id
       AND subject_identity_id = identity.identity_id
       AND action IN ('remove', 'restore')
     ORDER BY sequence DESC
     LIMIT 1
  ) AS transition ON TRUE
 WHERE identity.family_id = $1 AND identity.identity_id = $2`;

export async function getSelfDisableStatus(familyId: string, identityId: IdentityId) {
  const result = await query<SelfDisableRow>(selfDisableStateSql, [familyId, identityId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    disabled: row.status === 'disabled',
    selfDisabled: row.status === 'disabled' && row.signer_id === identityId,
    membershipStateId: row.state_id,
  };
}
