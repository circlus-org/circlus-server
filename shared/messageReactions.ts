import type { SignedRequest, PublicKey } from './types';

export type ReactionScope = 'direct' | 'group';
export type ReactionPayload = {
  version: 1;
  scope: ReactionScope;
  chatId: string;
  messageId: string;
  actorIdentityId: string;
  revision: number;
  epoch: number;
  ciphertext: string;
};
export type ReactionClaim = SignedRequest<ReactionPayload>;
export type ReactionRecord = { claim: ReactionClaim; publicKey: PublicKey };
export const MAX_REACTIONS_PER_PERSON = 12;
export const MAX_REACTION_MESSAGES = 100;

export function validReactionPayload(value: unknown): value is ReactionPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as ReactionPayload;
  return p.version === 1 && (p.scope === 'direct' || p.scope === 'group')
    && [p.chatId, p.messageId, p.actorIdentityId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)
    && Number.isSafeInteger(p.revision) && p.revision > 0
    && Number.isSafeInteger(p.epoch) && p.epoch > 0
    && typeof p.ciphertext === 'string' && p.ciphertext.length <= 4096
    && new RegExp(`^${p.scope === 'direct' ? 'dcm1' : 'gcm1'}:[A-Za-z0-9+/]{38,}={0,2}$`).test(p.ciphertext);
}

// Store the whole set for one author, including an empty set when removing the last
// emoji. Its revision remains as a tombstone, so stale retries cannot resurrect it.
export function reactionRecordKey(p: Pick<ReactionPayload, 'messageId' | 'actorIdentityId'>): string {
  return JSON.stringify([p.messageId, p.actorIdentityId]);
}

export type WSMessageReactionsUpdated = { scope: ReactionScope; chatId: string; messageId: string };
