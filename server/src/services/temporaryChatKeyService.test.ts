const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));
jest.mock('../db/repositories', () => ({
  temporaryDeviceRepository: {
    findApprovedTempDevicesForChat: jest.fn(),
    upsertGroupChatKeyEnvelope: jest.fn(),
    upsertDirectChatKeyEnvelope: jest.fn()
  }
}));

import { temporaryDeviceRepository } from '../db/repositories';
import { storeTemporaryDeviceChatKeyEnvelopes } from './temporaryChatKeyService';

const envelopes = [
  {
    temporaryDeviceId: 'temporary-1',
    envelopeCiphertext: 'first',
    publisherEncPublicKeyAlgo: 'x25519',
    publisherEncPublicKeyValue: 'public-key'
  },
  {
    temporaryDeviceId: 'unapproved',
    envelopeCiphertext: 'second',
    publisherEncPublicKeyAlgo: 'x25519',
    publisherEncPublicKeyValue: 'public-key'
  }
];

describe('temporary chat key service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (temporaryDeviceRepository.findApprovedTempDevicesForChat as jest.Mock)
      .mockResolvedValue([{ device_id: 'temporary-1' }]);
  });

  test('stores group envelopes only for devices approved by the publisher', async () => {
    const stored = await storeTemporaryDeviceChatKeyEnvelopes({
      familyId: 'family-1',
      publisherDeviceId: 'device-1',
      publisherIdentityId: 'identity-1',
      chatId: 'chat-1',
      chatType: 'group',
      epoch: 4,
      envelopes
    });

    expect(temporaryDeviceRepository.findApprovedTempDevicesForChat)
      .toHaveBeenCalledWith('family-1', 'device-1', 'chat-1', 'group');
    expect(temporaryDeviceRepository.upsertGroupChatKeyEnvelope).toHaveBeenCalledTimes(1);
    expect(temporaryDeviceRepository.upsertGroupChatKeyEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ temporaryDeviceId: 'temporary-1', publisherIdentityId: 'identity-1' }),
      transactionClient
    );
    expect(temporaryDeviceRepository.upsertDirectChatKeyEnvelope).not.toHaveBeenCalled();
    expect(stored).toBe(1);
  });

  test('uses the direct-chat repository path for direct envelopes', async () => {
    const stored = await storeTemporaryDeviceChatKeyEnvelopes({
      familyId: 'family-1',
      publisherDeviceId: 'device-1',
      publisherIdentityId: 'identity-1',
      chatId: 'identity-1::identity-2',
      chatType: 'direct',
      epoch: 2,
      envelopes: [envelopes[0]]
    });

    expect(temporaryDeviceRepository.upsertDirectChatKeyEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ directChatId: 'identity-1::identity-2', epoch: 2 }),
      transactionClient
    );
    expect(temporaryDeviceRepository.upsertGroupChatKeyEnvelope).not.toHaveBeenCalled();
    expect(stored).toBe(1);
  });
});
