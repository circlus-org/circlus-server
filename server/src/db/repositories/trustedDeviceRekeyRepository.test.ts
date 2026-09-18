const query = jest.fn();

jest.mock('../index', () => ({
  pool: { query: jest.fn() },
  transaction: jest.fn(async (work: (client: { query: typeof query }) => unknown) => work({ query }))
}));

import { TrustedDeviceRekeyRepository } from './trustedDeviceRekeyRepository';

describe('trusted device group rekey persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('marks a v2 group as waiting for its owner without advancing the unsigned epoch', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          job_id: 'job-1',
          family_id: 'family-1',
          identity_id: 'identity-1',
          device_id: 'device-1',
          reason: 'device_revoked',
          status: 'processing',
          attempts: 1,
          target_count: 1,
          completed_count: 0
        }]
      })
      .mockResolvedValueOnce({ rows: [{ target_type: 'group', chat_id: 'group-1' }] })
      .mockResolvedValueOnce({ rows: [{ chat_id: 'group-1', key_epoch: 7 }] })
      .mockResolvedValueOnce({ rows: [
        { chat_id: 'group-1', identity_id: 'identity-1' },
        { chat_id: 'group-1', identity_id: 'identity-2' }
      ] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await new TrustedDeviceRekeyRepository().rotateNextBatch('job-1', 25);

    const groupUpdate = query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('UPDATE group_chats'));
    expect(groupUpdate).toContain('SET rekey_required_at = $3');
    expect(groupUpdate).not.toContain('key_epoch = key_epoch + 1');
    expect(result.groupNotifications).toEqual([expect.objectContaining({
      chatId: 'group-1',
      keyEpoch: 7,
      participantIdentityIds: ['identity-1', 'identity-2']
    })]);
  });
});
