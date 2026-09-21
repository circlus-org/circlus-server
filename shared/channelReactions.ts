export const CHANNEL_REACTION_LIMIT = 12;
export const CHANNEL_REACTION_CODE_PATTERN = /^rc1_[A-Za-z0-9_-]{22,192}$/;
export type ChannelReactionState = {
  postId: string; revision: number; mine: string[];
  counts: Array<{ code: string; count: number }>;
};
export type ChannelReactionWrite = { postId: string; revision: number; codes: string[] };
export function validChannelReactionWrite(value: unknown): value is ChannelReactionWrite {
  const p = value as ChannelReactionWrite | null;
  return Boolean(p && typeof p.postId === 'string' && p.postId.length > 0 && p.postId.length <= 256
    && Number.isSafeInteger(p.revision) && p.revision > 0 && Array.isArray(p.codes)
    && p.codes.length <= CHANNEL_REACTION_LIMIT && new Set(p.codes).size === p.codes.length
    && p.codes.every(code => typeof code === 'string' && CHANNEL_REACTION_CODE_PATTERN.test(code)));
}
export function canReplaceChannelReactions(enabled: boolean, previous: string[], next: string[]) {
  return enabled || next.every(code => previous.includes(code));
}
