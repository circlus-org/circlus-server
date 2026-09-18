import type { GroupEpochTransitionClaim, PublicKey } from '../../../shared/types';
import {
  isSha256Hex,
  parseGk2PublisherIdentityId,
  validateGroupEpochTransitionClaim
} from './groupChatEpochValidation';

const publicKey: PublicKey = { algorithm: 'ed25519', value: 'public-key' };

function createClaim(): GroupEpochTransitionClaim {
  return {
    type: 'grp:epoch-transition',
    signerId: 'device-1',
    signature: 'signature',
    payload: {
      version: 1,
      purpose: 'group-epoch-transition-v1',
      chatId: 'chat-1',
      epoch: 2,
      previousEpoch: 1,
      keyCommitment: 'a'.repeat(64),
      proposerIdentityId: 'identity-1',
      proposerDeviceId: 'device-1'
    }
  };
}

describe('group chat epoch validation', () => {
  it('validates commitment and envelope formats', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('z'.repeat(64))).toBe(false);
    expect(parseGk2PublisherIdentityId('gk2:identity-1:ciphertext')).toBe('identity-1');
    expect(parseGk2PublisherIdentityId('gk1:ciphertext')).toBeNull();
  });

  it('accepts a matching signed transition', () => {
    const verifyClaim = jest.fn(() => true);

    expect(validateGroupEpochTransitionClaim({
      claim: createClaim(),
      chatId: 'chat-1',
      epoch: 2,
      previousEpoch: 1,
      keyCommitment: 'a'.repeat(64),
      proposerIdentityId: 'identity-1',
      proposerDeviceId: 'device-1',
      proposerDevicePublicKey: publicKey,
      verifyClaim
    })).toEqual({ ok: true });
    expect(verifyClaim).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched payloads before signature verification', () => {
    const verifyClaim = jest.fn(() => true);

    expect(validateGroupEpochTransitionClaim({
      claim: createClaim(),
      chatId: 'different-chat',
      epoch: 2,
      previousEpoch: 1,
      keyCommitment: 'a'.repeat(64),
      proposerIdentityId: 'identity-1',
      proposerDeviceId: 'device-1',
      proposerDevicePublicKey: publicKey,
      verifyClaim
    })).toEqual({ ok: false, message: 'Epoch transition payload mismatch' });
    expect(verifyClaim).not.toHaveBeenCalled();
  });
});
