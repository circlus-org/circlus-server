import { transaction } from '../db';
import { setCircleMemberStatus } from './circleMembershipAdminService';
import { appendCircleMembershipState, listCircleMembershipStates } from './circleMembershipStateService';

jest.mock('../db', () => ({ transaction: jest.fn() }));
jest.mock('./circleMembershipStateService', () => ({
  appendCircleMembershipState: jest.fn(),
  listCircleMembershipStates: jest.fn(),
}));

const state = (action: string) => ({
  claim: {
    signerId: 'owner',
    payload: { action, subjectIdentityId: 'member', ownerIdentityId: 'owner' },
  },
  admission: null,
}) as any;

describe('setCircleMemberStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['disabled', 'active', 'remove'],
    ['active', 'disabled', 'restore'],
  ] as const)('commits %s with its signed transition in one transaction', async (status, prior, action) => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ role: 'member', status: prior }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const client = { query };
    (transaction as jest.Mock).mockImplementation(async (run) => run(client));
    const membershipState = state(action);

    expect(await setCircleMemberStatus({
      familyId: 'family', ownerIdentityId: 'owner', subjectIdentityId: 'member',
      status, membershipState,
    })).toBe('updated');
    expect(appendCircleMembershipState).toHaveBeenCalledWith({ familyId: 'family', record: membershipState, client });
    expect(query.mock.calls[1][1]).toEqual(['family', 'member', status]);
  });

  test('does not update server status when the signed append fails', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ role: 'member', status: 'active' }] });
    (transaction as jest.Mock).mockImplementation(async (run) => run({ query }));
    (appendCircleMembershipState as jest.Mock).mockRejectedValue(new Error('conflict'));
    await expect(setCircleMemberStatus({
      familyId: 'family', ownerIdentityId: 'owner', subjectIdentityId: 'member',
      status: 'disabled', membershipState: state('remove'),
    })).rejects.toThrow('conflict');
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('legacy repair can disable only a profile absent from the signed head', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ role: 'member', status: 'active' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    (transaction as jest.Mock).mockImplementation(async (run) => run({ query }));
    (listCircleMembershipStates as jest.Mock).mockResolvedValue([
      { claim: { payload: { action: 'repair', ownerIdentityId: 'owner', members: [{ identityId: 'owner' }] } } },
    ]);
    expect(await setCircleMemberStatus({
      familyId: 'family', ownerIdentityId: 'owner', subjectIdentityId: 'member', status: 'disabled',
    })).toBe('updated');
    expect(appendCircleMembershipState).not.toHaveBeenCalled();
  });

  test('unsigned request cannot disable a signed member', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ role: 'member', status: 'active' }] });
    (transaction as jest.Mock).mockImplementation(async (run) => run({ query }));
    (listCircleMembershipStates as jest.Mock).mockResolvedValue([
      { claim: { payload: { action: 'repair', ownerIdentityId: 'owner', members: [{ identityId: 'member' }] } } },
    ]);
    expect(await setCircleMemberStatus({
      familyId: 'family', ownerIdentityId: 'owner', subjectIdentityId: 'member', status: 'disabled',
    })).toBe('invalid_state');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
