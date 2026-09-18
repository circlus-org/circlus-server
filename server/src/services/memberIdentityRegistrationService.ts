import type { ErrorCode, IdentityId, RegisterIdentityPayload } from '../../../shared/types';
import { transaction } from '../db';
import type { LinkCapabilityDescriptor } from '../../../shared/linkCapability';
import { verifyCapabilityProof } from './linkCapabilityService';
import { verifySignedRequest } from '../utils/crypto';
import { appendCircleMembershipState } from './circleMembershipStateService';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

type RegisteredIdentityRow = {
  identity_id: IdentityId;
  public_key_algorithm: string;
  public_key_value: string;
  encrypted_private_key: unknown;
  identity_name: string | null;
  created_at: Date;
  status: string;
  role: string | null;
};

export class MemberIdentityRegistrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, number>
  ) {
    super(message);
  }
}

export async function registerMemberIdentity(params: {
  familyId: string;
  identityId: IdentityId;
  payload: RegisterIdentityPayload;
  noNamesOnServer: boolean;
}) {
  return transaction(async (client) => {
    const configResult = await client.query<{
      status: string;
      circle_id: string;
      join_invite_id: string | null;
      max_member_identities: number | null;
      max_total_identities: number | null;
    }>(
      `SELECT status, circle_id, join_invite_id, max_member_identities, max_total_identities
       FROM family_config
       WHERE family_id = $1
       FOR UPDATE`,
      [params.familyId]
    );
    const familyConfig = configResult.rows[0];

    const inviteResult = await client.query<{
      invite_id: string;
      family_id: string;
      created_by: string;
      status: string;
      expires_at: Date;
      used_count: number;
      max_uses: number;
      capability_id: string | null;
      capability_mode: 'single-use' | 'unlimited' | null;
      capability_descriptor: LinkCapabilityDescriptor | null;
    }>(
      `SELECT * FROM invites
       WHERE family_id = $1 AND token = $2
       FOR UPDATE`,
      [params.familyId, params.payload.inviteToken]
    );
    const invite = inviteResult.rows[0];
    if (!invite || invite.status !== 'active') {
      throw new MemberIdentityRegistrationError(400, 'INVITE_INVALID', 'Invalid invite');
    }
    if (invite.expires_at.getTime() <= Date.now()) {
      throw new MemberIdentityRegistrationError(400, 'INVITE_EXPIRED', 'Invite expired');
    }
    if (invite.used_count >= invite.max_uses) {
      throw new MemberIdentityRegistrationError(400, 'INVITE_EXHAUSTED', 'Invite is exhausted');
    }
    if (!invite.capability_id || !invite.capability_descriptor) {
      throw new MemberIdentityRegistrationError(400, 'INVITE_INVALID', 'Invite capability is required');
    }
    const capabilityProof = params.payload.inviteCapabilityProof;
    const subjectAcceptance = params.payload.inviteAcceptance;
    const claimId = String(capabilityProof?.payload?.claimId || '').trim();
    if (
      !capabilityProof
      || !subjectAcceptance
      || !claimId
      || !verifyCapabilityProof({
        proof: capabilityProof,
        descriptor: invite.capability_descriptor,
        expectedAction: 'circle-invite:claim',
        expectedSubjectIdentityId: params.identityId,
        expectedSubjectPublicKey: params.payload.identityPublicKey
      })
      || subjectAcceptance.type !== 'circle-invite:acceptance'
      || subjectAcceptance.signerId !== params.identityId
      || subjectAcceptance.payload?.version !== 2
      || subjectAcceptance.payload?.purpose !== 'circlus-circle-invite-acceptance-v2'
      || subjectAcceptance.payload?.capabilityId !== invite.capability_id
      || subjectAcceptance.payload?.claimId !== claimId
      || subjectAcceptance.payload?.identityPublicKey?.algorithm !== params.payload.identityPublicKey.algorithm
      || subjectAcceptance.payload?.identityPublicKey?.value !== params.payload.identityPublicKey.value
      || !isDeepStrictEqual(subjectAcceptance.payload.capabilityProof, capabilityProof)
      || !verifySignedRequest(subjectAcceptance, params.payload.identityPublicKey)
    ) {
      throw new MemberIdentityRegistrationError(400, 'INVITE_INVALID', 'Invalid invite admission proof');
    }
    const directedScope = invite.capability_descriptor.payload.scope || {};
    if (directedScope.guestIdentityId || directedScope.guestRegistrationId || directedScope.guestPublicKey) {
      if (directedScope.guestIdentityId !== params.identityId
        || directedScope.guestPublicKey !== params.payload.identityPublicKey.value
        || typeof directedScope.guestRegistrationId !== 'string') {
        throw new MemberIdentityRegistrationError(400, 'INVITE_INVALID', 'Invitation is addressed to another guest');
      }
      const directedRegistration = await client.query(
        `SELECT 1 FROM direct_guest_registrations
         WHERE family_id = $1 AND registration_id = $2 AND guest_identity_id = $3
           AND host_identity_id = $4 AND status = 'active' LIMIT 1`,
        [params.familyId, directedScope.guestRegistrationId, params.identityId, invite.created_by]
      );
      if (!directedRegistration.rowCount) {
        throw new MemberIdentityRegistrationError(400, 'INVITE_INVALID', 'Guest relationship is no longer active');
      }
    }
    const admissionClaim = { capabilityProof, subjectAcceptance };
    const creatorResult = await client.query<{ status: string; public_key_algorithm: string; public_key_value: string }>(
      `SELECT status, public_key_algorithm, public_key_value
       FROM identities
       WHERE family_id = $1 AND identity_id = $2
       LIMIT 1
       FOR SHARE`,
      [params.familyId, invite.created_by]
    );
    if (invite.created_by !== 'system' && creatorResult.rows[0]?.status !== 'active') {
      throw new MemberIdentityRegistrationError(400, 'INVITE_INVALID', 'Invalid invite');
    }
    if (familyConfig?.status === 'pending_owner' && familyConfig.join_invite_id === invite.invite_id) {
      throw new MemberIdentityRegistrationError(
        409,
        'INVALID_STATE',
        'Owner invite must be accepted through owner registration'
      );
    }

    const existing = await client.query<RegisteredIdentityRow>(
      `SELECT * FROM identities
       WHERE family_id = $1 AND (identity_id = $2 OR public_key_value = $3)
       LIMIT 1
       FOR UPDATE`,
      [params.familyId, params.identityId, params.payload.identityPublicKey.value]
    );
    const existingIdentity = existing.rows[0] || null;
    const promotesGuest = Boolean(
      existingIdentity
      && existingIdentity.identity_id === params.identityId
      && existingIdentity.public_key_algorithm === params.payload.identityPublicKey.algorithm
      && existingIdentity.public_key_value === params.payload.identityPublicKey.value
      && existingIdentity.status === 'active'
      && existingIdentity.role === 'guest'
    );
    if (existingIdentity && !promotesGuest) {
      throw new MemberIdentityRegistrationError(409, 'INVALID_STATE', 'Identity already exists');
    }
    if (promotesGuest) {
      const guestRegistration = await client.query(
        `SELECT 1 FROM direct_guest_registrations
         WHERE family_id = $1 AND guest_identity_id = $2 AND status = 'active'
         LIMIT 1`,
        [params.familyId, params.identityId]
      );
      if ((guestRegistration.rowCount || 0) === 0) {
        throw new MemberIdentityRegistrationError(409, 'INVALID_STATE', 'Guest access is not active');
      }
    }

    const quotaResult = await client.query<{ member_count: string; total_count: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE role IN ('owner', 'member')) AS member_count,
         COUNT(*) AS total_count
       FROM identities
       WHERE family_id = $1 AND status = 'active'`,
      [params.familyId]
    );
    const memberCount = Number(quotaResult.rows[0]?.member_count || 0);
    const totalCount = Number(quotaResult.rows[0]?.total_count || 0);
    if (familyConfig?.max_member_identities !== null
      && familyConfig?.max_member_identities !== undefined
      && memberCount >= familyConfig.max_member_identities) {
      throw new MemberIdentityRegistrationError(
        409,
        'MEMBER_LIMIT_EXCEEDED',
        'Circle member limit has been reached',
        { limit: familyConfig.max_member_identities, current: memberCount }
      );
    }
    if (!promotesGuest && familyConfig?.max_total_identities !== null
      && familyConfig?.max_total_identities !== undefined
      && totalCount >= familyConfig.max_total_identities) {
      throw new MemberIdentityRegistrationError(
        409,
        'TOTAL_USER_LIMIT_EXCEEDED',
        'Circle user limit has been reached',
        { limit: familyConfig.max_total_identities, current: totalCount }
      );
    }

    const identityResult = promotesGuest
      ? await client.query<RegisteredIdentityRow>(
          `UPDATE identities
           SET role = 'member',
               encrypted_private_key = COALESCE($3::jsonb, encrypted_private_key),
               admission_capability_id = $4
           WHERE family_id = $1 AND identity_id = $2
           RETURNING *`,
          [
            params.familyId,
            params.identityId,
            params.payload.encryptedIdentityPrivateKey
              ? JSON.stringify(params.payload.encryptedIdentityPrivateKey)
              : null,
            invite.capability_id
          ]
        )
      : await client.query<RegisteredIdentityRow>(
          `INSERT INTO identities (
         identity_id, family_id, public_key_algorithm, public_key_value,
         encrypted_private_key, role, publish_identity, identity_name,
         admission_capability_id
       ) VALUES ($1, $2, $3, $4, $5::jsonb, 'member', $6, $7, $8)
       RETURNING *`,
      [
        params.identityId,
        params.familyId,
        params.payload.identityPublicKey.algorithm,
        params.payload.identityPublicKey.value,
        params.payload.encryptedIdentityPrivateKey
          ? JSON.stringify(params.payload.encryptedIdentityPrivateKey)
          : null,
        false,
        null,
        invite.capability_id
          ]
        );
    const identity = identityResult.rows[0];

    const membershipState = params.payload.membershipState;
    const membershipAdmission = membershipState?.admission;
    if (
      !membershipState
      || membershipState.claim.payload.vpsId !== getServerIdentityRuntimeConfig().vpsId
      || membershipState.claim.payload.circleId !== familyConfig?.circle_id
      || membershipState.claim.payload.action !== 'add'
      || membershipState.claim.payload.subjectIdentityId !== identity.identity_id
      || !membershipAdmission
      || membershipAdmission.kind !== 'circle_invite'
      || membershipAdmission.capabilityId !== invite.capability_id
      || membershipAdmission.issuerIdentityId !== invite.created_by
      || !isDeepStrictEqual(membershipAdmission.descriptor, invite.capability_descriptor)
      || membershipAdmission.issuerPublicKey.algorithm !== creatorResult.rows[0]?.public_key_algorithm
      || membershipAdmission.issuerPublicKey.value !== creatorResult.rows[0]?.public_key_value
      || !isDeepStrictEqual(membershipAdmission.claim, admissionClaim)
    ) {
      throw new MemberIdentityRegistrationError(400, 'INVITE_INVALID', 'Signed Circle membership addition is required');
    }
    try {
      await appendCircleMembershipState({ familyId: params.familyId, record: membershipState, client });
    } catch (error) {
      throw new MemberIdentityRegistrationError(
        409,
        'INVALID_STATE',
        error instanceof Error ? error.message : 'Invalid Circle membership state'
      );
    }

    await client.query(
      `UPDATE invites
       SET used_count = used_count + 1,
           status = CASE WHEN used_count + 1 >= max_uses THEN 'exhausted' ELSE status END,
           accepted_by_identity_id = $1,
           accepted_by_public_key = $2,
           accepted_identity_name = $3,
           accepted_at = NOW()
       WHERE invite_id = $4 AND family_id = $5`,
      [
        identity.identity_id,
        identity.public_key_value,
        null,
        invite.invite_id,
        params.familyId
      ]
    );
    await client.query(
      `INSERT INTO invite_acceptances (
         invite_id, family_id, accepted_by_identity_id, accepted_by_public_key,
         accepted_identity_name, accepted_at, capability_id, admission_claim
       ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7::jsonb)
       ON CONFLICT (invite_id, accepted_by_identity_id) DO UPDATE
       SET accepted_by_public_key = EXCLUDED.accepted_by_public_key,
           accepted_identity_name = EXCLUDED.accepted_identity_name,
           accepted_at = EXCLUDED.accepted_at,
           capability_id = EXCLUDED.capability_id,
           admission_claim = EXCLUDED.admission_claim`,
      [
        invite.invite_id,
        params.familyId,
        identity.identity_id,
        identity.public_key_value,
        null,
        invite.capability_id,
        admissionClaim ? JSON.stringify(admissionClaim) : null
      ]
    );

    if (promotesGuest) {
      await client.query(
        `UPDATE direct_guest_registrations
         SET status = 'promoted', updated_at = NOW()
         WHERE family_id = $1 AND guest_identity_id = $2 AND status = 'active'`,
        [params.familyId, params.identityId]
      );
    }

    return {
      identity,
      inviteId: invite.invite_id,
      inviteCreator: invite.created_by
    };
  });
}
import { isDeepStrictEqual } from 'node:util';
