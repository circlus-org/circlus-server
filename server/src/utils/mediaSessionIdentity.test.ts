import { deriveIceSubjectIds, normalizeMediaCallSessionId } from './mediaSessionIdentity';

const SHARED_SECRET = Buffer.alloc(32, 7).toString('base64');

describe('media session identity', () => {
  test('derives stable opaque circle and call subjects', () => {
    const first = deriveIceSubjectIds({
      familyId: 'family-private-id',
      purpose: 'call',
      callSessionId: 'call_temp_123',
      sharedSecretBase64: SHARED_SECRET
    });
    const second = deriveIceSubjectIds({
      familyId: 'family-private-id',
      purpose: 'call',
      callSessionId: 'call_temp_123',
      sharedSecretBase64: SHARED_SECRET
    });

    expect(first).toEqual(second);
    expect(first.circleSubjectId).toMatch(/^cs1_[A-Za-z0-9_-]{22}$/);
    expect(first.mediaSessionId).toMatch(/^ms1_[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(first)).not.toContain('family-private-id');
    expect(JSON.stringify(first)).not.toContain('call_temp_123');
  });

  test('separates calls, circles and purposes', () => {
    const call = deriveIceSubjectIds({
      familyId: 'family-1',
      purpose: 'call',
      callSessionId: 'session-1',
      sharedSecretBase64: SHARED_SECRET
    });
    const otherCall = deriveIceSubjectIds({
      familyId: 'family-1',
      purpose: 'call',
      callSessionId: 'session-2',
      sharedSecretBase64: SHARED_SECRET
    });
    const transfer = deriveIceSubjectIds({
      familyId: 'family-1',
      purpose: 'file-transfer',
      callSessionId: 'session-1',
      sharedSecretBase64: SHARED_SECRET
    });
    const otherCircle = deriveIceSubjectIds({
      familyId: 'family-2',
      purpose: 'call',
      callSessionId: 'session-1',
      sharedSecretBase64: SHARED_SECRET
    });

    expect(call.mediaSessionId).not.toBe(otherCall.mediaSessionId);
    expect(call.mediaSessionId).not.toBe(transfer.mediaSessionId);
    expect(call.circleSubjectId).not.toBe(otherCircle.circleSubjectId);
  });

  test('accepts current call ids and rejects unsafe or oversized values', () => {
    expect(normalizeMediaCallSessionId(' call_temp_1779867461351 ')).toBe('call_temp_1779867461351');
    expect(normalizeMediaCallSessionId('call:a.b-c_1')).toBe('call:a.b-c_1');
    expect(normalizeMediaCallSessionId('')).toBeNull();
    expect(normalizeMediaCallSessionId('call id')).toBeNull();
    expect(normalizeMediaCallSessionId(`call_${'a'.repeat(128)}`)).toBeNull();
  });
});
