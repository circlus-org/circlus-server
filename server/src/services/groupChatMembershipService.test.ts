const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));
jest.mock('../db/repositories', () => ({
  groupChatRepository: {
    addParticipants: jest.fn(),
    removeParticipant: jest.fn(),
    bumpKeyEpoch: jest.fn(),
    insertMessage: jest.fn(),
    setOwner: jest.fn(),
    findChat: jest.fn(),
    findNextOwner: jest.fn(),
    listActiveParticipants: jest.fn()
  }
}));
jest.mock('../ws/wsGateway', () => ({ sendGroupChatWsEvent: jest.fn() }));

import { groupChatRepository } from '../db/repositories';
import { sendGroupChatWsEvent } from '../ws/wsGateway';
import {
  addGroupChatParticipants,
  leaveGroupChat,
  removeGroupChatParticipant,
  transferGroupChatOwnership
} from './groupChatMembershipService';

const actor = {
  familyId: 'family-1',
  chatId: 'chat-1',
  actorIdentityId: 'identity-1',
  actorDeviceId: 'device-1',
  actorSignature: 'signature',
  now: 1_000_000,
  messageId: 'message-1'
};

describe('group chat membership service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (groupChatRepository.addParticipants as jest.Mock).mockResolvedValue(['identity-2']);
    (groupChatRepository.bumpKeyEpoch as jest.Mock).mockResolvedValue(4);
    (groupChatRepository.insertMessage as jest.Mock).mockResolvedValue({ chat_seq: 1 });
    (groupChatRepository.findChat as jest.Mock).mockResolvedValue({ key_epoch: 4 });
    (groupChatRepository.findNextOwner as jest.Mock).mockResolvedValue('identity-2');
    (groupChatRepository.listActiveParticipants as jest.Mock).mockResolvedValue([
      { identity_id: 'identity-1' },
      { identity_id: 'identity-2' }
    ]);
  });

  test('adds participants, rotates the epoch, and records the system event atomically', async () => {
    const result = await addGroupChatParticipants({
      ...actor,
      participantIds: ['identity-2']
    });

    expect(groupChatRepository.addParticipants).toHaveBeenCalledWith(
      'family-1', 'chat-1', 'identity-1', ['identity-2'], 1_000_000, transactionClient
    );
    expect(groupChatRepository.bumpKeyEpoch)
      .toHaveBeenCalledWith('family-1', 'chat-1', transactionClient);
    expect(groupChatRepository.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: 'message-1',
        epoch: 4,
        system_type: 'participants_added'
      }),
      transactionClient
    );
    expect(sendGroupChatWsEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ event: 'participants_added', keyEpoch: 4 })
    }));
    expect(result).toEqual({ added: ['identity-2'], keyEpoch: 4 });
  });

  test('does not rotate the epoch when every requested participant is already active', async () => {
    (groupChatRepository.addParticipants as jest.Mock).mockResolvedValue([]);

    const result = await addGroupChatParticipants({
      ...actor,
      participantIds: ['identity-2']
    });

    expect(groupChatRepository.bumpKeyEpoch).not.toHaveBeenCalled();
    expect(groupChatRepository.insertMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ added: [], keyEpoch: null });
  });

  test('removes a participant and notifies both remaining and removed identities', async () => {
    (groupChatRepository.listActiveParticipants as jest.Mock).mockResolvedValue([
      { identity_id: 'identity-1' }
    ]);
    const result = await removeGroupChatParticipant({
      ...actor,
      participantId: 'identity-2'
    });

    expect(groupChatRepository.removeParticipant).toHaveBeenCalledWith(
      'family-1', 'chat-1', 'identity-2', 1_000_000, transactionClient
    );
    expect(groupChatRepository.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ system_type: 'participant_removed', epoch: 4 }),
      transactionClient
    );
    expect(sendGroupChatWsEvent).toHaveBeenCalledWith(expect.objectContaining({
      participantIdentityIds: ['identity-1', 'identity-2']
    }));
    expect(result).toEqual({ keyEpoch: 4 });
  });

  test('transfers ownership and records the epoch observed in the transaction', async () => {
    await transferGroupChatOwnership({
      ...actor,
      newOwnerIdentityId: 'identity-2'
    });

    expect(groupChatRepository.setOwner).toHaveBeenCalledWith(
      'family-1', 'chat-1', 'identity-2', 1_000_000, transactionClient
    );
    expect(groupChatRepository.findChat).toHaveBeenCalledWith(
      'family-1', 'chat-1', transactionClient
    );
    expect(groupChatRepository.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ system_type: 'owner_transferred', epoch: 4 }),
      transactionClient
    );
  });

  test('assigns the next active owner while the current owner leaves', async () => {
    const result = await leaveGroupChat({
      ...actor,
      currentOwnerIdentityId: 'identity-1'
    });

    expect(groupChatRepository.findNextOwner).toHaveBeenCalledWith(
      'family-1', 'chat-1', transactionClient
    );
    expect(groupChatRepository.setOwner).toHaveBeenCalledWith(
      'family-1', 'chat-1', 'identity-2', 1_000_000, transactionClient
    );
    expect(groupChatRepository.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        system_type: 'participant_left',
        system_payload_json: JSON.stringify({
          identityId: 'identity-1',
          ownerIdentityId: 'identity-2',
          keyEpoch: 4
        })
      }),
      transactionClient
    );
    expect(result).toEqual({ keyEpoch: 4, ownerIdentityId: 'identity-2' });
  });

  test('does not fan out an event when transactional persistence fails', async () => {
    (groupChatRepository.insertMessage as jest.Mock).mockRejectedValue(new Error('write failed'));

    await expect(removeGroupChatParticipant({
      ...actor,
      participantId: 'identity-2'
    })).rejects.toThrow('write failed');
    expect(groupChatRepository.listActiveParticipants).not.toHaveBeenCalled();
    expect(sendGroupChatWsEvent).not.toHaveBeenCalled();
  });
});
