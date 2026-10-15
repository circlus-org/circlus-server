import vectors from '../../../shared/test-vectors/native-guest-call-v1.json';
import type { NativeGuestCallScope } from '../../../shared/nativeGuestCall';
import { verifyNativeGuestCallDelegation } from './nativeGuestCallDelegation';

describe('native guest call certificate crypto and exact routing', () => {
  test.each(vectors.cases)('$name binds two Circles on the same origin independently', async vector => {
    const scope = vector.scope as NativeGuestCallScope;
    expect(await verifyNativeGuestCallDelegation(vector.delegation, scope, vector.now)).not.toBeNull();
    for (const field of Object.keys(scope)) {
      expect(await verifyNativeGuestCallDelegation(vector.delegation, { ...scope, [field]: undefined } as unknown as NativeGuestCallScope, vector.now)).toBeNull();
      expect(await verifyNativeGuestCallDelegation(vector.delegation, { ...scope, [field]: 'mismatch' } as NativeGuestCallScope, vector.now)).toBeNull();
    }
    const claims = JSON.parse(vector.delegation.payload);
    expect(await verifyNativeGuestCallDelegation(vector.delegation, scope, claims.expiresAt)).toBeNull();
    expect(await verifyNativeGuestCallDelegation(vector.delegation, scope, claims.notBefore - 1)).toBeNull();
    expect(await verifyNativeGuestCallDelegation({ ...vector.delegation, signature: Buffer.alloc(64).toString('base64') }, scope, vector.now)).toBeNull();
    if (claims.temporaryIdentityDelegation) {
      for (const mutation of [
        (p: any) => { p.capabilities = ['messages']; },
        (p: any) => { p.scope.directChatIds = []; },
        (p: any) => { p.temporaryDeviceId = 'other'; },
        (p: any) => { p.expiresAt = new Date((vector.now - 1) * 1000).toISOString(); }
      ]) {
        const value = JSON.parse(vector.delegation.payload); mutation(value.temporaryIdentityDelegation.payload);
        expect(await verifyNativeGuestCallDelegation({ ...vector.delegation, payload: JSON.stringify(value) }, scope, vector.now)).toBeNull();
      }
    }
  });
});
