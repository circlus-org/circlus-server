jest.mock('../utils/crypto', () => ({ verifySignedRequest: jest.fn(() => true) }));

import type { DirectMessageAuthorClaim, PublicKey } from '@shared/types';
import { verifySignedRequest } from '../utils/crypto';
import { validateDirectMessageAuthorClaim } from './directMessageTrustProtocol';

const mockVerifySignedRequest = verifySignedRequest as jest.MockedFunction<typeof verifySignedRequest>;

const publicKey: PublicKey = { algorithm: 'ed25519', value: 'sender-key' };

function claim(): DirectMessageAuthorClaim {
  return {
    type: 'msg:author',
    timestamp: 1,
    nonce: 'nonce',
    signerId: 'a',
    payload: {
      version: 1,
      purpose: 'direct-message-author-v1',
      action: 'edit',
      directChatId: 'a::b',
      senderIdentityId: 'a',
      recipientIdentityId: 'b',
      clientMessageId: 'm1',
      clientCreatedAt: 123,
      epoch: 2,
      revision: 3,
      ciphertext: 'dcm1:recipient',
      senderCiphertext: 'dcm1:sender',
      senderSignature: 'plaintext-signature'
    },
    signature: 'claim-signature'
  };
}

describe('direct message author claims', () => {
  const common = {
    action: 'edit' as const,
    senderIdentityId: 'a',
    recipientIdentityId: 'b',
    clientMessageId: 'm1',
    clientCreatedAt: 123,
    epoch: 2,
    revision: 3,
    ciphertext: 'dcm1:recipient',
    senderCiphertext: 'dcm1:sender',
    senderSignature: 'plaintext-signature',
    senderPublicKey: publicKey,
    temporaryDevice: false
  };

  it('binds the stable id, participants, revision and ciphertext copies', () => {
    expect(validateDirectMessageAuthorClaim({ ...common, claim: claim() })).toBe(true);
    expect(validateDirectMessageAuthorClaim({ ...common, claim: claim(), revision: 2 })).toBe(false);
    expect(validateDirectMessageAuthorClaim({ ...common, claim: claim(), ciphertext: 'dcm1:rollback' })).toBe(false);
    expect(validateDirectMessageAuthorClaim({ ...common, claim: claim(), recipientIdentityId: 'c' })).toBe(false);
  });

  it('requires a permanent identity signature outside delegated temporary access', () => {
    mockVerifySignedRequest.mockReturnValueOnce(false);
    expect(validateDirectMessageAuthorClaim({ ...common, claim: claim() })).toBe(false);
  });
});
