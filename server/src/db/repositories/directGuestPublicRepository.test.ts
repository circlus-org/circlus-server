import { transaction } from '../index';
import { createDirectGuestRegistration } from './directGuestRegistrationRepository.queries';
import { directGuestPublicRepository } from './directGuestPublicRepository';

jest.mock('../index', () => ({
  transaction: jest.fn(),
}));

jest.mock('./directGuestRegistrationRepository.queries', () => ({
  createDirectGuestRegistration: { run: jest.fn() },
}));

describe('DirectGuestPublicRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the initial channel subscription in the same transaction as a broadcast-enabled guest registration', async () => {
    const createdAt = new Date();
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ status: 'active', capability_mode: 'unlimited', expires_at: null }] })
        .mockResolvedValueOnce({ rows: [{ status: 'active' }] })
        .mockResolvedValueOnce({
          rows: [{
            identity_id: 'guest_1',
            public_key_algorithm: 'ed25519',
            public_key_value: 'identity_key',
            encrypted_private_key: null,
            created_at: createdAt,
            status: 'active',
            role: 'guest',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            device_id: 'device-guest123',
            identity_id: 'guest_1',
            public_key_algorithm: 'ed25519',
            public_key_value: 'device_key',
            created_at: createdAt,
            status: 'active',
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };
    (transaction as jest.Mock).mockImplementation(async (work) => work(client));
    (createDirectGuestRegistration.run as jest.Mock).mockResolvedValueOnce([{
      registration_id: 'registration_1',
      family_id: 'family_1',
      link_id: 'link_1',
      host_identity_id: 'host_1',
      guest_identity_id: 'guest_1',
      guest_device_id: 'device-guest123',
      status: 'active',
      created_at: createdAt,
      updated_at: createdAt,
      revoked_at: null,
      last_seen_at: null,
    }]);

    const channelSubscriptionClaim = { type: 'announcement-channel:subscription', signature: 'claim' } as any;
    await directGuestPublicRepository.createGuestIdentityDeviceAndRegistration({
      familyId: 'family_1',
      identityId: 'guest_1',
      deviceId: 'device-guest123',
      registrationId: 'registration_1',
      identityName: 'Guest',
      identityPublicKey: { algorithm: 'ed25519', value: 'identity_key' },
      encryptedIdentityPrivateKey: null,
      devicePublicKey: { algorithm: 'ed25519', value: 'device_key' },
      channelSubscriptionClaim,
      link: {
        link_id: 'link_1',
        host_identity_id: 'host_1',
        can_message: true,
        can_call: false,
        can_direct_file_transfer: false,
        auto_subscribe_to_channel: true,
      },
    });

    expect(client.query).toHaveBeenCalledTimes(5);
    expect(client.query.mock.calls[4]?.[0]).toContain(
      'INSERT INTO announcement_channel_subscriptions'
    );
    expect(client.query.mock.calls[4]?.[1]).toEqual([
      expect.stringMatching(/^acs_/),
      'guest_1',
      'family_1',
      'link_1',
      true,
      JSON.stringify(channelSubscriptionClaim),
    ]);
  });

  it('requires explicit auto-subscription in addition to a link-to-channel association', async () => {
    const createdAt = new Date();
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ status: 'active', capability_mode: 'unlimited', expires_at: null }] })
        .mockResolvedValueOnce({ rows: [{ status: 'active' }] })
        .mockResolvedValueOnce({
          rows: [{
            identity_id: 'guest_1',
            public_key_algorithm: 'ed25519',
            public_key_value: 'identity_key',
            encrypted_private_key: null,
            created_at: createdAt,
            status: 'active',
            role: 'guest',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            device_id: 'device-guest123',
            identity_id: 'guest_1',
            public_key_algorithm: 'ed25519',
            public_key_value: 'device_key',
            created_at: createdAt,
            status: 'active',
          }],
        }),
    };
    (transaction as jest.Mock).mockImplementation(async (work) => work(client));
    (createDirectGuestRegistration.run as jest.Mock).mockResolvedValueOnce([{
      registration_id: 'registration_1',
      family_id: 'family_1',
      link_id: 'link_1',
      host_identity_id: 'host_1',
      guest_identity_id: 'guest_1',
      guest_device_id: 'device-guest123',
      status: 'active',
      created_at: createdAt,
      updated_at: createdAt,
      revoked_at: null,
      last_seen_at: null,
    }]);

    await directGuestPublicRepository.createGuestIdentityDeviceAndRegistration({
      familyId: 'family_1',
      identityId: 'guest_1',
      deviceId: 'device-guest123',
      registrationId: 'registration_1',
      identityPublicKey: { algorithm: 'ed25519', value: 'identity_key' },
      encryptedIdentityPrivateKey: null,
      devicePublicKey: { algorithm: 'ed25519', value: 'device_key' },
      link: {
        link_id: 'link_1',
        host_identity_id: 'host_1',
        can_message: true,
        can_call: false,
        can_direct_file_transfer: false,
        auto_subscribe_to_channel: false,
      },
    });

    expect(client.query).toHaveBeenCalledTimes(5);
    expect(client.query.mock.calls[4]?.[0]).toContain(
      'AND $5 = TRUE'
    );
    expect(client.query.mock.calls[4]?.[1]?.[4]).toBe(false);
  });

  it('does not register a guest while the link host is blocked', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ status: 'active', capability_mode: 'unlimited', expires_at: null }] })
        .mockResolvedValueOnce({ rows: [{ status: 'disabled' }] }),
    };
    (transaction as jest.Mock).mockImplementation(async (work) => work(client));

    await expect(directGuestPublicRepository.createGuestIdentityDeviceAndRegistration({
      familyId: 'family_1',
      identityId: 'guest_1',
      deviceId: 'device-guest123',
      registrationId: 'registration_1',
      identityPublicKey: { algorithm: 'ed25519', value: 'identity_key' },
      encryptedIdentityPrivateKey: null,
      devicePublicKey: { algorithm: 'ed25519', value: 'device_key' },
      link: {
        link_id: 'link_1',
        host_identity_id: 'host_1',
        can_message: true,
        can_call: false,
        can_direct_file_transfer: false,
      },
    })).rejects.toThrow('Direct guest link host is unavailable');

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(createDirectGuestRegistration.run).not.toHaveBeenCalled();
  });
});

test('resumes the same guest registration using any active device owned by that guest', async () => {
  const registration = { registration_id: 'registration', guest_identity_id: 'guest' };
  const identity = { identity_id: 'guest' };
  const secondDevice = { device_id: 'device-second', identity_id: 'guest', status: 'active' };
  const client = { query: jest.fn().mockResolvedValueOnce({ rows: [registration] })
    .mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: [secondDevice] }) };
  (transaction as jest.Mock).mockImplementation(work => work(client));
  const result = await directGuestPublicRepository.findExistingGuestIdentityDeviceAndRegistration({
    familyId: 'family', linkId: 'link', identityId: 'guest', deviceId: 'device-second'
  });
  expect(result).toEqual({ registration, identity, device: secondDevice });
  expect(client.query.mock.calls[0][1]).toEqual(['family', 'link', 'guest']);
  expect(client.query.mock.calls[2][0]).toContain("identity_id = $3 AND status = 'active'");
  expect(client.query.mock.calls[2][1]).toEqual(['family', 'device-second', 'guest']);
});

test('does not resume a guest registration when its requested device is revoked or belongs to someone else', async () => {
  const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ registration_id: 'registration' }] })
    .mockResolvedValueOnce({ rows: [{ identity_id: 'guest' }] }).mockResolvedValueOnce({ rows: [] }) };
  (transaction as jest.Mock).mockImplementation(work => work(client));
  await expect(directGuestPublicRepository.findExistingGuestIdentityDeviceAndRegistration({
    familyId: 'family', linkId: 'link', identityId: 'guest', deviceId: 'foreign-device'
  })).resolves.toBeNull();
});
