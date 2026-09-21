import { splitCliArgument } from './cliArgumentParsing';

export type DeleteTenantOptions = {
  host: string;
  familyId: string | null;
  confirmFamilyId: string | null;
};

export function parseDeleteTenantOptions(args: string[]): DeleteTenantOptions {
  const options: DeleteTenantOptions = { host: '', familyId: null, confirmFamilyId: null };

  for (const argument of args) {
    const { key, value } = splitCliArgument(argument);
    if (key === '--host') {
      options.host = String(value || '').trim();
    } else if (key === '--family-id') {
      options.familyId = String(value || '').trim() || null;
    } else if (key === '--confirm-family-id') {
      options.confirmFamilyId = String(value || '').trim() || null;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (!options.host) throw new Error('--host is required');
  return options;
}

export function selectTenantDomain<T extends { family_id: string }>(
  domains: T[],
  requestedFamilyId: string | null
): T {
  if (domains.length === 0) throw new Error('No Circle is configured for this host');
  if (requestedFamilyId) {
    const selected = domains.find((domain) => domain.family_id === requestedFamilyId);
    if (!selected) throw new Error('The requested family ID is not assigned to this host');
    return selected;
  }
  if (domains.length > 1) {
    throw new Error(
      `Multiple Circles use this host; repeat with --family-id. Available Family IDs: ${domains.map((domain) => domain.family_id).join(', ')}`
    );
  }
  return domains[0]!;
}

export function confirmTenantDeletion(expectedFamilyId: string, confirmation: string | null): boolean {
  if (!confirmation) return false;
  if (confirmation !== expectedFamilyId) {
    throw new Error('Confirmation family ID does not match the Circle resolved from --host');
  }
  return true;
}
