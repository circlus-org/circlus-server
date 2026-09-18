import { GROUP_CHAT_LIMITS, isLikelyEncryptedCiphertext, isMessageSizeAllowed, isValidChatTitle, isValidEncryptedGroupTitle, normalizeParticipantIds } from './groupChatsValidation';

describe('group chat validation', () => {
  test('normalizes participant ids with dedupe and trim', () => {
    expect(normalizeParticipantIds([' u1 ', 'u2', 'u1', '', null as unknown as string])).toEqual(['u1', 'u2']);
  });

  test('validates title length', () => {
    expect(isValidChatTitle('  ')).toBe(false);
    expect(isValidChatTitle('ok')).toBe(true);
    expect(isValidChatTitle('x'.repeat(GROUP_CHAT_LIMITS.titleMaxLength + 1))).toBe(false);
  });

  test('accepts only encrypted group titles for the expected epoch', () => {
    const ciphertext = `gcm1:${Buffer.from('x'.repeat(24), 'utf8').toString('base64')}`;
    expect(isValidEncryptedGroupTitle(`gct1:3:${ciphertext}`, 3)).toBe(true);
    expect(isValidEncryptedGroupTitle(`gct1:2:${ciphertext}`, 3)).toBe(false);
    expect(isValidEncryptedGroupTitle('Team chat', 3)).toBe(false);
  });

  test('validates message size by bytes', () => {
    expect(isMessageSizeAllowed('x'.repeat(Math.max(1, GROUP_CHAT_LIMITS.messageMaxBytes - 1)))).toBe(true);
    expect(isMessageSizeAllowed('x'.repeat(GROUP_CHAT_LIMITS.messageMaxBytes + 1))).toBe(false);
  });

  test('validates encrypted payload format', () => {
    const legacyPayload = `v3:${Buffer.from('x'.repeat(40), 'utf8').toString('base64')}`;
    const validGroupPayload = `gcm1:${Buffer.from('x'.repeat(24), 'utf8').toString('base64')}`;
    expect(isLikelyEncryptedCiphertext(legacyPayload)).toBe(false);
    expect(isLikelyEncryptedCiphertext(validGroupPayload)).toBe(true);
    expect(isLikelyEncryptedCiphertext('plain')).toBe(false);
    expect(isLikelyEncryptedCiphertext('v3:')).toBe(false);
    expect(isLikelyEncryptedCiphertext('gcm1:not-base64!')).toBe(false);
  });

});
