import { transaction } from '../db';
import { appendCircleMembershipState } from './circleMembershipStateService';
import { disableOwnCircleIdentity } from './identitySelfDisableService';
import { trustedDeviceRekeyRepository } from '../db/repositories';
import { requestTrustedDeviceRekeyProcessing } from './trustedDeviceRekeyService';

jest.mock('../db', () => ({ transaction: jest.fn() }));
jest.mock('./circleMembershipStateService', () => ({ appendCircleMembershipState: jest.fn() }));
jest.mock('../db/repositories', () => ({ trustedDeviceRekeyRepository: { enqueue: jest.fn() } }));
jest.mock('./trustedDeviceRekeyService', () => ({ requestTrustedDeviceRekeyProcessing: jest.fn() }));

const membershipState = {
  claim: {
    signerId: 'member',
    payload: { action: 'remove', subjectIdentityId: 'member' }
  },
  admission: null
} as any;

function arrangeIdentity(role = 'member', status = 'active', deviceRows = [{ device_id: 'device-1' }]) {
  const query = jest.fn()
    .mockResolvedValueOnce({ rows: [{ role, status }] })
    .mockResolvedValueOnce({ rows: deviceRows })
    .mockResolvedValue({ rowCount: 1 });
  const client = { query };
  (transaction as jest.Mock).mockImplementation(async (run) => run(client));
  return { query, client };
}

describe('disableOwnCircleIdentity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (trustedDeviceRekeyRepository.enqueue as jest.Mock).mockResolvedValue({ status: 'pending' });
  });

  it('commits signed self-removal and access cutoff in the same transaction', async () => {
    const { query, client } = arrangeIdentity();
    const result = await disableOwnCircleIdentity({ familyId: 'family', identityId: 'member', membershipState });
    expect(result).toBe('updated');
    expect(appendCircleMembershipState).toHaveBeenCalledWith({ familyId: 'family', record: membershipState, client });
    expect(trustedDeviceRekeyRepository.enqueue).toHaveBeenCalledWith(client, {
      familyId: 'family', identityId: 'member', deviceId: 'device-1', reason: 'device_revoked'
    });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("status = 'disabled'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("SET status = 'revoked', revoked_at = NOW()"))).toBe(true);
    expect(statements.some((sql) => sql.includes('UPDATE group_chat_participants'))).toBe(true);
    expect(statements.some((sql) => sql.includes('rekey_required_at ='))).toBe(true);
    expect(statements.findIndex((sql) => sql.includes('rekey_required_at =')))
      .toBeLessThan(statements.findIndex((sql) => sql.includes('UPDATE group_chat_participants')));
    expect(requestTrustedDeviceRekeyProcessing).toHaveBeenCalledTimes(1);
  });

  it('records an identity-level rekey without inventing a device ID', async () => {
    const { client } = arrangeIdentity('member', 'active', []);
    const result = await disableOwnCircleIdentity({ familyId: 'family', identityId: 'member', membershipState });
    expect(result).toBe('updated');
    expect(trustedDeviceRekeyRepository.enqueue).toHaveBeenCalledWith(client, {
      familyId: 'family', identityId: 'member', deviceId: null, reason: 'device_revoked'
    });
  });

  it('removes live capabilities but preserves recoverable and shared records', async () => {
    const { query } = arrangeIdentity();
    await disableOwnCircleIdentity({ familyId: 'family', identityId: 'member', membershipState });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    for (const fragment of [
      "presence_visible = FALSE",
      'DELETE FROM circle_encrypted_identity_statuses',
      'DELETE FROM direct_file_quick_receive_controls',
      "UPDATE invites SET status = 'revoked'",
      "UPDATE call_links SET status = 'revoked'",
      'UPDATE direct_guest_links',
      'UPDATE direct_guest_registrations',
      "UPDATE temporary_devices SET status = 'revoked'",
      'UPDATE device_enrollments',
      'DELETE FROM device_notification_bindings',
      'UPDATE announcement_channel_subscriptions',
      'UPDATE announcement_channels',
    ]) expect(statements.some((sql) => sql.includes(fragment))).toBe(true);
    for (const table of [
      'identities', 'devices', 'messages', 'group_chat_messages', 'attachment_blobs',
      'vaults', 'identity_backups', 'message_archive_segments', 'circle_membership_states',
    ]) expect(statements.some((sql) => sql.includes(`DELETE FROM ${table}`))).toBe(false);
    expect(query.mock.calls.slice(2).every(([, values]) =>
      JSON.stringify(values) === JSON.stringify(['family', 'member'])
    )).toBe(true);
  });

  it('does not change status when the signed chain append fails', async () => {
    const { query } = arrangeIdentity();
    (appendCircleMembershipState as jest.Mock).mockRejectedValue(new Error('fork'));
    await expect(disableOwnCircleIdentity({
      familyId: 'family', identityId: 'member', membershipState
    })).rejects.toThrow('fork');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not let an owner or an already disabled identity retire this way', async () => {
    const owner = arrangeIdentity('owner');
    expect(await disableOwnCircleIdentity({
      familyId: 'family', identityId: 'member', membershipState
    })).toBe('forbidden');
    expect(owner.query).toHaveBeenCalledTimes(1);
    const disabled = arrangeIdentity('member', 'disabled');
    expect(await disableOwnCircleIdentity({
      familyId: 'family', identityId: 'member', membershipState
    })).toBe('invalid_state');
    expect(disabled.query).toHaveBeenCalledTimes(1);
    expect(appendCircleMembershipState).not.toHaveBeenCalled();
  });

  it('rejects a different signer, action or admission before touching the database', async () => {
    for (const invalid of [
      { ...membershipState, claim: { ...membershipState.claim, signerId: 'other' } },
      { ...membershipState, claim: { ...membershipState.claim, payload: { ...membershipState.claim.payload, action: 'restore' } } },
      { ...membershipState, admission: {} }
    ]) {
      expect(await disableOwnCircleIdentity({
        familyId: 'family', identityId: 'member', membershipState: invalid
      })).toBe('invalid_state');
    }
    expect(transaction).not.toHaveBeenCalled();
  });
});
