import { pool } from '../index';
import { DirectGuestRegistrationRepository } from './directGuestRegistrationRepository';

jest.mock('../index', () => ({
  pool: { query: jest.fn() },
}));

describe('DirectGuestRegistrationRepository host cleanup', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists inactive registrations so the host can remove them', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await new DirectGuestRegistrationRepository().listByHost('family-1', 'host-1');

    const sql = (pool.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).not.toContain("registration.status IN ('active', 'deleted_by_guest')");
  });

  it('detaches retained delivery history before deleting an inactive registration', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{
      registration_id: 'reg-1',
      link_id: 'link-1',
      status: 'deleted_by_guest',
    }] });

    const deleted = await new DirectGuestRegistrationRepository().deleteInactiveByHost(
      'family-1', 'reg-1', 'host-1'
    );

    expect(deleted?.registration_id).toBe('reg-1');
    const [sql, values] = (pool.query as jest.Mock).mock.calls[0] as [string, string[]];
    expect(sql).toContain("status <> 'active'");
    expect(sql).toContain('UPDATE direct_guest_broadcast_deliveries');
    expect(sql).toContain('SET registration_id = NULL');
    expect(sql).toContain('DELETE FROM direct_guest_registrations');
    expect(values).toEqual(['family-1', 'reg-1', 'host-1']);
  });
});
