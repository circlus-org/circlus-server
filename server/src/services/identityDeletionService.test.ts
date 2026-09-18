const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));

import {
  deleteIdentityDataFromCircle,
  IdentityDeletionServiceError
} from './identityDeletionService';

const guard = {
  expectedMembershipStateId: 'cms_current_state_123',
  expectedOwnerIdentityId: 'owner-1'
};

function membershipRow(memberIds: string[], stateId = guard.expectedMembershipStateId) {
  return {
    state_id: stateId,
    claim: {
      payload: {
        ownerIdentityId: 'owner-1',
        members: memberIds.map((identityId) => ({ identityId }))
      }
    }
  };
}

describe('unverified identity data deletion guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transactionClient.query.mockReset();
  });

  test('rejects deletion when the profile is still in the current signed membership', async () => {
    transactionClient.query.mockResolvedValueOnce({ rows: [membershipRow(['owner-1', 'member-1'])] });

    await expect(deleteIdentityDataFromCircle({
      familyId: 'family-1',
      identityId: 'member-1',
      unverifiedMembershipGuard: guard
    })).rejects.toMatchObject<Partial<IdentityDeletionServiceError>>({
      status: 409,
      code: 'INVALID_STATE'
    });
  });

  test('rejects deletion against a stale membership state', async () => {
    transactionClient.query.mockResolvedValueOnce({
      rows: [membershipRow(['owner-1'], 'cms_newer_state_456')]
    });

    await expect(deleteIdentityDataFromCircle({
      familyId: 'family-1',
      identityId: 'member-1',
      unverifiedMembershipGuard: guard
    })).rejects.toMatchObject<Partial<IdentityDeletionServiceError>>({
      status: 409,
      code: 'INVALID_STATE'
    });
  });

  test('purges a server profile absent from the current owner-signed membership', async () => {
    transactionClient.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FROM circle_membership_states')) {
        return { rows: [membershipRow(['owner-1'])] };
      }
      if (statement.includes('SELECT role') && statement.includes('FROM identities')) {
        return { rows: [{ role: 'member' }] };
      }
      if (statement.includes('SELECT owner_identity_id') && statement.includes('FROM family_config')) {
        return { rows: [{ owner_identity_id: 'owner-1' }] };
      }
      return { rows: [] };
    });

    const result = await deleteIdentityDataFromCircle({
      familyId: 'family-1',
      identityId: 'member-1',
      unverifiedMembershipGuard: guard
    });

    expect(result).toEqual({ attachmentStorageKeys: [], publicSiteAssetStorageKeys: [] });
    const statements = transactionClient.query.mock.calls.map(([statement]) => statement).join('\n');
    expect(statements).toContain('DELETE FROM identities');
  });
});
