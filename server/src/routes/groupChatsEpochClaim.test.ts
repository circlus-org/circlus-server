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
    claimEpochKey: jest.fn(),
    listActiveParticipants: jest.fn(),
    upsertKeyEnvelopes: jest.fn()
  },
  identityRepository: {
    findByIdentityId: jest.fn()
  }
}));

jest.mock('../ws/wsGateway', () => ({
  sendGroupChatWsEvent: jest.fn()
}));

jest.mock('../utils/push', () => ({
  sendIncomingMessagePush: jest.fn()
}));

jest.mock('../utils/crypto', () => ({
  verifySignedRequest: jest.fn(() => true)
}));

import groupChatsRouter from './groupChats';
import { groupChatRepository } from '../db/repositories';

describe('group chats epoch key claim endpoint', () => {
  let payload: Record<string, unknown>;

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
      req.device = {
        identityId: 'u1',
        deviceId: 'd1',
        publicKey: { algorithm: 'ed25519', value: 'pub' }
      };
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
    payload = {
      epoch: 2,
      keyCommitment: 'a'.repeat(64),
      signedEpochTransition: {
        type: 'grp:epoch-transition',
        signerId: 'd1',
        signature: 'sig',
        payload: {
          version: 1,
          purpose: 'group-epoch-transition-v1',
          chatId: 'g1',
          epoch: 2,
          previousEpoch: 1,
          keyCommitment: 'a'.repeat(64),
          proposerIdentityId: 'u1',
          proposerDeviceId: 'd1'
        }
      },
      envelopes: [
        { identityId: 'u1', envelopeCiphertext: 'gk2:u1:ZW52ZWxvcGUx' },
        { identityId: 'u2', envelopeCiphertext: 'gk2:u1:ZW52ZWxvcGUy' }
      ]
    };

    (groupChatRepository.findParticipant as jest.Mock).mockResolvedValue({ is_active: true });
    (groupChatRepository.findChat as jest.Mock).mockResolvedValue({ key_epoch: 2 });
    (groupChatRepository.listActiveParticipants as jest.Mock).mockResolvedValue([
      { identity_id: 'u1' },
      { identity_id: 'u2' }
    ]);
    (groupChatRepository.upsertKeyEnvelopes as jest.Mock).mockResolvedValue(undefined);
  });

  test('accepts first claim and writes envelopes for all active participants', async () => {
    (groupChatRepository.claimEpochKey as jest.Mock).mockResolvedValue({
      won: true,
      existing: {
        key_commitment: 'a'.repeat(64),
        signed_epoch_transition: payload.signedEpochTransition,
        proposer_identity_id: 'u1'
      }
    });

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/keys/claim-or-publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result.accepted).toBe(true);
      expect(json.result.updated).toBe(2);
    });

    expect(groupChatRepository.upsertKeyEnvelopes).toHaveBeenCalledTimes(1);
  });

  test('rejects conflicting claim when commitment mismatches existing epoch key', async () => {
    (groupChatRepository.claimEpochKey as jest.Mock).mockResolvedValue({
      won: false,
      existing: {
        key_commitment: 'different',
        proposer_identity_id: 'u2'
      }
    });

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/keys/claim-or-publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(409);
    });

    expect(groupChatRepository.upsertKeyEnvelopes).not.toHaveBeenCalled();
  });

  test('validates complete envelope coverage before claiming the epoch key', async () => {
    payload.envelopes = [{ identityId: 'u1', envelopeCiphertext: 'gk2:u1:ZW52ZWxvcGUx' }];

    await withServer(async (request) => {
      const res = await request('/api/group-chats/g1/keys/claim-or-publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(400);
    });

    expect(groupChatRepository.claimEpochKey).not.toHaveBeenCalled();
    expect(groupChatRepository.upsertKeyEnvelopes).not.toHaveBeenCalled();
  });
});
