import type { PublicKey, TemporaryIdentityDelegationCredential } from './types';

/** Explicit, short-lived, one-call subdelegation. Never a permanent membership. */
export type NativeGuestCallClaims = {
  type: 'circlus.native-guest-call.delegation.v1';
  kind: 'external' | 'temporary';
  vpsId: string; circleId: string; callSessionId: string;
  identityId: string; deviceId: string; remoteIdentityId: string;
  serverOrigin: string; role: 'caller' | 'callee';
  identityPublicKey: string; callSigningPublicKey: string;
  createdAt: number; notBefore: number; expiresAt: number;
  temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
};
export type NativeGuestCallCredential = {
  version: 1;
  seed: string;
  delegation: { payload: string; signature: string };
  callCapabilityProof?: import('./linkCapability').LinkCapabilityProof;
  supersedesCallSessionId?: string;
  externalRegistration?: {
    externalIdentityId: string;
    externalPublicKey: PublicKey;
    displayName?: string;
    admission: {
      kind: 'call_link'; callLinkId: string; capabilityId: string;
      capabilityProof: import('./linkCapability').LinkCapabilityProof; targetIdentityId: string;
    } | { kind: 'whitelist_key'; targetIdentityId: string };
  };
};
export type NativeGuestCallScope = Pick<NativeGuestCallClaims,
  'vpsId' | 'circleId' | 'callSessionId' | 'identityId' | 'deviceId' | 'remoteIdentityId' | 'role' | 'serverOrigin'>;

/** Structural checks only. Callers must verify the indicated signatures and
 * recheck server admission/device status. No singleton/origin-based resolution. */
export function parseNativeGuestCallClaims(payload: string, scope: NativeGuestCallScope, now = Date.now() / 1000): NativeGuestCallClaims {
  if (typeof payload !== 'string' || payload.length > 32768) throw new Error('CALL_GUEST_DELEGATION_INVALID');
  const value = JSON.parse(payload) as NativeGuestCallClaims;
  if (value.type !== 'circlus.native-guest-call.delegation.v1' || !['external', 'temporary'].includes(value.kind)) throw new Error('CALL_GUEST_DELEGATION_INVALID');
  for (const field of ['vpsId', 'circleId', 'callSessionId', 'identityId', 'deviceId', 'remoteIdentityId', 'role', 'serverOrigin'] as const) {
    if (typeof scope[field] !== 'string' || !scope[field].trim() || value[field] !== scope[field]) throw new Error('CALL_GUEST_SCOPE_MISMATCH');
  }
  if (!['caller', 'callee'].includes(value.role) || value.identityId === value.remoteIdentityId
      || ![value.createdAt, value.notBefore, value.expiresAt, now].every(Number.isFinite)
      || value.createdAt > now + 30 || value.notBefore > now || value.expiresAt <= now
      || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > 86400
      || value.notBefore < value.createdAt - 30
      || !value.identityPublicKey || !value.callSigningPublicKey) throw new Error('CALL_GUEST_DELEGATION_EXPIRED_OR_INVALID');
  const origin = new URL(value.serverOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== value.serverOrigin) throw new Error('CALL_GUEST_SCOPE_MISMATCH');
  if (value.kind === 'external') {
    // Explicit external-registration-v1 device naming, not a missing-ID fallback.
    if (value.deviceId !== `ext:${value.identityId}` || value.role !== 'caller' || value.temporaryIdentityDelegation) throw new Error('CALL_GUEST_SCOPE_MISMATCH');
  } else {
    const parent = value.temporaryIdentityDelegation;
    const claims = parent?.payload;
    const chat = [value.identityId, value.remoteIdentityId].sort().join('::');
    // temporary-identity-delegation-v1 historically omits envelope route fields.
    // That format never resolves a route: the child scope and server DB do.
    const parentRouteMatches = parent && ((parent.vpsId === undefined && parent.circleId === undefined)
      || (parent.vpsId === value.vpsId && parent.circleId === value.circleId));
    if (!parentRouteMatches || parent?.type !== 'temporary-identity:delegate' || parent.signerId !== value.identityId
        || claims?.version !== 1 || claims.purpose !== 'temporary-identity-delegation-v1'
        || claims.identityId !== value.identityId || claims.temporaryDeviceId !== value.deviceId
        || claims.identityPublicKey?.algorithm !== 'ed25519' || claims.identityPublicKey.value !== value.identityPublicKey
        || claims.temporaryDevicePublicKey?.algorithm !== 'ed25519' || !claims.capabilities.includes('calls')
        || claims.scope.serverOrigin !== value.serverOrigin || !claims.scope.directChatIds?.includes(chat)
        || !Number.isFinite(Date.parse(claims.notBefore)) || !Number.isFinite(Date.parse(claims.expiresAt))
        || Date.parse(claims.notBefore) > now * 1000 || Date.parse(claims.expiresAt) < value.expiresAt * 1000) throw new Error('CALL_GUEST_PARENT_INVALID');
  }
  return value;
}
