import type { DirectMessageDeliveryProof, PublicKey } from '../../../shared/types';
import { verifySignedRequest } from '../utils/crypto';

export function verifyDirectMessageDeliveryProof(params: {
  proof: DirectMessageDeliveryProof | null | undefined;
  message: {
    server_message_id: string;
    client_message_id: string;
    author_claim?: { signature: string } | null;
    sender_identity_id: string;
    recipient_identity_id: string;
  };
  recipientDeviceId: string;
  recipientIdentityPublicKey: PublicKey;
}): boolean {
  try {
    const { proof, message } = params;
    const receipt = proof?.receipt;
    const payload = receipt?.payload;
    if (!receipt || !payload || !message.author_claim?.signature
      || receipt.type !== 'msg:delivery-receipt'
      || receipt.signerId !== message.recipient_identity_id
      || payload.version !== 1 || payload.purpose !== 'direct-message-delivery-v1'
      || payload.serverMessageId !== message.server_message_id
      || payload.clientMessageId !== message.client_message_id
      || payload.authorClaimSignature !== message.author_claim.signature
      || payload.senderIdentityId !== message.sender_identity_id
      || payload.recipientIdentityId !== message.recipient_identity_id
      || payload.recipientDeviceId !== params.recipientDeviceId) return false;

    const delegation = proof.temporaryIdentityDelegation;
    if (!delegation) return verifySignedRequest(receipt, params.recipientIdentityPublicKey);
    const granted = delegation.payload;
    const chatId = [message.sender_identity_id, message.recipient_identity_id].sort().join('::');
    if (delegation.type !== 'temporary-identity:delegate'
      || delegation.signerId !== message.recipient_identity_id
      || granted?.version !== 1 || granted.purpose !== 'temporary-identity-delegation-v1'
      || granted.identityId !== message.recipient_identity_id
      || granted.identityPublicKey?.value !== params.recipientIdentityPublicKey.value
      || granted.temporaryDeviceId !== params.recipientDeviceId
      || !granted.capabilities?.includes('messages')
      || !(granted.scope?.directChatIds || []).includes(chatId)
      || !Number.isFinite(Date.parse(granted.notBefore))
      || !Number.isFinite(Date.parse(granted.expiresAt))
      || receipt.timestamp < Date.parse(granted.notBefore)
      || receipt.timestamp > Date.parse(granted.expiresAt)
      || !verifySignedRequest(delegation, params.recipientIdentityPublicKey)) return false;
    return verifySignedRequest(receipt, granted.temporaryDevicePublicKey);
  } catch {
    return false;
  }
}
