import type { DirectMessageReadProof, PublicKey } from '../../../shared/types';
import { verifySignedRequest } from '../utils/crypto';

export function verifyDirectMessageReadProof(params: {
  proof: DirectMessageReadProof | null | undefined;
  senderIdentityId: string;
  recipientIdentityId: string;
  recipientDeviceId: string;
  recipientIdentityPublicKey: PublicKey;
  nowMs?: number;
}): boolean {
  try {
    const { proof } = params;
    const receipt = proof?.receipt;
    const payload = receipt?.payload;
    if (!receipt || !payload
      || receipt.type !== 'msg:read-receipt'
      || receipt.signerId !== params.recipientIdentityId
      || payload.version !== 1 || payload.purpose !== 'direct-message-read-v1'
      || typeof payload.readTimeVisible !== 'boolean'
      || payload.senderIdentityId !== params.senderIdentityId
      || payload.recipientIdentityId !== params.recipientIdentityId
      || payload.recipientDeviceId !== params.recipientDeviceId
      || !Array.isArray(payload.serverMessageIds)
      || payload.serverMessageIds.length < 1 || payload.serverMessageIds.length > 100
      || payload.serverMessageIds.some((id) => typeof id !== 'string' || !id)
      || new Set(payload.serverMessageIds).size !== payload.serverMessageIds.length
      || !Number.isFinite(receipt.timestamp)
      || receipt.timestamp > (params.nowMs ?? Date.now()) + 5 * 60_000
      || (payload.readTimeVisible && (params.nowMs ?? Date.now()) - receipt.timestamp > 5 * 60_000)) return false;

    const delegation = proof.temporaryIdentityDelegation;
    if (!delegation) return verifySignedRequest(receipt, params.recipientIdentityPublicKey);
    const granted = delegation.payload;
    const chatId = [params.senderIdentityId, params.recipientIdentityId].sort().join('::');
    if (delegation.type !== 'temporary-identity:delegate'
      || delegation.signerId !== params.recipientIdentityId
      || granted?.version !== 1 || granted.purpose !== 'temporary-identity-delegation-v1'
      || granted.identityId !== params.recipientIdentityId
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
