const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));

import {
  AdminIdentityRemovalError,
  removeIdentityFromCircle
} from './adminIdentityRemovalService';

const params = {
  familyId: 'family-1',
  identityId: 'member-1',
  removedByIdentityId: 'owner-1'
};

describe('admin identity removal service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transactionClient.query.mockReset();
  });

  test('preserves the identity row and finalizes a disabled member with no active devices', async () => {
    const removedAt = new Date('2026-08-23T12:00:00.000Z');
    transactionClient.query
      .mockResolvedValueOnce({ rows: [{ identity_id: 'member-1', role: 'member', status: 'disabled' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        identity_id: 'member-1',
        status: 'removed',
        removed_at: removedAt,
        removed_by_identity_id: 'owner-1'
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await removeIdentityFromCircle(params);

    expect(result).toMatchObject({ identity_id: 'member-1', status: 'removed' });
    const statements = transactionClient.query.mock.calls.map(([statement]) => statement).join('\n');
    expect(statements).toContain('UPDATE group_chat_participants');
    expect(statements).toContain('UPDATE direct_guest_links');
    expect(statements).toContain('UPDATE announcement_channels');
    expect(statements).toContain("SET status = 'removed'");
    expect(statements).toContain('UPDATE temporary_devices');
    expect(statements).toContain('UPDATE invites');
  });

  test('requires blocking before permanent removal', async () => {
    transactionClient.query.mockResolvedValueOnce({
      rows: [{ identity_id: 'member-1', role: 'member', status: 'active' }]
    });

    await expect(removeIdentityFromCircle(params)).rejects.toMatchObject<Partial<AdminIdentityRemovalError>>({
      status: 409,
      code: 'INVALID_STATE'
    });
  });

  test('requires every trusted device to be revoked first', async () => {
    transactionClient.query
      .mockResolvedValueOnce({ rows: [{ identity_id: 'member-1', role: 'member', status: 'disabled' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    await expect(removeIdentityFromCircle(params)).rejects.toMatchObject<Partial<AdminIdentityRemovalError>>({
      status: 409,
      code: 'INVALID_STATE'
    });
  });

  test('never removes the Circle owner', async () => {
    transactionClient.query.mockResolvedValueOnce({
      rows: [{ identity_id: 'owner-1', role: 'owner', status: 'disabled' }]
    });

    await expect(removeIdentityFromCircle({ ...params, identityId: 'owner-1' }))
      .rejects.toMatchObject<Partial<AdminIdentityRemovalError>>({ status: 403, code: 'FORBIDDEN' });
  });
});
