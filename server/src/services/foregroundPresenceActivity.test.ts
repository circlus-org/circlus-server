jest.mock('../db/repositories', () => ({
  identityRepository: { touchForegroundPresenceAt: jest.fn() }
}));
jest.mock('../middleware/requestContext', () => ({
  getRequestLogger: () => ({ warn: jest.fn() })
}));

import { identityRepository } from '../db/repositories';
import {
  normalizeForegroundActivityAt,
  recordForegroundMessageActivity
} from './foregroundPresenceActivity';

describe('foreground message activity', () => {
  const now = Date.parse('2026-09-01T12:00:00.000Z');

  test('preserves the original user-action time across a delayed retry', () => {
    const activityAt = now - 60 * 60 * 1000;
    expect(normalizeForegroundActivityAt(activityAt, now)?.getTime()).toBe(activityAt);
  });

  test('rejects expired and implausibly future activity evidence', () => {
    expect(normalizeForegroundActivityAt(now - 25 * 60 * 60 * 1000, now)).toBeNull();
    expect(normalizeForegroundActivityAt(now + 6 * 60 * 1000, now)).toBeNull();
  });

  test('clamps accepted clock skew to server time', () => {
    expect(normalizeForegroundActivityAt(now + 60_000, now)?.getTime()).toBe(now);
  });

  test('persists accepted signed activity evidence', async () => {
    const activityAt = Date.now() - 60_000;
    await recordForegroundMessageActivity({
      familyId: 'family-1',
      identityId: 'identity-1',
      activityAt
    });
    expect(identityRepository.touchForegroundPresenceAt).toHaveBeenCalledWith(
      'family-1',
      'identity-1',
      new Date(activityAt)
    );
  });
});
