const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));
jest.mock('../db/repositories', () => ({
  announcementChannelRepository: {
    claimEpochKey: jest.fn(),
    upsertKeyEnvelopes: jest.fn()
  }
}));

import { announcementChannelRepository } from '../db/repositories';
import {
  AnnouncementChannelKeyEpochPersistenceError,
  claimAndPublishAnnouncementChannelEpochKey
} from './announcementChannelKeyEpochService';

const params = {
  familyId: 'family-1',
  channelId: 'channel-1',
  epoch: 2,
  keyCommitment: 'a'.repeat(64),
  proposerIdentityId: 'identity-1',
  proposerDeviceId: 'device-1',
  signedEpochTransition: { type: 'channel-key-transition' },
  envelopes: [
    { identityId: 'identity-1', envelopeCiphertext: 'gk2:identity-1:first' },
    { identityId: 'identity-2', envelopeCiphertext: 'gk2:identity-1:second' }
  ]
};

describe('announcement channel key epoch service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (announcementChannelRepository.claimEpochKey as jest.Mock).mockResolvedValue({
      key_commitment: params.keyCommitment
    });
  });

  test('claims commitment and publishes complete envelope coverage atomically', async () => {
    await claimAndPublishAnnouncementChannelEpochKey(params);

    expect(announcementChannelRepository.claimEpochKey).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'channel-1', epoch: 2 }),
      transactionClient
    );
    expect(announcementChannelRepository.upsertKeyEnvelopes).toHaveBeenCalledWith(
      expect.objectContaining({
        publisherIdentityId: 'identity-1',
        envelopes: params.envelopes
      }),
      transactionClient
    );
  });

  test('does not publish envelopes over another commitment', async () => {
    (announcementChannelRepository.claimEpochKey as jest.Mock).mockResolvedValue({
      key_commitment: 'b'.repeat(64)
    });

    await expect(claimAndPublishAnnouncementChannelEpochKey(params))
      .rejects.toMatchObject<Partial<AnnouncementChannelKeyEpochPersistenceError>>({
        kind: 'commitment_conflict'
      });
    expect(announcementChannelRepository.upsertKeyEnvelopes).not.toHaveBeenCalled();
  });
});
