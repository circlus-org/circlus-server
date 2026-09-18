import { pool, inTransactionContext } from '../db';
const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  pool: { query: jest.fn() },
  inTransactionContext: jest.fn(async (_client: unknown, work: () => unknown) => work()),
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));
jest.mock('./configService', () => ({ configService: { getFamilyConfig: jest.fn(async () => ({ public_base_url: 'https://circle.test' })) } }));
jest.mock('../db/repositories', () => ({
  identityRepository: { findByIdentityId: jest.fn() },
  systemEventRepository: { createEventId: jest.fn(() => 'event-1'), insertEvent: jest.fn() },
  announcementChannelRepository: {
    listOwnedActiveSubscriptionsForGuest: jest.fn(),
    removeSubscriberByAuthor: jest.fn()
  },
  directGuestRegistrationRepository: {
    findActiveByHostForUpdate: jest.fn(),
    revokeByHost: jest.fn()
  }
}));

import {
  identityRepository,
  systemEventRepository,
  announcementChannelRepository,
  directGuestRegistrationRepository
} from '../db/repositories';
import {
  DirectGuestRegistrationRevocationError,
  revokeDirectGuestRegistration
} from './directGuestRegistrationRevocationService';

import nacl from 'tweetnacl';
import { createSignatureMessage } from '../../../shared/signatureMessage';
import type { DirectGuestRevocation } from '../../../shared/directGuestRevocation';
const pair = nacl.sign.keyPair();
function proof(): DirectGuestRevocation {
  const unsigned = { type: 'direct-guest:revocation', signerId: 'host-1', timestamp: Date.now(), nonce: 'nonce', payload: {
    version: 1 as const, purpose: 'circlus-direct-guest-revocation-v1' as const,
    circleOrigin: 'https://circle.test', registrationId: 'registration-1', linkId: 'link-1', hostIdentityId: 'host-1', guestIdentityId: 'guest-1',
  } };
  return { ...unsigned, signature: Buffer.from(nacl.sign.detached(Buffer.from(createSignatureMessage(unsigned)), pair.secretKey)).toString('base64') };
}
const params = {
  familyId: 'family-1',
  registrationId: 'registration-1',
  hostIdentityId: 'host-1',
  revocation: proof(),
  removeFromChannelIds: ['channel-1']
};

describe('direct guest registration revocation service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ public_key_algorithm: 'ed25519', public_key_value: Buffer.from(pair.publicKey).toString('base64') });
    (systemEventRepository.insertEvent as jest.Mock).mockResolvedValue(undefined);
    (directGuestRegistrationRepository.findActiveByHostForUpdate as jest.Mock).mockResolvedValue({
      registration_id: 'registration-1',
      guest_identity_id: 'guest-1',
      link_id: 'link-1'
    });
    (announcementChannelRepository.listOwnedActiveSubscriptionsForGuest as jest.Mock).mockResolvedValue([{
      channel_id: 'channel-1',
      title: 'Updates',
      key_epoch: 3
    }]);
    (directGuestRegistrationRepository.revokeByHost as jest.Mock).mockResolvedValue({
      registration_id: 'registration-1',
      status: 'revoked',
      revoked_at: new Date('2026-01-01T00:00:00.000Z')
    });
    (announcementChannelRepository.removeSubscriberByAuthor as jest.Mock).mockResolvedValue({
      status: 'removed_by_author'
    });
  });

  test('revokes registration and selected channel subscriptions atomically', async () => {
    const result = await revokeDirectGuestRegistration(params);

    expect(directGuestRegistrationRepository.findActiveByHostForUpdate).toHaveBeenCalledWith(
      'family-1',
      'registration-1',
      'host-1',
      transactionClient
    );
    expect(directGuestRegistrationRepository.revokeByHost).toHaveBeenCalledWith(
      'family-1',
      'registration-1',
      'host-1',
      transactionClient
    );
    expect(announcementChannelRepository.removeSubscriberByAuthor).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'channel-1', subscriberIdentityId: 'guest-1' }),
      transactionClient
    );
    expect(systemEventRepository.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family-1', recipientIdentityId: 'guest-1', type: 'direct-guest:revoked',
      payload: expect.objectContaining({ revocation: params.revocation }),
    }));
    expect(inTransactionContext).toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('revocation_proof = $3::jsonb'), ['family-1', 'registration-1', JSON.stringify(params.revocation)]);
    expect(result.event.recipientIdentityId).toBe('guest-1');
    expect(result.removedChannels).toEqual([{
      channelId: 'channel-1',
      title: 'Updates',
      keyEpoch: 3
    }]);
  });

  test('fails the transaction if the durable notification cannot be saved', async () => {
    (systemEventRepository.insertEvent as jest.Mock).mockRejectedValue(new Error('event storage failed'));
    await expect(revokeDirectGuestRegistration(params)).rejects.toThrow('event storage failed');
  });

  test('rejects a stale channel selection before revoking registration', async () => {
    (announcementChannelRepository.listOwnedActiveSubscriptionsForGuest as jest.Mock).mockResolvedValue([]);

    await expect(revokeDirectGuestRegistration(params))
      .rejects.toMatchObject<Partial<DirectGuestRegistrationRevocationError>>({
        status: 400,
        code: 'INVALID_REQUEST'
      });
    expect(directGuestRegistrationRepository.revokeByHost).not.toHaveBeenCalled();
    expect(announcementChannelRepository.removeSubscriberByAuthor).not.toHaveBeenCalled();
  });

  test('reports an inactive registration without performing mutations', async () => {
    (directGuestRegistrationRepository.findActiveByHostForUpdate as jest.Mock).mockResolvedValue(null);

    await expect(revokeDirectGuestRegistration(params))
      .rejects.toMatchObject<Partial<DirectGuestRegistrationRevocationError>>({
        status: 404,
        code: 'NOT_FOUND'
      });
    expect(directGuestRegistrationRepository.revokeByHost).not.toHaveBeenCalled();
    expect(announcementChannelRepository.removeSubscriberByAuthor).not.toHaveBeenCalled();
  });

test.each(['registrationId', 'linkId', 'hostIdentityId', 'guestIdentityId', 'circleOrigin'])('rejects host proof with substituted %s', async (field) => {
  const revocation = proof();
  (revocation.payload as any)[field] = 'other';
  await expect(revokeDirectGuestRegistration({ ...params, revocation })).rejects.toMatchObject({ status: 400 });
  expect(directGuestRegistrationRepository.revokeByHost).not.toHaveBeenCalled();
  expect(systemEventRepository.insertEvent).not.toHaveBeenCalled();
});
test('rejects missing host signature', async () => {
  await expect(revokeDirectGuestRegistration({ ...params, revocation: undefined })).rejects.toMatchObject({ status: 400 });
});
test('rejects forged signature on a matching payload', async () => {
  await expect(revokeDirectGuestRegistration({ ...params, revocation: { ...proof(), signature: 'invalid' } })).rejects.toMatchObject({ status: 400 });
});

});
