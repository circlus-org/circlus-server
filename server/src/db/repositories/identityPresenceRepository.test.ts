jest.mock('../index', () => ({
  pool: {},
  query: jest.fn()
}));

jest.mock('../../config/serverRuntimeConfig', () => ({
  getFeaturePolicyRuntimeConfig: () => ({
    presence: { onlineWindowSeconds: 75 }
  })
}));

import { query } from '../index';
import { identityRepository } from './identityRepository';

const queryMock = query as jest.Mock;

describe('identity foreground presence persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reads public presence from the explicit identity timestamp only', async () => {
    const presenceAt = new Date('2026-09-01T10:00:00.000Z');
    queryMock.mockResolvedValue({
      rows: [{
        identity_id: 'identity-1',
        status_text: null,
        status_updated_at: null,
        avatar_blob_id: null,
        presence_visible: true,
        last_seen_at: presenceAt,
        online_until: new Date('2026-09-01T10:01:15.000Z'),
        is_online: true
      }]
    });

    const result = await identityRepository.getStatuses('family-1', ['identity-1']);
    const [sql, values] = queryMock.mock.calls[0];

    expect(sql).toContain('i.presence_last_seen_at');
    expect(sql).not.toContain('FROM devices');
    expect(sql).not.toContain('FROM temporary_devices');
    expect(values).toEqual([['identity-1'], 'family-1', 75]);
    expect(result.get('identity-1')?.lastSeenAt).toEqual(presenceAt);
  });

  test('touches foreground presence without changing technical device activity', async () => {
    const presenceAt = new Date('2026-09-01T10:00:00.000Z');
    queryMock.mockResolvedValue({
      rows: [{ presence_last_seen_at: presenceAt }]
    });

    await expect(
      identityRepository.touchForegroundPresence('family-1', 'identity-1')
    ).resolves.toEqual(presenceAt);

    const [sql, values] = queryMock.mock.calls[0];
    expect(sql).toContain('SET presence_last_seen_at = NOW()');
    expect(sql).not.toContain('UPDATE devices');
    expect(values).toEqual(['identity-1', 'family-1']);
  });

  test('advances presence to signed user activity without moving it backwards', async () => {
    const activityAt = new Date('2026-09-01T10:00:00.000Z');
    queryMock.mockResolvedValue({ rows: [{ presence_last_seen_at: activityAt }] });

    await identityRepository.touchForegroundPresenceAt('family-1', 'identity-1', activityAt);

    const [sql, values] = queryMock.mock.calls[0];
    expect(sql).toContain('GREATEST');
    expect(sql).toContain('COALESCE(presence_last_seen_at');
    expect(values).toEqual(['identity-1', 'family-1', activityAt]);
  });
});
