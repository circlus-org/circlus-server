import express from 'express';
import http from 'node:http';
import net from 'node:net';

jest.mock('../middleware/auth', () => ({
  verifySignature: (_req: any, _res: any, next: any) => next(),
  requireActiveIdentity: (_req: any, _res: any, next: any) => next(),
  getSignedPayload: (req: any) => req.signedRequest?.payload || {}
}));

jest.mock('../db', () => ({
  transaction: jest.fn(async (callback: (client: Record<string, never>) => Promise<unknown>) => callback({}))
}));

jest.mock('../db/repositories', () => ({
  deviceRepository: {},
  identityRepository: {},
  messageRepository: {
    getDirectCurrentEpoch: jest.fn(),
    ensureDirectEpochState: jest.fn(),
    claimDirectEpochKey: jest.fn(),
    upsertDirectKeyEnvelope: jest.fn()
  },
  temporaryDeviceRepository: {
    hasChatAccess: jest.fn()
  }
}));

jest.mock('../services/directGuestAccessService', () => ({
  resolveDirectCommunicationAccess: jest.fn()
}));

jest.mock('../services/directMessages', () => ({
  DirectMessageServiceError: class DirectMessageServiceError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  deleteDirectMessage: jest.fn(),
  editDirectMessage: jest.fn(),
  fetchDirectMessageStatusSync: jest.fn(),
  fetchDirectMessageSync: jest.fn(),
  markDirectMessagesRead: jest.fn(),
  sendDirectMessage: jest.fn(),
  updateDirectMessageStatus: jest.fn()
}));

jest.mock('../utils/crypto', () => ({
  verifySignedRequest: jest.fn(() => true)
}));

import messagesRouter from './messages';
import { messageRepository, temporaryDeviceRepository } from '../db/repositories';
import { resolveDirectCommunicationAccess } from '../services/directGuestAccessService';
import { fetchDirectMessageSync, sendDirectMessage } from '../services/directMessages';

describe('direct messages epoch key claim endpoint', () => {
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
      req.device = {
        identityId: 'u1',
        deviceId: 'd1',
        accessLevel,
        publicKey: { algorithm: 'ed25519', value: 'pk' }
      };
      req.signedRequest = { payload, signature: 'sig' };
      next();
    });
    app.use('/api/messages', messagesRouter);

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
        } catch (error) {
          reject(error);
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
      peerIdentityId: 'u2',
      epoch: 2,
      keyCommitment: 'a'.repeat(64),
      signedEpochTransition: {
        type: 'dir:epoch-transition',
        signerId: 'd1',
        signature: 'sig',
        payload: {
          version: 1,
          purpose: 'direct-epoch-transition-v1',
          directChatId: 'u1::u2',
          participantIdentityIds: ['u1', 'u2'],
          epoch: 2,
          previousEpoch: 1,
          keyCommitment: 'a'.repeat(64),
          proposerIdentityId: 'u1',
          proposerDeviceId: 'd1',
          reason: 'rekey'
        }
      },
      envelopes: [
        { identityId: 'u1', envelopeCiphertext: 'dk2:u1:env1' },
        { identityId: 'u2', envelopeCiphertext: 'dk2:u1:env2' }
      ]
    };

    (resolveDirectCommunicationAccess as jest.Mock).mockResolvedValue({ allowed: true });
    (messageRepository.getDirectCurrentEpoch as jest.Mock).mockResolvedValue(1);
    (messageRepository.ensureDirectEpochState as jest.Mock).mockResolvedValue(2);
    (messageRepository.claimDirectEpochKey as jest.Mock).mockResolvedValue({
      inserted: {
        key_commitment: 'a'.repeat(64),
        proposer_identity_id: 'u1',
        signed_epoch_transition: payload.signedEpochTransition
      },
      existing: null
    });
    (messageRepository.upsertDirectKeyEnvelope as jest.Mock).mockResolvedValue(undefined);
    (temporaryDeviceRepository.hasChatAccess as jest.Mock).mockResolvedValue(false);
  });

  test('accepts safe rekey advance to next epoch and writes envelopes', async () => {
    await withServer(async (request) => {
      const res = await request('/api/messages/key/claim-or-publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.result.epoch).toBe(2);
      expect(json.result.updated).toBe(2);
    });

    expect(messageRepository.ensureDirectEpochState).toHaveBeenCalledWith('f1', 'u1::u2', 2, expect.anything());
    expect(messageRepository.upsertDirectKeyEnvelope).toHaveBeenCalledTimes(2);
  });

  test('validates direct envelopes before advancing or claiming the epoch', async () => {
    payload.envelopes = [{ identityId: 'u1', envelopeCiphertext: 'dk2:u1:env1' }];

    await withServer(async (request) => {
      const res = await request('/api/messages/key/claim-or-publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(400);
    });

    expect(messageRepository.ensureDirectEpochState).not.toHaveBeenCalled();
    expect(messageRepository.claimDirectEpochKey).not.toHaveBeenCalled();
    expect(messageRepository.upsertDirectKeyEnvelope).not.toHaveBeenCalled();
  });

  test('accepts one key envelope for the Favorites self-chat', async () => {
    payload = {
      peerIdentityId: 'u1',
      epoch: 1,
      keyCommitment: 'b'.repeat(64),
      signedEpochTransition: {
        type: 'dir:epoch-transition',
        signerId: 'd1',
        signature: 'sig',
        payload: {
          version: 1,
          purpose: 'direct-epoch-transition-v1',
          directChatId: 'u1::u1',
          participantIdentityIds: ['u1', 'u1'],
          epoch: 1,
          previousEpoch: null,
          keyCommitment: 'b'.repeat(64),
          proposerIdentityId: 'u1',
          proposerDeviceId: 'd1',
          reason: 'initial'
        }
      },
      envelopes: [
        { identityId: 'u1', envelopeCiphertext: 'dk2:u1:self-envelope' }
      ]
    };
    (messageRepository.claimDirectEpochKey as jest.Mock).mockResolvedValue({
      inserted: {
        key_commitment: 'b'.repeat(64),
        proposer_identity_id: 'u1',
        signed_epoch_transition: payload.signedEpochTransition
      },
      existing: null
    });

    await withServer(async (request) => {
      const res = await request('/api/messages/key/claim-or-publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(200);
      expect((await res.json()).result.updated).toBe(1);
    });

    expect(messageRepository.claimDirectEpochKey).toHaveBeenCalledWith(
      expect.objectContaining({ directChatId: 'u1::u1', epoch: 1 }),
      expect.anything()
    );
    expect(messageRepository.upsertDirectKeyEnvelope).toHaveBeenCalledTimes(1);
  });

  test('allows a temporary device to send in a granted direct chat', async () => {
    accessLevel = 'temporary';
    payload = {
      recipientIdentityId: 'u2',
      ciphertext: 'ciphertext',
      senderSignature: 'message-signature',
      clientMessageId: 'client-message'
    };
    (temporaryDeviceRepository.hasChatAccess as jest.Mock).mockResolvedValue(true);
    (sendDirectMessage as jest.Mock).mockResolvedValue({ serverMessageId: 'm1' });

    await withServer(async (request) => {
      const res = await request('/api/messages/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(200);
    });

    expect(temporaryDeviceRepository.hasChatAccess).toHaveBeenCalledWith('f1', 'd1', 'u1::u2', 'direct');
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  test('rejects direct message sync for an ungranted temporary chat', async () => {
    accessLevel = 'temporary';
    payload = { peerIdentityId: 'u2' };

    await withServer(async (request) => {
      const res = await request('/api/messages/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(403);
    });

    expect(temporaryDeviceRepository.hasChatAccess).toHaveBeenCalledWith('f1', 'd1', 'u1::u2', 'direct');
    expect(fetchDirectMessageSync).not.toHaveBeenCalled();
  });
});
