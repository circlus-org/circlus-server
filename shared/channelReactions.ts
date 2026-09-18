import { EMOJI_CATEGORIES } from './emojiCatalog';
const emojis = new Set(EMOJI_CATEGORIES.flatMap(category => [...category.emojis]));
export const CHANNEL_REACTION_LIMIT = 12;
export type ChannelReactionState = {
  postId: string; revision: number; mine: string[];
  counts: Array<{ emoji: string; count: number }>;
};
export type ChannelReactionWrite = { postId: string; revision: number; emojis: string[] };
export function validChannelReactionWrite(value: unknown): value is ChannelReactionWrite {
  const p = value as ChannelReactionWrite | null;
  return Boolean(p && typeof p.postId === 'string' && p.postId.length > 0 && p.postId.length <= 256
    && Number.isSafeInteger(p.revision) && p.revision > 0 && Array.isArray(p.emojis)
    && p.emojis.length <= CHANNEL_REACTION_LIMIT && new Set(p.emojis).size === p.emojis.length
    && p.emojis.every(emoji => typeof emoji === 'string' && emojis.has(emoji)));
}
export function canReplaceChannelReactions(enabled: boolean, previous: string[], next: string[]) {
  return enabled || next.every(emoji => previous.includes(emoji));
}
