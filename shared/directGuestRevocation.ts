import type { IdentityId, PublicKey, SignedRequest } from './types';

export type DirectGuestRevocationPayload = {
  version: 1;
  purpose: 'circlus-direct-guest-revocation-v1';
  circleOrigin: string;
  registrationId: string;
  linkId: string;
  hostIdentityId: string;
  guestIdentityId: string;
};
export type DirectGuestRevocation = SignedRequest<DirectGuestRevocationPayload, IdentityId>;
export type DirectGuestRevocationNotice = { revocation: DirectGuestRevocation; hostIdentityPublicKey: PublicKey };

export function matchesDirectGuestRevocation(revocation: DirectGuestRevocation | null | undefined, expected: {
  circleOrigin: string; registrationId: string; linkId: string; hostIdentityId: string; guestIdentityId: string;
}): boolean {
  if (!revocation || revocation.type !== 'direct-guest:revocation' || revocation.signerId !== expected.hostIdentityId) return false;
  const p = revocation.payload;
  return !!p && p.version === 1 && p.purpose === 'circlus-direct-guest-revocation-v1'
    && p.circleOrigin === expected.circleOrigin && p.registrationId === expected.registrationId
    && p.linkId === expected.linkId && p.hostIdentityId === expected.hostIdentityId
    && p.guestIdentityId === expected.guestIdentityId
    && [expected.circleOrigin, expected.registrationId, expected.linkId, expected.hostIdentityId, expected.guestIdentityId].every((value) => typeof value === 'string' && value.length > 0)
    && typeof revocation.timestamp === 'number' && Number.isFinite(revocation.timestamp);
}
