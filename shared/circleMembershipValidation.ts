import type { CircleMembershipEntry, CircleMembershipStatePayload, PublicKey } from './types';

export const CIRCLE_MEMBERSHIP_PROTOCOL_VERSION = 2 as const;
export const CIRCLE_MEMBERSHIP_PURPOSE = 'circle-membership-state-v2' as const;

const STATE_ID = /^cms_[A-Za-z0-9_-]{12,}$/;

export function sameMembershipPublicKey(left: PublicKey, right: PublicKey): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

export function membershipEntryCanCreateInvites(entry: CircleMembershipEntry | null | undefined): boolean {
  return Boolean(entry && (entry.role === 'owner' || entry.permissions?.canCreateInvites === true));
}

export function validMembershipPermissions(entry: CircleMembershipEntry): boolean {
  const permissions = entry.permissions;
  if (permissions === undefined) return true;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;
  const keys = Object.keys(permissions);
  return keys.length === 1
    && keys[0] === 'canCreateInvites'
    && typeof permissions.canCreateInvites === 'boolean'
    && (entry.role !== 'owner' || permissions.canCreateInvites === true);
}

export function equivalentMembershipEntryExceptInvitePermission(
  left: CircleMembershipEntry | undefined,
  right: CircleMembershipEntry | undefined
): boolean {
  return Boolean(left && right
    && left.identityId === right.identityId
    && left.role === right.role
    && sameMembershipPublicKey(left.publicKey, right.publicKey));
}

export function equivalentMembershipEntry(
  left: CircleMembershipEntry | undefined,
  right: CircleMembershipEntry | undefined
): boolean {
  return equivalentMembershipEntryExceptInvitePermission(left, right)
    && membershipEntryCanCreateInvites(left) === membershipEntryCanCreateInvites(right);
}

export function validateMembershipPayloadShape(payload: CircleMembershipStatePayload | null | undefined): boolean {
  if (!payload
    || payload.version !== CIRCLE_MEMBERSHIP_PROTOCOL_VERSION
    || payload.purpose !== CIRCLE_MEMBERSHIP_PURPOSE
    || !String(payload.vpsId || '').trim()
    || !String(payload.circleId || '').trim()
    || !STATE_ID.test(payload.stateId)
    || !Number.isInteger(payload.sequence)
    || payload.sequence < 1
    || payload.members.length === 0) return false;
  const ids = payload.members.map((entry) => entry.identityId);
  return ids.every(Boolean)
    && new Set(ids).size === ids.length
    && ids.every((id, index) => index === 0 || ids[index - 1]!.localeCompare(id) < 0)
    && payload.members.every((entry) => (
      (entry.role === 'owner' || entry.role === 'member')
      && entry.publicKey?.algorithm === 'ed25519'
      && Boolean(entry.publicKey.value)
      && validMembershipPermissions(entry)
    ))
    && payload.members.filter((entry) => entry.role === 'owner').length === 1
    && payload.members.some((entry) => entry.identityId === payload.ownerIdentityId && entry.role === 'owner');
}

export function membershipTransitionDiff(previous: CircleMembershipStatePayload, next: CircleMembershipStatePayload) {
  const oldById = new Map(previous.members.map((entry) => [entry.identityId, entry]));
  const nextById = new Map(next.members.map((entry) => [entry.identityId, entry]));
  return {
    oldById,
    nextById,
    added: next.members.filter((entry) => !oldById.has(entry.identityId)),
    removed: previous.members.filter((entry) => !nextById.has(entry.identityId)),
  };
}
