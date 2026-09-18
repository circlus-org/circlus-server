const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));
jest.mock('../db/repositories', () => ({
  messageRepository: {
    ensureDirectEpochState: jest.fn(),
    claimDirectEpochKey: jest.fn(),
    upsertDirectKeyEnvelope: jest.fn()
  }
}));

import { messageRepository } from '../db/repositories';
import {
  claimAndPublishDirectEpochKey,
  DirectKeyEpochPersistenceError
} from './directKeyEpochService';

const params = {
  familyId: 'family-1',
  directChatId: 'identity-1::identity-2',
  epoch: 2,
  keyCommitment: 'a'.repeat(64),
  proposerIdentityId: 'identity-1',
  proposerDeviceId: 'device-1',
  signedEpochTransition: { type: 'direct-key-transition' } as any,
  envelopes: [
    { identityId: 'identity-1', envelopeCiphertext: 'dk2:identity-1:first' },
    { identityId: 'identity-2', envelopeCiphertext: 'dk2:identity-1:second' }
  ],
  advanceEpoch: true
};

describe('direct key epoch service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (messageRepository.ensureDirectEpochState as jest.Mock).mockResolvedValue(2);
    (messageRepository.claimDirectEpochKey as jest.Mock).mockResolvedValue({
      inserted: { key_commitment: params.keyCommitment },
      existing: null
    });
  });

  test('advances, claims, and publishes every envelope in one transaction', async () => {
    await claimAndPublishDirectEpochKey(params);

    expect(messageRepository.ensureDirectEpochState).toHaveBeenCalledWith(
      'family-1', params.directChatId, 2, transactionClient
    );
    expect(messageRepository.claimDirectEpochKey).toHaveBeenCalledWith(
      expect.objectContaining({ directChatId: params.directChatId, epoch: 2 }),
      transactionClient
    );
    expect(messageRepository.upsertDirectKeyEnvelope).toHaveBeenCalledTimes(2);
    expect(messageRepository.upsertDirectKeyEnvelope).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ identityId: 'identity-1', publisherIdentityId: 'identity-1' }),
      transactionClient
    );
  });

  test('does not claim when concurrent epoch advancement resolves differently', async () => {
    (messageRepository.ensureDirectEpochState as jest.Mock).mockResolvedValue(3);

    await expect(claimAndPublishDirectEpochKey(params))
      .rejects.toMatchObject<Partial<DirectKeyEpochPersistenceError>>({ kind: 'epoch_state_conflict' });
    expect(messageRepository.claimDirectEpochKey).not.toHaveBeenCalled();
    expect(messageRepository.upsertDirectKeyEnvelope).not.toHaveBeenCalled();
  });

  test('does not publish envelopes over a different commitment', async () => {
    (messageRepository.claimDirectEpochKey as jest.Mock).mockResolvedValue({
      inserted: null,
      existing: { key_commitment: 'b'.repeat(64) }
    });

    await expect(claimAndPublishDirectEpochKey(params))
      .rejects.toMatchObject<Partial<DirectKeyEpochPersistenceError>>({ kind: 'commitment_conflict' });
    expect(messageRepository.upsertDirectKeyEnvelope).not.toHaveBeenCalled();
  });
});
