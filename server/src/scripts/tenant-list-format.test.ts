import { formatTenantList, type TenantListSummary } from './tenant-list-format';

describe('tenant list CLI output', () => {
  it('prints the host and both identifiers for every Circle, including a shared host', () => {
    const common = {
      name: 'Circle',
      host: 'shared.example',
      status: 'active',
      activeMembers: 2,
      activeGuests: 1,
      totalIdentities: 3,
      activeDevices: 2
    };
    const circles: TenantListSummary[] = [
      { ...common, familyId: 'family_a', circleId: 'circle_a' },
      { ...common, familyId: 'family_b', circleId: 'circle_b' }
    ];

    const output = formatTenantList(circles);

    expect(output.match(/Host: shared\.example/g)).toHaveLength(2);
    for (const value of ['family_a', 'family_b', 'circle_a', 'circle_b']) {
      expect(output).toContain(value);
    }
  });
});
