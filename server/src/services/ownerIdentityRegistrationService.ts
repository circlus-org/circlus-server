import { nanoid } from 'nanoid';
import type { ErrorCode, IdentityId, RegisterOwnerIdentityPayload } from '../../../shared/types';
import { transaction } from '../db';
import {
  appendCircleMembershipState,
  validateCircleMembershipStateTransition,
} from './circleMembershipStateService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

export async function registerOwnerIdentity(params: {
  familyId: string;
  identityId: IdentityId;
  tokenHash: string;
  payload: RegisterOwnerIdentityPayload;
}) {
  const { familyId, identityId, tokenHash, payload } = params;
  return transaction(async (client) => {
      const configResult = await client.query<any>(
        `SELECT *
         FROM family_config
         WHERE family_id = $1
         FOR UPDATE`,
        [familyId]
      );
      const familyConfig = configResult.rows[0];
      if (!familyConfig || familyConfig.status !== 'pending_owner') {
        return { ok: false as const, status: 409, code: 'INVALID_STATE' as ErrorCode, message: 'Circle is not waiting for an owner' };
      }

      const inviteResult = await client.query<any>(
        `SELECT *
         FROM invites
         WHERE family_id = $1 AND token = $2
         FOR UPDATE`,
        [familyId, payload.inviteToken]
      );
      const invite = inviteResult.rows[0];
      if (!invite || invite.invite_id !== familyConfig.join_invite_id) {
        return { ok: false as const, status: 400, code: 'INVITE_INVALID' as ErrorCode, message: 'Invalid owner invite' };
      }
      if (invite.status !== 'active' || invite.used_count >= invite.max_uses) {
        const code: ErrorCode = invite.status === 'expired'
          ? 'INVITE_EXPIRED'
          : invite.status === 'exhausted' || invite.used_count >= invite.max_uses
            ? 'INVITE_EXHAUSTED'
            : 'INVITE_INVALID';
        return { ok: false as const, status: 400, code, message: `Invite is ${invite.status}` };
      }
      if (invite.expires_at.getTime() <= Date.now()) {
        return { ok: false as const, status: 410, code: 'INVITE_EXPIRED' as ErrorCode, message: 'Invite expired' };
      }

      const claimResult = await client.query<any>(
        `SELECT *
         FROM tenant_owner_claims
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash]
      );
      const claim = claimResult.rows[0];
      if (!claim || claim.family_id !== familyId) {
        return { ok: false as const, status: 400, code: 'INVALID_STATE' as ErrorCode, message: 'Owner claim is invalid' };
      }
      if (claim.status !== 'pending') {
        return { ok: false as const, status: 409, code: 'INVALID_STATE' as ErrorCode, message: `Claim is ${claim.status}` };
      }
      if (claim.expires_at.getTime() < Date.now()) {
        return { ok: false as const, status: 410, code: 'INVALID_STATE' as ErrorCode, message: 'Claim expired' };
      }

      const existingIdentity = await client.query(
        `SELECT 1
         FROM identities
         WHERE family_id = $1
           AND (identity_id = $2 OR public_key_value = $3)
         LIMIT 1`,
        [familyId, identityId, payload.identityPublicKey.value]
      );
      if ((existingIdentity.rowCount || 0) > 0) {
        return { ok: false as const, status: 409, code: 'INVALID_STATE' as ErrorCode, message: 'Identity already exists' };
      }

      const activeOwners = await client.query(
        `SELECT 1
         FROM identities
         WHERE family_id = $1 AND role = 'owner' AND status = 'active'
         LIMIT 1`,
        [familyId]
      );
      if ((activeOwners.rowCount || 0) > 0) {
        return { ok: false as const, status: 409, code: 'INVALID_STATE' as ErrorCode, message: 'Circle already has an owner' };
      }

      const quotaResult = await client.query<{ member_count: string; total_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE role IN ('owner', 'member')) AS member_count,
           COUNT(*) AS total_count
         FROM identities
         WHERE family_id = $1
           AND status = 'active'`,
        [familyId]
      );
      const memberCount = Number(quotaResult.rows[0]?.member_count || 0);
      const totalCount = Number(quotaResult.rows[0]?.total_count || 0);
      if (familyConfig.max_member_identities !== null && memberCount >= Number(familyConfig.max_member_identities)) {
        return { ok: false as const, status: 409, code: 'MEMBER_LIMIT_EXCEEDED' as ErrorCode, message: 'Circle member limit has been reached' };
      }
      if (familyConfig.max_total_identities !== null && totalCount >= Number(familyConfig.max_total_identities)) {
        return { ok: false as const, status: 409, code: 'TOTAL_USER_LIMIT_EXCEEDED' as ErrorCode, message: 'Circle user limit has been reached' };
      }

      if (!payload.membershipState) {
        return { ok: false as const, status: 400, code: 'INVALID_STATE' as ErrorCode, message: 'Signed Circle membership genesis is required' };
      }
      const membershipValidation = validateCircleMembershipStateTransition({
        record: payload.membershipState,
        previous: null,
      });
      if (!membershipValidation.ok) {
        return { ok: false as const, status: 400, code: 'INVALID_STATE' as ErrorCode, message: membershipValidation.message };
      }
      const genesisOwner = payload.membershipState.claim.payload.members[0];
      if (
        payload.membershipState.claim.payload.members.length !== 1
        || payload.membershipState.claim.payload.vpsId !== getServerIdentityRuntimeConfig().vpsId
        || payload.membershipState.claim.payload.circleId !== familyConfig.circle_id
        || payload.membershipState.claim.payload.ownerIdentityId !== identityId
        || genesisOwner?.identityId !== identityId
        || genesisOwner.publicKey.algorithm !== payload.identityPublicKey.algorithm
        || genesisOwner.publicKey.value !== payload.identityPublicKey.value
      ) {
        return { ok: false as const, status: 400, code: 'INVALID_STATE' as ErrorCode, message: 'Circle membership genesis does not match this Circle and owner identity' };
      }

      const identityResult = await client.query<any>(
        `INSERT INTO identities (
           identity_id, family_id, public_key_algorithm, public_key_value,
           encrypted_private_key, role, publish_identity, identity_name
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'owner', $6, $7)
         RETURNING *`,
        [
          identityId,
          familyId,
          payload.identityPublicKey.algorithm,
          payload.identityPublicKey.value,
          payload.encryptedIdentityPrivateKey ? JSON.stringify(payload.encryptedIdentityPrivateKey) : null,
          false,
          null
        ]
      );
      const identity = identityResult.rows[0];

      await appendCircleMembershipState({ familyId, record: payload.membershipState, client });

      await client.query(
        `UPDATE invites
         SET used_count = used_count + 1,
             status = CASE WHEN used_count + 1 >= max_uses THEN 'exhausted' ELSE status END,
             accepted_by_identity_id = $1,
             accepted_by_public_key = $2,
             accepted_identity_name = $3,
             accepted_at = NOW()
         WHERE invite_id = $4 AND family_id = $5`,
        [identityId, payload.identityPublicKey.value, null, invite.invite_id, familyId]
      );
      await client.query(
        `INSERT INTO invite_acceptances (
           invite_id, family_id, accepted_by_identity_id, accepted_by_public_key,
           accepted_identity_name, accepted_at
         ) VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (invite_id, accepted_by_identity_id) DO UPDATE
         SET accepted_by_public_key = EXCLUDED.accepted_by_public_key,
             accepted_identity_name = EXCLUDED.accepted_identity_name,
             accepted_at = EXCLUDED.accepted_at`,
        [invite.invite_id, familyId, identityId, payload.identityPublicKey.value, null]
      );
      await client.query(
        `UPDATE tenant_owner_claims
         SET status = 'used', used_at = NOW(), used_by_identity_id = $2
         WHERE token_hash = $1`,
        [tokenHash, identityId]
      );
      await client.query(
        `UPDATE family_config
         SET status = 'active', owner_identity_id = $2, claimed_at = NOW(), updated_at = NOW()
         WHERE family_id = $1`,
        [familyId, identityId]
      );

      const circleCount = await client.query<{ count: string }>('SELECT COUNT(*) AS count FROM family_config');
      const activeServerAdmins = await client.query('SELECT 1 FROM server_admins WHERE status = $1 LIMIT 1', ['active']);
      let serverAdmin: any = null;
      if (Number(circleCount.rows[0]?.count || 0) === 1 && (activeServerAdmins.rowCount || 0) === 0) {
        const serverAdminResult = await client.query<any>(
          `INSERT INTO server_admins (
             server_admin_id, principal_identity_id, status, granted_via, granted_by_server_admin_id
           ) VALUES ($1, $2, 'active', 'bootstrap', NULL)
           RETURNING *`,
          [`sa_${nanoid(18)}`, identityId]
        );
        serverAdmin = serverAdminResult.rows[0];
      }

      return {
        ok: true as const,
        identity,
        serverAdmin,
        inviteId: invite.invite_id,
        inviteCreator: invite.created_by,
        publicBaseUrl: familyConfig.public_base_url
      };
  });
}
