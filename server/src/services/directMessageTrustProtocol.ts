import type {
  DirectMessageAuthorAction,
  DirectMessageAuthorClaim,
  PublicKey
} from '@shared/types';
import { verifySignedRequest } from '../utils/crypto';

function canonicalDirectChatId(a: string, b: string): string {
  const left = (a || '').trim();
  const right = (b || '').trim();
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}

export function validateDirectMessageAuthorClaim(params: {
  claim: DirectMessageAuthorClaim | null | undefined;
  action: DirectMessageAuthorAction;
  senderIdentityId: string;
  recipientIdentityId: string;
  clientMessageId: string;
  clientCreatedAt: number | null;
  epoch: number;
  revision: number;
  ciphertext: string;
  senderCiphertext?: string | null;
  senderSignature: string;
  senderPublicKey: PublicKey;
  temporaryDevice: boolean;
}): boolean {
  const claim = params.claim;
  if (!claim || claim.type !== 'msg:author' || claim.signerId !== params.senderIdentityId) return false;
  const payload = claim.payload;
  const matches = payload.version === 1
    && payload.purpose === 'direct-message-author-v1'
    && payload.action === params.action
    && payload.directChatId === canonicalDirectChatId(params.senderIdentityId, params.recipientIdentityId)
    && payload.senderIdentityId === params.senderIdentityId
    && payload.recipientIdentityId === params.recipientIdentityId
    && payload.clientMessageId === params.clientMessageId
    && payload.clientCreatedAt === params.clientCreatedAt
    && payload.epoch === params.epoch
    && payload.revision === params.revision
    && payload.ciphertext === params.ciphertext
    && payload.senderCiphertext === (params.senderCiphertext || null)
    && payload.senderSignature === params.senderSignature;
  if (!matches) return false;
  // Temporary-device signatures are verified end-to-end against the identity-signed
  // delegation. The server has already authenticated that temporary device here.
  return params.temporaryDevice || verifySignedRequest(claim, params.senderPublicKey);
}
