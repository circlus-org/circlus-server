import { deriveIdentityIdFromPublicKey } from '../../../shared/identityId';
import { parseNativeGuestCallClaims, type NativeGuestCallClaims, type NativeGuestCallScope } from '../../../shared/nativeGuestCall';
import { verifySignature, verifySignedRequest } from '../utils/crypto';

export async function verifyNativeGuestCallDelegation(
  delegation: { payload?: string; signature?: string } | undefined,
  scope: NativeGuestCallScope,
  now = Date.now() / 1000
): Promise<NativeGuestCallClaims | null> {
  try {
    if (!delegation?.payload || !delegation.signature) return null;
    const claims = parseNativeGuestCallClaims(delegation.payload, scope, now);
    const identityKey = { algorithm: 'ed25519' as const, value: claims.identityPublicKey };
    if (await deriveIdentityIdFromPublicKey(identityKey) !== claims.identityId) return null;
    const parent = claims.temporaryIdentityDelegation;
    if (parent && !verifySignedRequest(parent, identityKey)) return null;
    const signer = parent?.payload.temporaryDevicePublicKey ?? identityKey;
    return verifySignature(delegation.payload, delegation.signature, signer) ? claims : null;
  } catch { return null; }
}
