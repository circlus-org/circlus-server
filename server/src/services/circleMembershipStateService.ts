import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type {
  CircleIdentityAdmissionProof,
  CircleMembershipEntry,
  CircleMembershipStateClaim,
  CircleMembershipStateRecord,
  PublicKey,
  SignedRequest,
} from '../../../shared/types';
import {
  membershipEntryCanCreateInvites,
  membershipTransitionDiff,
  sameMembershipPublicKey,
  validateMembershipPayloadShape,
} from '../../../shared/circleMembershipValidation';
import { canonicalizeJson } from '../../../shared/signatureMessage';
import { pool } from '../db';
import { verifySignedRequest } from '../utils/crypto';
import { verifyCapabilityProof } from './linkCapabilityService';

type StoredRow = {
  claim: CircleMembershipStateClaim;
  admission: CircleIdentityAdmissionProof['admission'];
};

function hashMembershipClaim(claim: CircleMembershipStateClaim): string {
  return createHash('sha256').update(canonicalizeJson(claim), 'utf8').digest('base64url');
}

function sameKey(left: PublicKey, right: PublicKey): boolean {
  return sameMembershipPublicKey(left, right);
}

function canCreateInvites(entry: CircleMembershipEntry | null | undefined): boolean {
  return membershipEntryCanCreateInvites(entry);
}

function equivalentExceptInvitePermission(left: CircleMembershipEntry | undefined, right: CircleMembershipEntry | undefined): boolean {
  if (!left || !right) return false;
  return left.identityId === right.identityId
    && left.role === right.role
    && sameKey(left.publicKey, right.publicKey);
}

function sameEntry(left: CircleMembershipEntry | undefined, right: CircleMembershipEntry | undefined): boolean {
  return Boolean(
    equivalentExceptInvitePermission(left, right)
    && canCreateInvites(left) === canCreateInvites(right)
  );
}

function replaysCircleInviteClaim(
  record: CircleMembershipStateRecord,
  history: CircleMembershipStateRecord[]
): boolean {
  const admission = record.admission;
  if (!admission || admission.kind !== 'circle_invite') return true;

  const mode = admission.descriptor.payload.mode;
  const claimId = String(admission.claim.capabilityProof.payload.claimId || '').trim();
  if ((mode !== 'single-use' && mode !== 'unlimited') || !claimId) return true;

  const previousUses = history.flatMap((state) => (
    state.admission?.kind === 'circle_invite'
    && state.admission.capabilityId === admission.capabilityId
      ? [state.admission]
      : []
  ));
  if (previousUses.length === 0) return false;
  if (mode === 'single-use') return true;

  return previousUses.some((previousUse) => (
    previousUse.descriptor.payload.mode !== 'unlimited'
    || previousUse.descriptor.signature !== admission.descriptor.signature
    || previousUse.claim.capabilityProof.payload.claimId === claimId
  ));
}

function validateAddAuthorization(params: {
  record: CircleMembershipStateRecord;
  added: CircleMembershipEntry;
  previous: CircleMembershipStateClaim;
}): boolean {
  const { record, added, previous } = params;
  const admission = record.admission;
  if (!admission || admission.kind !== 'circle_invite') return false;
  if (
    record.claim.signerId !== admission.capabilityId
    || admission.descriptor.payload.capabilityId !== admission.capabilityId
    || admission.issuerIdentityId !== admission.descriptor.payload.issuerIdentityId
    || admission.descriptor.payload.targetIdentityId !== admission.issuerIdentityId
    || !verifySignedRequest(record.claim, admission.descriptor.payload.capabilityPublicKey)
  ) return false;
  const issuer = previous.payload.members.find((entry) => (
    entry.identityId === admission.issuerIdentityId
    && sameKey(entry.publicKey, admission.issuerPublicKey)
  ));
  const permissionAwareInvite = Object.prototype.hasOwnProperty.call(admission.descriptor.payload.scope || {}, 'membershipCheckpoint')
    || previous.payload.members.some((entry) => entry.permissions !== undefined);
  if (
    !issuer
    || (permissionAwareInvite && !canCreateInvites(issuer))
    || canCreateInvites(added)
  ) return false;
  const claim = admission.claim;
  const acceptance = claim.subjectAcceptance;
  return verifySignedRequest(admission.descriptor, admission.issuerPublicKey)
    && verifyCapabilityProof({
      proof: claim.capabilityProof,
      descriptor: admission.descriptor,
      expectedAction: 'circle-invite:claim',
      expectedSubjectIdentityId: added.identityId,
      expectedSubjectPublicKey: added.publicKey,
    })
    && acceptance.signerId === added.identityId
    && sameKey(acceptance.payload.identityPublicKey, added.publicKey)
    && acceptance.payload.claimId === claim.capabilityProof.payload.claimId
    && verifySignedRequest(acceptance as SignedRequest<unknown>, added.publicKey);
}

export function validateCircleMembershipStateTransition(params: {
  record: CircleMembershipStateRecord;
  previous: CircleMembershipStateClaim | null;
  history?: CircleMembershipStateRecord[];
}): { ok: true } | { ok: false; message: string } {
  const { record, previous } = params;
  const claim = record?.claim;
  const payload = claim?.payload;
  if (
    !claim
    || claim.type !== 'circle:membership-state'
    || !validateMembershipPayloadShape(payload)
  ) return { ok: false, message: 'Invalid Circle membership state' };

  if (!previous) {
    const owner = payload.members.find((entry) => entry.identityId === payload.ownerIdentityId)!;
    const valid = payload.action === 'genesis'
      && payload.sequence === 1
      && payload.previousStateId === null
      && (payload.previousStateHash === null || payload.previousStateHash === undefined)
      && payload.subjectIdentityId === payload.ownerIdentityId
      && claim.signerId === payload.ownerIdentityId
      && record.admission === null
      && verifySignedRequest(claim, owner.publicKey);
    return valid ? { ok: true } : { ok: false, message: 'Invalid Circle membership genesis' };
  }

  if (
    payload.vpsId !== previous.payload.vpsId
    || payload.circleId !== previous.payload.circleId
    || payload.sequence !== previous.payload.sequence + 1
    || payload.previousStateId !== previous.payload.stateId
    || (payload.previousStateHash !== undefined
      && payload.previousStateHash !== hashMembershipClaim(previous))
  ) return { ok: false, message: 'Circle membership compare-and-swap conflict' };

  const { oldById, nextById, added, removed } = membershipTransitionDiff(previous.payload, payload);
  const owner = oldById.get(previous.payload.ownerIdentityId);
  if (!owner) return { ok: false, message: 'Previous Circle owner is missing' };

  if (payload.action === 'add') {
    const replayedCapability = replaysCircleInviteClaim(record, params.history || []);
    const previouslyAdmittedIdentity = Boolean(added[0] && (params.history || []).some((state) => (
      state.claim.payload.members.some((entry) => entry.identityId === added[0]!.identityId)
    )));
    const unchanged = previous.payload.members.every((entry) => sameEntry(nextById.get(entry.identityId), entry));
    const valid = added.length === 1
      && removed.length === 0
      && unchanged
      && payload.ownerIdentityId === previous.payload.ownerIdentityId
      && payload.subjectIdentityId === added[0]!.identityId
      && !replayedCapability
      && !previouslyAdmittedIdentity
      && validateAddAuthorization({ record, added: added[0]!, previous });
    return valid ? { ok: true } : { ok: false, message: 'Invalid Circle member addition' };
  }

  if (payload.action === 'remove' && claim.signerId === payload.subjectIdentityId && record.admission === null) {
    const removedMember = removed[0];
    const unchanged = payload.members.every((entry) => sameEntry(oldById.get(entry.identityId), entry));
    const valid = removed.length === 1
      && added.length === 0
      && unchanged
      && payload.ownerIdentityId === previous.payload.ownerIdentityId
      && removedMember?.identityId === payload.subjectIdentityId
      && removedMember.identityId !== previous.payload.ownerIdentityId
      && verifySignedRequest(claim, removedMember.publicKey);
    return valid ? { ok: true } : { ok: false, message: 'Invalid Circle member self-removal' };
  }

  if (claim.signerId !== previous.payload.ownerIdentityId || !verifySignedRequest(claim, owner.publicKey)) {
    return { ok: false, message: 'Invalid Circle owner signature' };
  }
  if (record.admission !== null) return { ok: false, message: 'Unexpected Circle transition admission' };

  if (payload.action === 'repair') {
    const valid = previous.payload.action === 'genesis'
      && previous.payload.sequence === 1
      && payload.sequence === 2
      && payload.ownerIdentityId === previous.payload.ownerIdentityId
      && payload.subjectIdentityId === previous.payload.ownerIdentityId
      && added.length === 0
      && payload.members.length === 1
      && payload.members[0]?.identityId === previous.payload.ownerIdentityId
      && payload.members[0]?.role === 'owner'
      && sameKey(payload.members[0]!.publicKey, owner.publicKey)
      && removed.every((entry) => entry.identityId !== previous.payload.ownerIdentityId);
    return valid ? { ok: true } : { ok: false, message: 'Invalid Circle membership repair' };
  }

  if (payload.action === 'remove') {
    const valid = removed.length === 1
      && added.length === 0
      && payload.ownerIdentityId === previous.payload.ownerIdentityId
      && payload.subjectIdentityId === removed[0]!.identityId
      && removed[0]!.identityId !== previous.payload.ownerIdentityId
      && payload.members.every((entry) => sameEntry(oldById.get(entry.identityId), entry));
    return valid ? { ok: true } : { ok: false, message: 'Invalid Circle member removal' };
  }

  if (payload.action === 'restore') {
    const valid = added.length === 1 && removed.length === 0
      && payload.ownerIdentityId === previous.payload.ownerIdentityId
      && payload.subjectIdentityId === added[0]!.identityId
      && previous.payload.members.every((entry) => sameEntry(nextById.get(entry.identityId), entry))
      && !canCreateInvites(added[0]);
    return valid ? { ok: true } : { ok: false, message: 'Invalid Circle member restoration' };
  }

  if (payload.action === 'transfer_owner') {
    const subject = payload.subjectIdentityId ? nextById.get(payload.subjectIdentityId) : null;
    const previousOwnerNext = nextById.get(previous.payload.ownerIdentityId);
    const exactRoleChange = payload.members.every((entry) => {
      const old = oldById.get(entry.identityId);
      if (!old || !sameKey(old.publicKey, entry.publicKey)) return false;
      const expectedRole = entry.identityId === payload.subjectIdentityId
        ? 'owner'
        : entry.identityId === previous.payload.ownerIdentityId
          ? 'member'
          : old.role;
      const expectedInvitePermission = entry.identityId === payload.subjectIdentityId
        ? true
        : entry.identityId === previous.payload.ownerIdentityId
          ? old.permissions?.canCreateInvites === true && old.role !== 'owner'
          : canCreateInvites(old);
      return entry.role === expectedRole
        && canCreateInvites(entry) === expectedInvitePermission;
    });
    const valid = added.length === 0 && removed.length === 0
      && exactRoleChange
      && subject?.role === 'owner'
      && previousOwnerNext?.role === 'member'
      && payload.ownerIdentityId === subject.identityId;
    return valid ? { ok: true } : { ok: false, message: 'Invalid Circle ownership transfer' };
  }

  if (payload.action === 'set_invite_permission') {
    const subject = payload.subjectIdentityId ? nextById.get(payload.subjectIdentityId) : null;
    const previousSubject = payload.subjectIdentityId ? oldById.get(payload.subjectIdentityId) : null;
    const unchangedExceptSubjectPermission = payload.members.every((entry) => {
      const old = oldById.get(entry.identityId);
      if (!old) return false;
      if (entry.identityId === payload.subjectIdentityId) {
        return equivalentExceptInvitePermission(old, entry)
          && canCreateInvites(old) !== canCreateInvites(entry);
      }
      return sameEntry(old, entry);
    });
    const valid = added.length === 0
      && removed.length === 0
      && payload.ownerIdentityId === previous.payload.ownerIdentityId
      && Boolean(subject)
      && Boolean(previousSubject)
      && subject?.role === 'member'
      && unchangedExceptSubjectPermission;
    return valid ? { ok: true } : { ok: false, message: 'Invalid Circle invite permission transition' };
  }

  return { ok: false, message: 'Unsupported Circle membership action' };
}

export async function listCircleMembershipStates(
  familyId: string,
  client?: PoolClient
): Promise<CircleMembershipStateRecord[]> {
  const result = await (client || pool).query<StoredRow>(
    `SELECT claim, admission
       FROM circle_membership_states
      WHERE family_id = $1
      ORDER BY sequence ASC`,
    [familyId]
  );
  return result.rows.map((row) => ({ claim: row.claim, admission: row.admission }));
}

export async function appendCircleMembershipState(params: {
  familyId: string;
  record: CircleMembershipStateRecord;
  client: PoolClient;
}): Promise<void> {
  const existing = await listCircleMembershipStates(params.familyId, params.client);
  const previous = existing.at(-1)?.claim || null;
  const validation = validateCircleMembershipStateTransition({
    record: params.record,
    previous,
    history: existing,
  });
  if (!validation.ok) throw new Error(validation.message);
  await params.client.query(
    `INSERT INTO circle_membership_states (
       family_id, sequence, state_id, previous_state_id, action,
       subject_identity_id, claim, admission
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [
      params.familyId,
      params.record.claim.payload.sequence,
      params.record.claim.payload.stateId,
      params.record.claim.payload.previousStateId,
      params.record.claim.payload.action,
      params.record.claim.payload.subjectIdentityId,
      JSON.stringify(params.record.claim),
      params.record.admission ? JSON.stringify(params.record.admission) : null,
    ]
  );
}
