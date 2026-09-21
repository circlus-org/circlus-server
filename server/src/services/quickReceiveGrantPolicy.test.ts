import type { QuickReceiveGrant } from '@shared/types';
import { validateQuickReceiveGrant } from './quickReceiveGrantPolicy';

const grant: QuickReceiveGrant = {
  type: 'direct-file:auto-receive-grant',
  timestamp: 1,
  nonce: 'nonce',
  signerId: 'receiver',
  signature: 'signature',
  payload: {
    version: 1,
    purpose: 'direct-file-auto-receive-v1',
    grantId: 'grant',
    receiverIdentityId: 'receiver',
    targetDeviceId: 'device',
    authorizedSenderIdentityId: 'sender',
    issuedAt: new Date(0).toISOString(),
    maxFileSizeBytes: 100
  }
};

const validParams = {
  grant,
  senderIdentityId: 'sender',
  targetIdentityId: 'receiver',
  targetDeviceId: 'device',
  fileSize: 100,
  targetIdentity: {
    status: 'active',
    publicKey: { algorithm: 'ed25519' as const, value: 'public-key' }
  },
  targetDevice: { status: 'active', identityId: 'receiver' },
  verify: () => true
};

describe('validateQuickReceiveGrant', () => {
  it('accepts an exact receiver/sender/device capability', () => {
    expect(validateQuickReceiveGrant(validParams)).toBe(true);
  });

  it.each([
    ['sender', { senderIdentityId: 'attacker' }],
    ['device', { targetDeviceId: 'other-device' }],
    ['receiver', { targetIdentityId: 'other-receiver' }],
    ['size', { fileSize: 101 }]
  ])('rejects a mismatched %s', (_label, override) => {
    expect(validateQuickReceiveGrant({ ...validParams, ...override })).toBe(false);
  });

  it('rejects an invalid signature', () => {
    expect(validateQuickReceiveGrant({ ...validParams, verify: () => false })).toBe(false);
  });

  it('rejects legacy grants that expose a device label', () => {
    expect(validateQuickReceiveGrant({
      ...validParams,
      grant: {
        ...grant,
        payload: { ...grant.payload, targetDeviceLabel: 'Private phone name' }
      } as QuickReceiveGrant
    })).toBe(false);
  });
});
