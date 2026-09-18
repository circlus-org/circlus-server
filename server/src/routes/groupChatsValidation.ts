import { getFeaturePolicyRuntimeConfig } from '../config/serverRuntimeConfig';

export const GROUP_CHAT_LIMITS = getFeaturePolicyRuntimeConfig().groupChats;

export function isValidChatTitle(title: string): boolean {
  const len = (title || '').trim().length;
  return len > 0 && len <= GROUP_CHAT_LIMITS.titleMaxLength;
}

export function isValidEncryptedGroupTitle(value: string, expectedEpoch: number): boolean {
  const match = /^gct1:(\d+):(gcm1:.+)$/.exec(value);
  return Boolean(match && Number(match[1]) === expectedEpoch && Buffer.byteLength(value, 'utf8') <= 4096);
}

export function normalizeParticipantIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map((v) => String(v || '').trim()).filter(Boolean)));
}

export function isMessageSizeAllowed(ciphertext: string): boolean {
  return Buffer.byteLength(ciphertext || '', 'utf8') <= GROUP_CHAT_LIMITS.messageMaxBytes;
}


export function isLikelyEncryptedCiphertext(ciphertext: string): boolean {
  if (!ciphertext || typeof ciphertext !== 'string') return false;
  if (!ciphertext.startsWith('gcm1:')) return false;
  const payload = ciphertext.slice('gcm1:'.length);
  if (!payload) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false;
  try {
    const decoded = Buffer.from(payload, 'base64');
    const canonicalPayload = decoded.toString('base64').replace(/=+$/, '');
    return decoded.length > 12 && canonicalPayload === payload.replace(/=+$/, ''); // nonce + encrypted bytes
  } catch {
    return false;
  }
}
