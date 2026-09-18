import type { IdentityId, PublicKey, SignedRequest } from './types';

export type DirectGuestDeparturePayload = {
  version: 1;
  purpose: 'circlus-direct-guest-departure-v1';
  circleOrigin: string;
  registrationId: string;
  linkId: string;
  hostIdentityId: string;
  guestIdentityId: string;
};
export type DirectGuestDeparture = SignedRequest<DirectGuestDeparturePayload, IdentityId>;
export type DirectGuestDepartureNotice = { departure: DirectGuestDeparture; guestIdentityPublicKey: PublicKey };

export function matchesDirectGuestDeparture(departure: DirectGuestDeparture | null | undefined, expected: {
  circleOrigin: string; registrationId: string; linkId: string; hostIdentityId: string; guestIdentityId: string;
}): boolean {
  if (!departure || departure.type !== 'direct-guest:departure' || departure.signerId !== expected.guestIdentityId) return false;
  const p = departure.payload;
  return !!p && p.version === 1 && p.purpose === 'circlus-direct-guest-departure-v1'
    && p.circleOrigin === expected.circleOrigin && p.registrationId === expected.registrationId
    && p.linkId === expected.linkId && p.hostIdentityId === expected.hostIdentityId
    && p.guestIdentityId === expected.guestIdentityId
    && [expected.circleOrigin, expected.registrationId, expected.linkId, expected.hostIdentityId, expected.guestIdentityId].every((value) => typeof value === 'string' && value.length > 0)
    && typeof departure.timestamp === 'number' && Number.isFinite(departure.timestamp);
}
