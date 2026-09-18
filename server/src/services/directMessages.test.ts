jest.mock('../db/repositories', () => ({
  identityRepository: { findByIdentityId: jest.fn() },
  messageRepository: {
    findByClientMessageId: jest.fn(),
    findMessageById: jest.fn(),
    editMessage: jest.fn(),
    insertMessage: jest.fn(),
    bumpDirectEpochIfStale: jest.fn(),
    getDirectCurrentEpoch: jest.fn(),
    findDirectEpochKey: jest.fn()
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
import { editDirectMessage, sendDirectMessage } from './directMessages';
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
