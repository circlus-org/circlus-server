import nacl from 'tweetnacl';
import { createSignatureMessage } from '../../../shared/signatureMessage';
import type { DirectMessageReadProof, DirectMessageReadReceipt, PublicKey } from '../../../shared/types';
import { verifyDirectMessageReadProof } from './directMessageReadProof';

const pair = nacl.sign.keyPair();
const publicKey: PublicKey = { algorithm: 'ed25519', value: Buffer.from(pair.publicKey).toString('base64') };

function signedProof(ids = ['message-1', 'message-2']): DirectMessageReadProof {
  const unsigned = {
    type: 'msg:read-receipt', timestamp: Date.now(), nonce: 'nonce', signerId: 'recipient',
    payload: {
      version: 1 as const, purpose: 'direct-message-read-v1' as const, readTimeVisible: true,
      senderIdentityId: 'sender', recipientIdentityId: 'recipient',
      recipientDeviceId: 'device-1', serverMessageIds: ids
    }
  };
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(createSignatureMessage(unsigned)), pair.secretKey)).toString('base64');
  return { receipt: { ...unsigned, signature } as DirectMessageReadReceipt };
}

test('accepts a bounded read batch signed by the recipient', () => {
  const proof = signedProof();
  const verify = (candidate: DirectMessageReadProof, recipientDeviceId = 'device-1') => verifyDirectMessageReadProof({
    proof: candidate, senderIdentityId: 'sender', recipientIdentityId: 'recipient',
    recipientDeviceId, recipientIdentityPublicKey: publicKey
  });
  expect(verify(proof)).toBe(true);
  expect(verify(proof, 'device-2')).toBe(false);
  expect(verify({ receipt: { ...proof.receipt, payload: { ...proof.receipt.payload, senderIdentityId: 'other' } } })).toBe(false);
  expect(verify(signedProof(['message-1', 'message-1']))).toBe(false);
  expect(verify(signedProof(Array.from({ length: 101 }, (_, index) => `message-${index}`)))).toBe(false);
});

test('accepts an older timestamp only for a time-free signed read claim', () => {
  const proof = signedProof();
  const oldTime = Date.now() - 60 * 60_000;
  const hidden = { receipt: { ...proof.receipt, timestamp: oldTime,
    payload: { ...proof.receipt.payload, readTimeVisible: false } } };
  const unsigned = { ...hidden.receipt };
  delete (unsigned as { signature?: string }).signature;
  hidden.receipt.signature = Buffer.from(nacl.sign.detached(
    Buffer.from(createSignatureMessage(unsigned)), pair.secretKey
  )).toString('base64');
  const verify = (candidate: DirectMessageReadProof) => verifyDirectMessageReadProof({
    proof: candidate, senderIdentityId: 'sender', recipientIdentityId: 'recipient',
    recipientDeviceId: 'device-1', recipientIdentityPublicKey: publicKey
  });
  expect(verify(hidden)).toBe(true);
  expect(verify({ receipt: { ...hidden.receipt, payload: { ...hidden.receipt.payload, readTimeVisible: true } } })).toBe(false);
});
