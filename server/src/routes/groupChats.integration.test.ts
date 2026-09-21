import express from 'express';
import http from 'node:http';
import net from 'node:net';

jest.mock('../middleware/auth', () => ({
  verifySignature: (_req: any, _res: any, next: any) => next(),
  requireActiveIdentity: (_req: any, _res: any, next: any) => next(),
  requireFullCircleIdentity: (_req: any, _res: any, next: any) => next()
}));

jest.mock('../db', () => ({
  transaction: jest.fn(async (callback: (client: Record<string, never>) => Promise<unknown>) => callback({}))
}));

jest.mock('../db/repositories', () => ({
  groupChatRepository: {
    findParticipant: jest.fn(),
    findChat: jest.fn(),
    findKeyEnvelopeForIdentity: jest.fn(),
    findByClientMessageId: jest.fn(),
    findMessageById: jest.fn(),
    findLatestSystemMessageBySenderAndType: jest.fn(),
    listStateTransitions: jest.fn(),
    insertMessage: jest.fn(),
    editMessage: jest.fn(),
    softDeleteMessage: jest.fn(),
    listActiveParticipants: jest.fn(),
    listActiveParticipantsWithIdentityKeys: jest.fn(),
    listKeyEnvelopeIdentityIds: jest.fn()
  },
  deviceRepository: {
    findActiveByIdentityIds: jest.fn()
  },
  temporaryDeviceRepository: {
    hasChatAccess: jest.fn()
  },
  identityRepository: {
    findByIdentityId: jest.fn(),
    findByIdentityIds: jest.fn()
  },
  familyConfigRepository: {
    findByFamilyId: jest.fn()
  }
}));

jest.mock('../ws/wsGateway', () => ({
  sendGroupChatWsEvent: jest.fn()
}));

jest.mock('./groupChatTrustProtocol', () => ({
  validateGroupMessageAuthorClaim: jest.fn(() => true),
  validateGroupStateTransition: jest.fn(() => ({ ok: true })),
  findCurrentGroupMembershipTransitionId: jest.fn(() => null),
  groupParticipantDiff: jest.fn(() => ({ added: [], removed: [] }))
}));

jest.mock('../utils/push', () => ({
  sendIncomingMessagePush: jest.fn()
}));

import groupChatsRouter from './groupChats';
import { deviceRepository, groupChatRepository, identityRepository, temporaryDeviceRepository } from '../db/repositories';
import { sendGroupChatWsEvent } from '../ws/wsGateway';
import { findCurrentGroupMembershipTransitionId } from './groupChatTrustProtocol';

describe('group chats route integration (send guards)', () => {
  let payload: Record<string, unknown>;
  let accessLevel: 'trusted' | 'temporary';

  async function withServer(
    run: (
      request: (
        urlPath: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string }
      ) => Promise<{ status: number; json: () => Promise<any>; text: () => Promise<string> }>
    ) => Promise<void>
  ) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.familyId = 'f1';
      req.device = { identityId: 'u1', deviceId: 'd1', accessLevel };
      req.signedRequest = { payload, signature: 'sig' };
      next();
    });
    app.use('/api/group-chats', groupChatsRouter);

    const request = async (
      urlPath: string,
      init: { method?: string; headers?: Record<string, string>; body?: string } = {}
    ) => {
      const { method = 'GET', headers = {}, body } = init;
      const normalizedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) normalizedHeaders[key.toLowerCase()] = value;

      if (body != null && normalizedHeaders['content-length'] == null) {
        normalizedHeaders['content-length'] = Buffer.byteLength(body).toString();
      }

      return await new Promise<{ status: number; json: () => Promise<any>; text: () => Promise<string> }>((resolve, reject) => {
        const socket = new net.Socket();
        const req = new http.IncomingMessage(socket);
        req.method = method;
        req.url = urlPath;
        req.headers = normalizedHeaders;

        if (body != null) req.push(body);
        req.push(null);

        const res = new http.ServerResponse(req);
        const chunks: Buffer[] = [];

        res.write = (chunk: any, encoding?: any, cb?: any) => {
          if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
          if (typeof cb === 'function') cb();
          return true;
        };
        res.end = (chunk: any, encoding?: any, cb?: any) => {
          if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
          res.emit('finish');
          if (typeof cb === 'function') cb();
          return res;
        };

        const done = new Promise<void>((r) => res.once('finish', r));
        try {
          app.handle(req, res);
        } catch (e) {
          reject(e);
          return;
        }
        done
          .then(() => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              text: async () => text,
              json: async () => JSON.parse(text)
            });
          })
          .catch(reject);
      });
    };

    await run(request);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    accessLevel = 'trusted';
    payload = {
      ciphertext: `gcm1:${Buffer.from('x'.repeat(24), 'utf8').toString('base64')}`,
      clientMessageId: 'c1',
      clientCreatedAt: 123,
      authorClaim: {},
      epoch: 3
    };

    (groupChatRepository.findParticipant as jest.Mock).mockResolvedValue({ is_active: true });
    (groupChatRepository.findChat as jest.Mock).mockResolvedValue({ key_epoch: 3, protocol_version: 2 });
    (groupChatRepository.findByClientMessageId as jest.Mock).mockResolvedValue(null);
    (groupChatRepository.findLatestSystemMessageBySenderAndType as jest.Mock).mockResolvedValue(null);
    (groupChatRepository.listStateTransitions as jest.Mock).mockResolvedValue([]);
    (findCurrentGroupMembershipTransitionId as jest.Mock).mockReturnValue(null);
    (groupChatRepository.findMessageById as jest.Mock).mockResolvedValue({
      message_id: 'm1',
      chat_id: 'g1',
      sender_identity_id: 'u1',
      kind: 'user',
      deleted_at: null,
      edited_at: null,
      client_message_id: 'c1',
      client_created_at: 123,
      created_at: 456,
      epoch: 3,
      revision: 1
    });
    (groupChatRepository.listActiveParticipants as jest.Mock).mockResolvedValue([{ identity_id: 'u1', muted: false }, { identity_id: 'u2', muted: false }]);
    (groupChatRepository.listActiveParticipantsWithIdentityKeys as jest.Mock).mockResolvedValue([]);
    (groupChatRepository.listKeyEnvelopeIdentityIds as jest.Mock).mockResolvedValue([]);
    (deviceRepository.findActiveByIdentityIds as jest.Mock).mockResolvedValue([]);
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      identity_name: 'Owner',
      public_key_algorithm: 'ed25519',
      public_key_value: 'pk1'
    });
    (identityRepository.findByIdentityIds as jest.Mock).mockResolvedValue([]);
    (temporaryDeviceRepository.hasChatAccess as jest.Mock).mockResolvedValue(false);
  });

  test('rejects message access to an ungranted group chat for a temporary device', async () => {
    accessLevel = 'temporary';

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(403);
    });

    expect(temporaryDeviceRepository.hasChatAccess).not.toHaveBeenCalled();
    expect(groupChatRepository.findParticipant).not.toHaveBeenCalled();
  });

  test('returns 412 when sender envelope is missing', async () => {
    (groupChatRepository.findKeyEnvelopeForIdentity as jest.Mock).mockResolvedValue(null);

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(412);
      const json = await res.json();
      expect(json.error.message).toContain('missing for sender');
    });

    expect(groupChatRepository.insertMessage).not.toHaveBeenCalled();
  });

  test('freezes new messages until the owner signs the required group rekey', async () => {
    (groupChatRepository.findChat as jest.Mock).mockResolvedValue({
      key_epoch: 3,
      protocol_version: 2,
      rekey_required_at: 1_000
    });
    (groupChatRepository.findKeyEnvelopeForIdentity as jest.Mock).mockResolvedValue({
      envelope_ciphertext: 'gk1:abc'
    });

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: { message: 'Group is waiting for an owner-signed rekey transition' }
      });
    });

    expect(groupChatRepository.findKeyEnvelopeForIdentity).not.toHaveBeenCalled();
    expect(groupChatRepository.insertMessage).not.toHaveBeenCalled();
  });

  test('accepts send when sender envelope exists', async () => {
    (groupChatRepository.findKeyEnvelopeForIdentity as jest.Mock).mockResolvedValue({ envelope_ciphertext: 'gk1:abc' });

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('ok');
    });

    expect(groupChatRepository.insertMessage).toHaveBeenCalledTimes(1);
    expect(sendGroupChatWsEvent).toHaveBeenCalled();
  });

  test('rejects new messages after an irrevocable leave request was accepted', async () => {
    (groupChatRepository.findLatestSystemMessageBySenderAndType as jest.Mock).mockResolvedValue({
      system_payload_json: JSON.stringify({
        leaveRequest: {
          type: 'grp:leave-request',
          signerId: 'u1',
          payload: {
            participantIdentityId: 'u1',
            membershipTransitionId: 'gst_current_membership'
          }
        }
      })
    });
    (groupChatRepository.listStateTransitions as jest.Mock).mockResolvedValue([{ signed_transition: {} }]);
    (findCurrentGroupMembershipTransitionId as jest.Mock).mockReturnValue('gst_current_membership');

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: { message: 'Participant is leaving the group' }
      });
    });

    expect(groupChatRepository.insertMessage).not.toHaveBeenCalled();
  });

  test('rejects legacy group ciphertext on send', async () => {
    payload = {
      ciphertext: `v3:${Buffer.from('x'.repeat(24), 'utf8').toString('base64')}`,
      clientMessageId: 'c1',
      epoch: 3
    };
    (groupChatRepository.findKeyEnvelopeForIdentity as jest.Mock).mockResolvedValue({ envelope_ciphertext: 'gk1:abc' });

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(400);
    });

    expect(groupChatRepository.insertMessage).not.toHaveBeenCalled();
  });

  test('loads devices for all group participants in one repository call', async () => {
    (groupChatRepository.listActiveParticipantsWithIdentityKeys as jest.Mock).mockResolvedValue([
      { identity_id: 'u1', public_key_algorithm: 'ed25519', public_key_value: 'pk1', join_order: 1, joined_at: 10 },
      { identity_id: 'u2', public_key_algorithm: 'ed25519', public_key_value: 'pk2', join_order: 2, joined_at: 20 }
    ]);
    (deviceRepository.findActiveByIdentityIds as jest.Mock).mockResolvedValue([
      {
        device_id: 'd1',
        identity_id: 'u1',
        public_key_algorithm: 'ed25519',
        public_key_value: 'dpk1',
        encryption_public_key_value: null,
        registration_attestation: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        status: 'active'
      },
      {
        device_id: 'd2',
        identity_id: 'u2',
        public_key_algorithm: 'ed25519',
        public_key_value: 'dpk2',
        encryption_public_key_value: null,
        registration_attestation: null,
        created_at: new Date('2026-01-02T00:00:00Z'),
        status: 'active'
      }
    ]);

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/participants/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result.participants).toHaveLength(2);
      expect(json.result.participants[1].devices[0].deviceId).toBe('d2');
    });

    expect(deviceRepository.findActiveByIdentityIds).toHaveBeenCalledTimes(1);
    expect(deviceRepository.findActiveByIdentityIds).toHaveBeenCalledWith('f1', ['u1', 'u2']);
  });

  test('loads group-key coverage in one repository call', async () => {
    payload = { epoch: 3 };
    (groupChatRepository.findChat as jest.Mock).mockResolvedValue({ owner_identity_id: 'u1', key_epoch: 3 });
    (groupChatRepository.listActiveParticipants as jest.Mock).mockResolvedValue([
      { identity_id: 'u1' },
      { identity_id: 'u2' }
    ]);
    (groupChatRepository.listKeyEnvelopeIdentityIds as jest.Mock).mockResolvedValue(['u1']);

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/keys/coverage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result.coverage).toEqual([
        { identityId: 'u1', hasEnvelope: true },
        { identityId: 'u2', hasEnvelope: false }
      ]);
      expect(json.result.missingIdentityIds).toEqual(['u2']);
    });

    expect(groupChatRepository.listKeyEnvelopeIdentityIds).toHaveBeenCalledTimes(1);
    expect(groupChatRepository.findKeyEnvelopeForIdentity).not.toHaveBeenCalled();
  });

  test('rejects group message edit when epoch differs from original message epoch', async () => {
    payload = {
      ciphertext: `gcm1:${Buffer.from('edited'.repeat(8), 'utf8').toString('base64')}`,
      epoch: 4
    };

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/m1/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.message).toContain('same epoch');
    });

    expect(groupChatRepository.editMessage).not.toHaveBeenCalled();
  });

  test('rejects legacy group ciphertext on edit', async () => {
    payload = {
      ciphertext: `v3:${Buffer.from('edited'.repeat(8), 'utf8').toString('base64')}`,
      epoch: 3
    };

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/m1/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(400);
    });

    expect(groupChatRepository.editMessage).not.toHaveBeenCalled();
  });

  test('rejects group message edit for non-author', async () => {
    (groupChatRepository.findMessageById as jest.Mock).mockResolvedValue({
      message_id: 'm1',
      chat_id: 'g1',
      sender_identity_id: 'u2',
      kind: 'user',
      deleted_at: null,
      edited_at: null,
      client_message_id: 'c1',
      client_created_at: 123,
      created_at: 456,
      epoch: 3,
      revision: 1
    });
    payload = {
      ciphertext: `gcm1:${Buffer.from('edited'.repeat(8), 'utf8').toString('base64')}`,
      epoch: 3
    };

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/m1/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(403);
    });

    expect(groupChatRepository.editMessage).not.toHaveBeenCalled();
  });

  test('rejects group message edit when message is already deleted', async () => {
    (groupChatRepository.findMessageById as jest.Mock).mockResolvedValue({
      message_id: 'm1',
      chat_id: 'g1',
      sender_identity_id: 'u1',
      kind: 'user',
      deleted_at: 999,
      edited_at: null,
      client_message_id: 'c1',
      client_created_at: 123,
      created_at: 456,
      epoch: 3,
      revision: 2
    });
    payload = {
      ciphertext: `gcm1:${Buffer.from('edited'.repeat(8), 'utf8').toString('base64')}`,
      epoch: 3
    };

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/m1/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(409);
    });

    expect(groupChatRepository.editMessage).not.toHaveBeenCalled();
  });

  test('accepts group message edit for author in same epoch and emits update event', async () => {
    payload = {
      ciphertext: `gcm1:${Buffer.from('edited'.repeat(8), 'utf8').toString('base64')}`,
      epoch: 3
    };

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/m1/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.result.messageId).toBe('m1');
    });

    expect(groupChatRepository.editMessage).toHaveBeenCalledTimes(1);
    expect(sendGroupChatWsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'group:message:updated',
      payload: expect.objectContaining({
        chatId: 'g1',
        messageId: 'm1',
        senderIdentityId: 'u1',
        epoch: 3,
        revision: 2
      })
    }));
  });

  test('rejects deleting a system message', async () => {
    (groupChatRepository.findMessageById as jest.Mock).mockResolvedValue({
      message_id: 'm1',
      chat_id: 'g1',
      sender_identity_id: 'u1',
      kind: 'system',
      deleted_at: null,
      edited_at: null,
      client_message_id: null,
      client_created_at: null,
      created_at: 456,
      epoch: 3,
      revision: 1
    });
    payload = {};

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/m1/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(403);
    });

    expect(groupChatRepository.softDeleteMessage).not.toHaveBeenCalled();
  });

  test('accepts group message delete for author and emits tombstone update', async () => {
    payload = {};

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/messages/m1/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.result.messageId).toBe('m1');
    });

    expect(groupChatRepository.softDeleteMessage).toHaveBeenCalledTimes(1);
    expect(sendGroupChatWsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'group:message:updated',
      payload: expect.objectContaining({
        chatId: 'g1',
        messageId: 'm1',
        senderIdentityId: 'u1',
        ciphertext: '',
        deletedAt: expect.any(Number),
        revision: 2
      })
    }));
  });


});
