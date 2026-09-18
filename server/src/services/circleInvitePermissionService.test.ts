import { transaction } from '../db';
import { setCircleInvitePermission } from './circleInvitePermissionService';
import {
  appendCircleMembershipState,
  listCircleMembershipStates
} from './circleMembershipStateService';

jest.mock('../db', () => ({ transaction: jest.fn() }));
jest.mock('./circleMembershipStateService', () => ({
  appendCircleMembershipState: jest.fn(),
  listCircleMembershipStates: jest.fn()
}));

describe('setCircleInvitePermission', () => {
  beforeEach(() => jest.clearAllMocks());

  test('revokes all active invitations when permission is disabled', async () => {
    (listCircleMembershipStates as jest.Mock).mockResolvedValue([{
      claim: { payload: { members: [{ identityId: 'member_1', publicKey: { algorithm: 'ed25519', value: 'k' }, role: 'member', permissions: { canCreateInvites: false } }] } },
      admission: null
    }]);
    const query = jest.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ identity_id: 'member_1', can_create_invites: false }]
      })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] });
    (transaction as jest.Mock).mockImplementation(async (run) => run({ query }));

    const result = await setCircleInvitePermission({
      familyId: 'family_1',
      identityId: 'member_1',
      enabled: false
    });

    expect(result).toEqual({
      identityId: 'member_1',
      canCreateInvites: false,
      revokedInvites: 2
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("status = 'active'");
    expect(query.mock.calls[1][0]).not.toContain('capability_mode');
  });

  test('does not revoke invitations when permission is enabled', async () => {
    (listCircleMembershipStates as jest.Mock).mockResolvedValue([{
      claim: { payload: { members: [{ identityId: 'member_1', publicKey: { algorithm: 'ed25519', value: 'k' }, role: 'member', permissions: { canCreateInvites: true } }] } },
      admission: null
    }]);
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ identity_id: 'member_1', can_create_invites: true }]
    });
    (transaction as jest.Mock).mockImplementation(async (run) => run({ query }));

    const result = await setCircleInvitePermission({
      familyId: 'family_1',
      identityId: 'member_1',
      enabled: true
    });

    expect(result?.revokedInvites).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('appends signed membership permission transition in the same transaction', async () => {
    const membershipState = {
      claim: { payload: { members: [{ identityId: 'member_1', publicKey: { algorithm: 'ed25519', value: 'k' }, role: 'member', permissions: { canCreateInvites: true } }] } },
      admission: null
    } as any;
    (listCircleMembershipStates as jest.Mock).mockResolvedValue([membershipState]);
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ identity_id: 'member_1', can_create_invites: true }]
    });
    const client = { query };
    (transaction as jest.Mock).mockImplementation(async (run) => run(client));

    await setCircleInvitePermission({
      familyId: 'family_1',
      identityId: 'member_1',
      enabled: true,
      membershipState
    });

    expect(appendCircleMembershipState).toHaveBeenCalledWith({
      familyId: 'family_1',
      record: membershipState,
      client
    });
  });
});
