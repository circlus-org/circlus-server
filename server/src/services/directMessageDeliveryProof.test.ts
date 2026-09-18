import nacl from 'tweetnacl';
import { createSignatureMessage } from '../../../shared/signatureMessage';
import type { DirectMessageDeliveryProof, DirectMessageDeliveryReceipt, PublicKey } from '../../../shared/types';
import { verifyDirectMessageDeliveryProof } from './directMessageDeliveryProof';

const pair = nacl.sign.keyPair();
const publicKey: PublicKey = { algorithm: 'ed25519', value: Buffer.from(pair.publicKey).toString('base64') };
const message = {
  server_message_id: 'server-1', client_message_id: 'client-1',
  author_claim: { signature: 'author-signature' },
  sender_identity_id: 'sender', recipient_identity_id: 'recipient'
};

function signedProof(): DirectMessageDeliveryProof {
  const unsigned = {
    type: 'msg:delivery-receipt', timestamp: Date.now(), nonce: 'nonce', signerId: 'recipient',
    payload: {
      version: 1 as const, purpose: 'direct-message-delivery-v1' as const,
      serverMessageId: 'server-1', clientMessageId: 'client-1',
      authorClaimSignature: 'author-signature', senderIdentityId: 'sender',
      recipientIdentityId: 'recipient', recipientDeviceId: 'device-1'
    }
  };
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(createSignatureMessage(unsigned)), pair.secretKey)).toString('base64');
  return { receipt: { ...unsigned, signature } as DirectMessageDeliveryReceipt };
}

test('accepts only a recipient-signed proof bound to this message and device', () => {
  const proof = signedProof();
  const verify = (candidate: DirectMessageDeliveryProof, deviceId = 'device-1') => verifyDirectMessageDeliveryProof({
    proof: candidate, message, recipientDeviceId: deviceId, recipientIdentityPublicKey: publicKey
  });
  expect(verify(proof)).toBe(true);
  expect(verify(proof, 'device-2')).toBe(false);
  expect(verify({ receipt: { ...proof.receipt, payload: { ...proof.receipt.payload, clientMessageId: 'other' } } })).toBe(false);
  expect(verify({ receipt: { ...proof.receipt, payload: { ...proof.receipt.payload, authorClaimSignature: 'other' } } })).toBe(false);
});
