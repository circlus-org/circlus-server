jest.mock('../db/repositories', () => ({
  identityRepository: { findByIdentityId: jest.fn() },
  messageRepository: {
    findByClientMessageId: jest.fn(),
    findMessageById: jest.fn(),
    editMessage: jest.fn(),
    insertMessage: jest.fn(),
    bumpDirectEpochIfStale: jest.fn(),
    getDirectCurrentEpoch: jest.fn(),
    findDirectEpochKey: jest.fn(),
    getSyncState: jest.fn(),
    fetchStatusUpdatesForSync: jest.fn(),
    fetchMessagesForReadProof: jest.fn(),
    upsertReadCursor: jest.fn(),
    fetchUnreadMessagesFromUpTo: jest.fn(),
    updateStatus: jest.fn(),
    recordReadProof: jest.fn()
  },
  directGuestRegistrationRepository: { touchLastSeen: jest.fn() },
}));

jest.mock('./directGuestAccessService', () => ({
  resolveDirectCommunicationAccess: jest.fn()
}));

jest.mock('../utils/push', () => ({
  sendIncomingMessagePush: jest.fn(),
  sendMessagesReadPush: jest.fn()
}));

jest.mock('./configService', () => ({
  configService: {
    getNoNamesOnServer: jest.fn(),
    getResolvedFamilyConfig: jest.fn()
  }
}));

jest.mock('../ws/wsGateway', () => ({
  sendDirectChatWsEvent: jest.fn()
}));

jest.mock('../db', () => ({ query: jest.fn() }));

jest.mock('../utils/crypto', () => ({ verifySignedRequest: jest.fn(() => true) }));

import { verifySignedRequest } from '../utils/crypto';
import { identityRepository, messageRepository } from '../db/repositories';
import { sendIncomingMessagePush } from '../utils/push';
import { sendDirectChatWsEvent } from '../ws/wsGateway';
import { resolveDirectCommunicationAccess } from './directGuestAccessService';
import { editDirectMessage, fetchDirectMessageStatusSync, markDirectMessagesRead, sendDirectMessage } from './directMessages';
import { configService } from './configService';

describe('direct message idempotency', () => {
  const validCiphertext = `dcm1:${Buffer.from('x'.repeat(24), 'utf8').toString('base64')}`;

  beforeEach(() => {
    jest.clearAllMocks();
    (configService.getResolvedFamilyConfig as jest.Mock).mockResolvedValue({
      chatEpochRotationIntervalHours: 24
    });
    (messageRepository.getDirectCurrentEpoch as jest.Mock).mockResolvedValue(2);
    (messageRepository.findDirectEpochKey as jest.Mock).mockResolvedValue({ epoch: 2 });
  });

  it('returns the original ACK without storing or delivering a duplicate', async () => {
    (resolveDirectCommunicationAccess as jest.Mock).mockResolvedValue({
      allowed: true,
      relation: 'circle_member'
    });
    (messageRepository.findByClientMessageId as jest.Mock).mockResolvedValue({
      server_message_id: 'server-message-1',
      created_at: 1_234
    });

    const result = await sendDirectMessage({
      familyId: 'circle-1',
      senderIdentityId: 'sender-1',
      senderDeviceId: 'device-1',
      recipientIdentityId: 'recipient-1',
      ciphertext: validCiphertext,
      senderSignature: 'signature',
      clientMessageId: 'client-message-1',
      clientCreatedAt: 1_000,
      epoch: 2
    });

    expect(messageRepository.findByClientMessageId).toHaveBeenCalledWith(
      'circle-1',
      'device-1',
      'client-message-1'
    );
    expect(result).toEqual({
      ack: {
        clientMessageId: 'client-message-1',
        serverMessageId: 'server-message-1',
        serverTimestamp: 1_234,
        status: 'new'
      },
      statusUpdate: null
    });
    expect(messageRepository.insertMessage).not.toHaveBeenCalled();
    expect(sendDirectChatWsEvent).not.toHaveBeenCalled();
    expect(sendIncomingMessagePush).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing epoch', ciphertext: validCiphertext, epoch: undefined },
    { name: 'legacy ciphertext', ciphertext: 'v3:ciphertext', epoch: 2 },
    { name: 'legacy sender ciphertext', ciphertext: validCiphertext, senderCiphertext: 'v3:ciphertext', epoch: 2 },
    { name: 'malformed dcm1 ciphertext', ciphertext: 'dcm1:not-base64!', epoch: 2 }
  ])('rejects $name before accessing message storage', async ({ ciphertext, senderCiphertext, epoch }) => {
    await expect(sendDirectMessage({
      familyId: 'circle-1',
      senderIdentityId: 'sender-1',
      senderDeviceId: 'device-1',
      recipientIdentityId: 'recipient-1',
      ciphertext,
      senderCiphertext,
      senderSignature: 'signature',
      clientMessageId: 'client-message-1',
      epoch
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });

    expect(messageRepository.findByClientMessageId).not.toHaveBeenCalled();
    expect(messageRepository.insertMessage).not.toHaveBeenCalled();
  });
});

describe('focused direct-message status sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (messageRepository.getSyncState as jest.Mock).mockResolvedValue({
      last_sync_at: 900,
      last_status_sync_at: 800,
      last_mutation_sync_at: 700
    });
    (messageRepository.fetchStatusUpdatesForSync as jest.Mock).mockResolvedValue([]);
  });

  it('replays the whole peer status history instead of using the global device cursor', async () => {
    await fetchDirectMessageStatusSync({
      familyId: 'circle-1',
      identityId: 'identity-1',
      deviceId: 'device-2',
      peerIdentityId: 'identity-2'
    });

    expect(messageRepository.fetchStatusUpdatesForSync).toHaveBeenCalledWith(
      'circle-1',
      'identity-1',
      0,
      101,
      'identity-2'
    );
  });
});


describe('stale direct-message edits', () => {
  const ciphertext = `dcm1:${Buffer.from('x'.repeat(24)).toString('base64')}`;
  beforeEach(() => {
    jest.clearAllMocks();
    (verifySignedRequest as jest.Mock).mockReturnValue(true);
    (messageRepository.findMessageById as jest.Mock).mockResolvedValue({
      sender_identity_id: 'a', recipient_identity_id: 'b', deleted_at: null,
      client_message_id: 'm', client_created_at: 100, revision: 2, author_claim: null
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({public_key: {algorithm: 'ed25519', value: 'key'}});
    (messageRepository.getDirectCurrentEpoch as jest.Mock).mockResolvedValue(1);
    (messageRepository.findDirectEpochKey as jest.Mock).mockResolvedValue({epoch: 1});
  });
  function edit() {
    return editDirectMessage({familyId: 'circle', identityId: 'a', serverMessageId: 'm',
      ciphertext, senderSignature: 'signature', epoch: 1,
      authorClaim: {type: 'msg:author', signerId: 'a', timestamp: 1, nonce: 'n', signature: 'signed',
        payload: {version: 1, purpose: 'direct-message-author-v1', action: 'edit',
          senderIdentityId: 'a', recipientIdentityId: 'b', directChatId: 'a::b',
          clientMessageId: 'm', clientCreatedAt: 100, epoch: 1, revision: 2,
          ciphertext, senderCiphertext: null, senderSignature: 'signature'}}});
  }
  it('returns a revision conflict for an authentic stale edit without writing', async () => {
    await expect(edit()).rejects.toMatchObject({status: 409, code: 'CONFLICT'});
    expect(messageRepository.editMessage).not.toHaveBeenCalled();
  });
  it('still rejects an invalid signature as a bad request', async () => {
    (verifySignedRequest as jest.Mock).mockReturnValue(false);
    await expect(edit()).rejects.toMatchObject({status: 400, code: 'INVALID_REQUEST'});
    expect(messageRepository.editMessage).not.toHaveBeenCalled();
  });
});


describe('signed direct-message read confirmations', () => {
  const proof = {
    receipt: {
      type: 'msg:read-receipt', signerId: 'recipient', timestamp: Date.now(), nonce: 'nonce', signature: 'signature',
      payload: { version: 1, purpose: 'direct-message-read-v1', readTimeVisible: true, senderIdentityId: 'sender',
        recipientIdentityId: 'recipient', recipientDeviceId: 'device', serverMessageIds: ['visible'] }
    }
  } as const;

  beforeEach(() => {
    jest.clearAllMocks();
    (verifySignedRequest as jest.Mock).mockReturnValue(true);
    (messageRepository.fetchMessagesForReadProof as jest.Mock).mockResolvedValue([
      { server_message_id: 'visible', created_at: proof.receipt.timestamp - 1000 }
    ]);
    (messageRepository.fetchUnreadMessagesFromUpTo as jest.Mock).mockResolvedValue([
      { server_message_id: 'visible', created_at: proof.receipt.timestamp - 1000 },
      { server_message_id: 'unseen', created_at: proof.receipt.timestamp - 2000 }
    ]);
    (messageRepository.recordReadProof as jest.Mock).mockResolvedValue(true);
  });

  it('rejects a time-bearing receipt when presence is hidden without changing read state', async () => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      public_key_algorithm: 'ed25519', public_key_value: 'key', presence_visible: false
    });
    await expect(markDirectMessagesRead({
      familyId: 'circle', identityId: 'recipient', deviceId: 'device', peerIdentityId: 'sender',
      readThrough: proof.receipt.timestamp, readProof: proof
    })).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE', message: 'READ_TIME_HIDDEN' });
    expect(messageRepository.upsertReadCursor).not.toHaveBeenCalled();
    expect(messageRepository.recordReadProof).not.toHaveBeenCalled();
  });

  it.each([true, false])('sends signed proof only to the message sender when presence visibility is %s', async (presenceVisible) => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      public_key_algorithm: 'ed25519', public_key_value: 'key', presence_visible: presenceVisible
    });
    const requestProof = { receipt: { ...proof.receipt, payload: {
      ...proof.receipt.payload, readTimeVisible: presenceVisible
    } } };
    const result = await markDirectMessagesRead({
      familyId: 'circle', identityId: 'recipient', deviceId: 'device', peerIdentityId: 'sender',
      readThrough: proof.receipt.timestamp, readProof: requestProof
    });

    expect(result.statusUpdates.find((update) => update.serverMessageId === 'unseen')?.readProof).toBeUndefined();
    expect(result.statusUpdates.find((update) => update.serverMessageId === 'unseen')?.serverTimestamp)
      .toBe(proof.receipt.timestamp - 2000);
    expect(messageRepository.recordReadProof).toHaveBeenCalledTimes(1);
    expect(result.statusUpdates.find((update) => update.serverMessageId === 'visible')?.readProof).toEqual(requestProof);
    expect(result.statusUpdates.find((update) => update.serverMessageId === 'visible')?.serverTimestamp)
      .toEqual(presenceVisible ? expect.any(Number) : proof.receipt.timestamp);
    const receiptEvents = (sendDirectChatWsEvent as jest.Mock).mock.calls.filter(
      ([, , , event]) => event.type === 'message:status-update' && event.data.readProof
    );
    expect(receiptEvents).toHaveLength(1);
    expect(receiptEvents[0][0]).toBe('circle');
    expect(receiptEvents[0][1]).toBe('sender');
  });
});
