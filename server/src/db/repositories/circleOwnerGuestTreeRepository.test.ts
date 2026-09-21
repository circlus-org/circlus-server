import { pool } from '../index';
import { CircleOwnerGuestTreeRepository } from './circleOwnerGuestTreeRepository';

jest.mock('../index', () => ({
  pool: { query: jest.fn() },
}));

describe('CircleOwnerGuestTreeRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads only direct children of one host without device labels', async () => {
    const query = pool.query as jest.Mock;
    query.mockResolvedValueOnce({ rows: [] });

    await new CircleOwnerGuestTreeRepository().listChildren({
      familyId: 'family-1',
      hostIdentityId: 'host-1',
      afterRegistrationId: 'dgr-cursor',
      limit: 25,
      includeInactive: false,
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual(['family-1', 'host-1', false, 'dgr-cursor', 26]);
    expect(sql).toContain('registration.host_identity_id = $2');
    expect(sql).toContain("registration.status = 'active'");
    expect(sql).toContain("guest.status = 'active'");
    expect(sql).toContain('registration.registration_id > $4');
    expect(sql).toContain('active_device_count');
    expect(sql).toContain('active_child_guest_count');
    expect(sql).not.toMatch(/device\.label|identity_name/);
  });
});
