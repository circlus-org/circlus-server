const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));
jest.mock('../db/repositories', () => ({
  groupChatRepository: {
    claimEpochKey: jest.fn(),
    upsertKeyEnvelopes: jest.fn(),
    renameChat: jest.fn()
  }
}));

import { groupChatRepository } from '../db/repositories';
import {
  claimAndPublishGroupChatEpochKey,
  GroupChatKeyEpochPersistenceError
} from './groupChatKeyEpochService';

const params = {
  familyId: 'family-1',
  chatId: 'chat-1',
  epoch: 3,
  keyCommitment: 'a'.repeat(64),
  proposerIdentityId: 'identity-1',
  proposerDeviceId: 'device-1',
  signedEpochTransition: { type: 'group-key-transition' } as any,
  envelopes: [{ identityId: 'identity-1', envelopeCiphertext: 'gk2:identity-1:first' }],
  titleCiphertext: 'encrypted-title',
  now: 1_000_000
};

describe('group chat key epoch service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (groupChatRepository.claimEpochKey as jest.Mock).mockResolvedValue({
      won: true,
      existing: null
    });
  });

  test('claims the epoch, publishes envelopes, and renames atomically', async () => {
    await claimAndPublishGroupChatEpochKey(params);

    expect(groupChatRepository.claimEpochKey).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', epoch: 3, createdAt: 1_000_000 }),
      transactionClient
    );
    expect(groupChatRepository.upsertKeyEnvelopes).toHaveBeenCalledWith(
      expect.objectContaining({
        envelopes: [expect.objectContaining({ publisherIdentityId: 'identity-1' })]
      }),
      transactionClient
    );
    expect(groupChatRepository.renameChat).toHaveBeenCalledWith(
      'family-1', 'chat-1', 'encrypted-title', 1_000_000, transactionClient
    );
  });

  test('does not publish envelopes when another commitment already won', async () => {
    (groupChatRepository.claimEpochKey as jest.Mock).mockResolvedValue({
      won: false,
      existing: { key_commitment: 'b'.repeat(64) }
    });

    await expect(claimAndPublishGroupChatEpochKey(params))
      .rejects.toMatchObject<Partial<GroupChatKeyEpochPersistenceError>>({
        kind: 'commitment_conflict'
      });
    expect(groupChatRepository.upsertKeyEnvelopes).not.toHaveBeenCalled();
    expect(groupChatRepository.renameChat).not.toHaveBeenCalled();
  });
});
