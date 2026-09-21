import {
  confirmTenantDeletion,
  parseDeleteTenantOptions,
  selectTenantDomain
} from './delete-tenant-options';

describe('delete tenant CLI options', () => {
  it('uses a host-only invocation as a non-destructive inspection', () => {
    expect(parseDeleteTenantOptions(['--host=family.example'])).toEqual({
      host: 'family.example',
      familyId: null,
      confirmFamilyId: null
    });
  });

  it('accepts the exact family id as the destructive confirmation', () => {
    expect(parseDeleteTenantOptions([
      '--host=family.example',
      '--family-id=family_123',
      '--confirm-family-id=family_123'
    ])).toEqual({
      host: 'family.example',
      familyId: 'family_123',
      confirmFamilyId: 'family_123'
    });
  });

  it('rejects missing hosts and unknown arguments', () => {
    expect(() => parseDeleteTenantOptions([])).toThrow('--host is required');
    expect(() => parseDeleteTenantOptions(['--unknown=value'])).toThrow('Unknown argument');
  });

  it('requires the resolved family id before allowing deletion', () => {
    expect(confirmTenantDeletion('family_123', null)).toBe(false);
    expect(() => confirmTenantDeletion('family_123', 'family_other'))
      .toThrow('Confirmation family ID does not match');
    expect(confirmTenantDeletion('family_123', 'family_123')).toBe(true);
  });

  it('never chooses an arbitrary Circle when a host is shared', () => {
    const domains = [{ family_id: 'family_a' }, { family_id: 'family_b' }];
    expect(() => selectTenantDomain(domains, null)).toThrow('Multiple Circles use this host');
    expect(selectTenantDomain(domains, 'family_b')).toBe(domains[1]);
    expect(() => selectTenantDomain(domains, 'family_other')).toThrow('not assigned to this host');
  });
});
