const client = { query: jest.fn() };

jest.mock('../index', () => ({
  query: jest.fn(),
  transaction: jest.fn(async (work) => work(client)),
}));

import { familyConfigRepository, TenantSuspensionError } from './familyConfigRepository';

describe('Circle suspension lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  test('refuses to suspend the carrier of the last reachable server administrator', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT status FROM family_config')) return { rows: [{ status: 'active' }] };
      if (sql.includes('SELECT EXISTS')) return { rows: [{ available: false }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(familyConfigRepository.suspendWithDomain({
      familyId: 'family_admin',
      requestFamilyId: 'family_admin'
    })).rejects.toMatchObject<TenantSuspensionError>({ code: 'LAST_REACHABLE_SERVER_ADMIN' });

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'suspended'"))).toBe(false);
  });

  test('suspends only tenant and domain state without revoking profiles, devices, or invites', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT status FROM family_config')) return { rows: [{ status: 'active' }] };
      if (sql.includes('FROM family_domains')) return { rows: [{ id: 'domain-1' }] };
      return { rows: [] };
    });

    await familyConfigRepository.suspendWithDomain({
      familyId: 'family_target',
      requestFamilyId: 'family_admin'
    });

    const statements = client.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain("SET status = 'suspended'");
    expect(statements).toContain("SET status = 'suspended'");
    expect(statements).not.toMatch(/UPDATE (identities|devices|invites)/);
  });

  test('resumes the same current domain and existing tenant', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT status FROM family_config')) return { rows: [{ status: 'suspended' }] };
      if (sql.includes('FROM family_domains')) return { rows: [{ id: 'domain-1' }] };
      return { rows: [] };
    });

    await familyConfigRepository.resumeWithDomain('family_target');

    const statements = client.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain("SET status = 'active', disabled_at = NULL");
    expect(statements).toContain("SET status = 'active', suspended_at = NULL");
    expect(statements).not.toMatch(/INSERT|DELETE/);
  });
});
