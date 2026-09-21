jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireFullCircleIdentity: jest.fn((_req, _res, next) => next()),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {}),
}));

jest.mock('../middleware/rateLimit', () => ({
  createRateLimiter: jest.fn(() => (_req, _res, next) => next()),
  ipFamilyKey: jest.fn(),
}));

jest.mock('../db/repositories', () => ({
  identityRepository: {
    findAvatarBlobId: jest.fn(),
    setAvatar: jest.fn(),
  },
  attachmentRepository: {
    findBlobById: jest.fn(),
    createAvatarBlob: jest.fn(),
  },
  circleFileAccessRepository: { grantAccess: jest.fn() },
  familyConfigRepository: {},
  CircleDeleteGuardError: class CircleDeleteGuardError extends Error {},
}));

jest.mock('../services/configService', () => ({
  configService: {},
}));

jest.mock('../services/attachmentStorageService', () => ({
  attachmentStorageService: {
    readBlob: jest.fn(),
    buildStorageKey: jest.fn((_familyId, blobId) => `avatars/${blobId}`),
    writeUploadBuffer: jest.fn(),
  },
}));

jest.mock('../services/identityDeletionService', () => ({
  deleteIdentityDataFromCircle: jest.fn(),
  IdentityDeletionServiceError: class IdentityDeletionServiceError extends Error {},
}));

jest.mock('../ws/wsGateway', () => ({
  notifyIdentityServerDataDeleted: jest.fn(),
  notifyCircleServerDataDeleted: jest.fn(),
}));

import { attachmentRepository } from '../db/repositories';
import {
  requireActiveIdentity,
  requireFullCircleIdentity,
  verifySignature,
} from '../middleware/auth';
import { attachmentStorageService } from '../services/attachmentStorageService';

const identitiesRouter = require('./identities').default;

type MockResponse = {
  status: jest.Mock;
  json: jest.Mock;
  end: jest.Mock;
  setHeader: jest.Mock;
};

function findRoute(path: string) {
  return (identitiesRouter as any).stack.find((item: any) => item.route?.path === path);
}

function getAvatarHandler() {
  const layer = findRoute('/avatar/get');
  return layer.route.stack[layer.route.stack.length - 1].handle as (
    req: any,
    res: MockResponse
  ) => Promise<void>;
}

function getAvatarUploadHandler() {
  const layer = findRoute('/avatar');
  return layer.route.stack[layer.route.stack.length - 1].handle as (
    req: any,
    res: MockResponse
  ) => Promise<void>;
}

function makeResponse(): MockResponse {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    end: jest.fn(),
    setHeader: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.end.mockReturnValue(res);
  return res;
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    familyId: 'family_1',
    signedRequest: {
      type: 'identities:avatar:get',
      payload: { targetIdentityId: 'target_identity', blobId: 'blob_1' },
    },
    device: { identityId: 'viewer_identity', deviceId: 'viewer_device' },
    identity: { identityId: 'viewer_identity', role: 'member' },
    ...overrides,
  };
}

describe('protected avatar fetch', () => {
  beforeEach(() => jest.clearAllMocks());

  test('has no public avatar GET route and requires full member authentication', () => {
    expect(findRoute('/:identityId/avatar')).toBeUndefined();

    const route = findRoute('/avatar/get').route;
    expect(route.methods.post).toBe(true);
    expect(route.stack[0].handle).toBe(verifySignature);
    expect(route.stack[1].handle).toBe(requireActiveIdentity);
    expect(route.stack[2].handle).toBe(requireFullCircleIdentity);
  });

  test('binds the operation to the expected signed request type', async () => {
    const res = makeResponse();
    await getAvatarHandler()(
      makeRequest({
        signedRequest: {
          type: 'identities:name:update',
          payload: { targetIdentityId: 'target_identity', blobId: 'blob_1' },
        },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(attachmentRepository.findBlobById).not.toHaveBeenCalled();
  });

  test('returns the target avatar from the authenticated request family', async () => {
    const stream = { pipe: jest.fn() };
    (attachmentRepository.findBlobById as jest.Mock).mockResolvedValue({
      status: 'committed',
      uploader_identity_id: 'target_identity',
      storage_key: 'avatars/blob_1',
      plaintext_size_bytes: 1234,
    });
    (attachmentStorageService.readBlob as jest.Mock).mockResolvedValue(stream);
    const res = makeResponse();

    await getAvatarHandler()(makeRequest(), res);

    expect(attachmentRepository.findBlobById).toHaveBeenCalledWith('family_1', 'blob_1');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(stream.pipe).toHaveBeenCalledWith(res);
  });
});

describe('idempotent encrypted avatar staging', () => {
  beforeEach(() => jest.clearAllMocks());

  test('derives one blob id from the logical publication and reuses a committed retry', async () => {
    const req = makeRequest({
      signedRequest: {
        type: 'identities:avatar:upload',
        payload: { ciphertext: 'cpa1:encrypted-avatar', publicationId: 'publication-1234567890' },
      },
      device: { identityId: 'viewer_identity', deviceId: 'viewer_device' },
    });
    const first = makeResponse();
    (attachmentRepository.findBlobById as jest.Mock).mockResolvedValueOnce(null);
    await getAvatarUploadHandler()(req, first);
    const blobId = first.json.mock.calls[0][0].result.blobId;
    expect(blobId).toMatch(/^av_/);
    expect(attachmentStorageService.writeUploadBuffer).toHaveBeenCalledTimes(1);
    expect((require('../db/repositories').circleFileAccessRepository.grantAccess as jest.Mock)).toHaveBeenCalledTimes(1);

    const second = makeResponse();
    (attachmentRepository.findBlobById as jest.Mock).mockResolvedValueOnce({
      blob_id: blobId,
      uploader_identity_id: 'viewer_identity',
      status: 'committed',
    });
    await getAvatarUploadHandler()(req, second);
    expect(second.json.mock.calls[0][0].result.blobId).toBe(blobId);
    expect(attachmentStorageService.writeUploadBuffer).toHaveBeenCalledTimes(1);
  });
});
