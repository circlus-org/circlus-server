import { transaction } from '../db';
import { appendCircleMembershipState } from './circleMembershipStateService';
import { changeCircleOwnerToExistingIdentity } from './circleOwnershipService';

jest.mock('../db', () => ({ transaction: jest.fn() }));
jest.mock('./circleMembershipStateService', () => ({ appendCircleMembershipState: jest.fn() }));

describe('voluntary Circle owner transfer', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does not change database roles when the signed membership transition is rejected', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ owner_identity_id: 'old', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [
        { identity_id: 'old', role: 'owner', status: 'active' },
        { identity_id: 'next', role: 'member', status: 'active' },
      ] });
    (transaction as jest.Mock).mockImplementation(async (run) => run({ query }));
    (appendCircleMembershipState as jest.Mock).mockRejectedValue(new Error('membership conflict'));
    const membershipState = {
      claim: { signerId: 'old', payload: { action: 'transfer_owner', subjectIdentityId: 'next', ownerIdentityId: 'next' } },
      admission: null,
    } as any;

    await expect(changeCircleOwnerToExistingIdentity({
      familyId: 'family', expectedOwnerIdentityId: 'old', newOwnerIdentityId: 'next',
      method: 'voluntary_transfer', initiatedByIdentityId: 'old', initiatedByDeviceId: 'device',
      signedAuthorization: {}, membershipState,
    })).rejects.toThrow('membership conflict');
    expect(appendCircleMembershipState).toHaveBeenCalledWith({ familyId: 'family', record: membershipState, client: { query } });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
