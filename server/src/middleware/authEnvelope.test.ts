jest.mock('../services/durableNonce', () => { const used = new Set<string>(); return { claimDurableNonce: jest.fn(async (signer: string, nonce: string) => {const key = signer+':'+nonce;if (used.has(key)) return false;used.add(key);return true;}) }; });
jest.mock('../db/repositories', () => ({
  deviceRepository: { findByDeviceId: jest.fn(), updateLastSeen: jest.fn() },
  identityRepository: {},
  serverAdminRepository: {},
  temporaryDeviceRepository: {}
}));

import {
  verifySignature,
  createNonceStore,
  requireFullCircleIdentity,
  rememberSignedRequestNonce,
  validateSignedRequestEnvelope
} from './auth';
import nacl from 'tweetnacl';
import { createSignatureMessage } from '../../../shared/signatureMessage';
import { deviceRepository } from '../db/repositories';

function signedRequest(overrides: Partial<Record<'signature' | 'nonce' | 'timestamp', any>> = {}) {
  return {
    signerId: 'device-1',
    vpsId: 'vps-test',
    circleId: 'circle-1',
    timestamp: 1_000_000,
    nonce: 'nonce-1',
    payload: {},
    signature: { algorithm: 'ed25519', value: 'signature' },
    ...overrides
  };
}

describe('signed request envelope validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.VPS_ID = 'vps-test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('accepts a fresh signed envelope and rejects replayed nonce', () => {
    const store = createNonceStore();
    const request = signedRequest();

    expect(validateSignedRequestEnvelope(request as any, store, 1_000_000)).toEqual({ ok: true });

    rememberSignedRequestNonce(request as any, store, 1_000_000);

    expect(validateSignedRequestEnvelope(request as any, store, 1_000_001)).toMatchObject({
      ok: false,
      status: 401,
      code: 'INVALID_NONCE'
    });
  });

  test.each(['invalid', '1000000', null, undefined, NaN, Infinity])('rejects malformed timestamp %s', (timestamp) => {
    expect(validateSignedRequestEnvelope(signedRequest({ timestamp }) as any, createNonceStore(), 1_000_000))
      .toMatchObject({ ok: false, status: 401 });
  });

  test('retains a future-dated nonce through its entire validity window', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000_000);
      process.env.NONCE_WINDOW_MS = '1000';
      process.env.MAX_TIMESTAMP_DRIFT_MS = '3600000';
      const store = createNonceStore();
      const request = signedRequest({ timestamp: 4_600_000 });
      rememberSignedRequestNonce(request as any, store);
      jest.advanceTimersByTime(600_000);
      expect(validateSignedRequestEnvelope(request as any, store)).toMatchObject({ ok: false, code: 'INVALID_NONCE' });
      jest.advanceTimersByTime(7_200_000);
      expect(store.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('only authenticates one concurrent copy of a genuinely signed request', async () => {
    const key = nacl.sign.keyPair();
    const body = { type: 'devices:list', timestamp: Date.now(), nonce: 'concurrent-auth-regression', signerId: 'device-1', vpsId: 'vps-test', circleId: 'circle-1', payload: {} };
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(createSignatureMessage(body)), key.secretKey)).toString('base64');
    (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue({
      device_id: 'device-1', identity_id: 'identity-1', status: 'active',
      public_key_algorithm: 'ed25519', public_key_value: Buffer.from(key.publicKey).toString('base64')
    });
    (deviceRepository.updateLastSeen as jest.Mock).mockResolvedValue(undefined);
    const next = jest.fn();
    const responses = [0, 1].map(() => ({ status: jest.fn().mockReturnThis(), json: jest.fn() }));
    await Promise.all(responses.map((res) => verifySignature({
      body: { ...body, signature }, familyId: 'family-1', circleId: 'circle-1', get: () => undefined,
      method: 'POST', baseUrl: '/api/devices', route: { path: '/list' }
    } as any, res as any, next)));
    expect(next).toHaveBeenCalledTimes(1);
    expect(responses.filter((res) => res.status.mock.calls.some(([status]) => status === 401))).toHaveLength(1);
  });

  test('cannot redirect a valid list signature to deletion or change its signed type', async () => {
    const key = nacl.sign.keyPair();
    const body = { type: 'devices:list', timestamp: Date.now(), nonce: 'wrong-operation-regression', signerId: 'device-1', vpsId: 'vps-test', circleId: 'circle-1', payload: {} };
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(createSignatureMessage(body)), key.secretKey)).toString('base64');
    (deviceRepository.findByDeviceId as jest.Mock).mockClear().mockResolvedValue({
      device_id: 'device-1', identity_id: 'identity-1', status: 'active',
      public_key_algorithm: 'ed25519', public_key_value: Buffer.from(key.publicKey).toString('base64')
    });
    const invoke = async (type: string, baseUrl: string, routePath: string) => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();
      await verifySignature({ body: { ...body, type, signature }, familyId: 'family-1', circleId: 'circle-1',
        method: 'POST', baseUrl, route: { path: routePath }, get: () => undefined } as any, res as any, next);
      return { res, next };
    };
    const redirected = await invoke('devices:list', '/api/identities', '/delete-self');
    expect(redirected.res.status).toHaveBeenCalledWith(400);
    expect(redirected.next).not.toHaveBeenCalled();
    expect(deviceRepository.findByDeviceId).not.toHaveBeenCalled();
    const forged = await invoke('identity:delete-self', '/api/identities', '/delete-self');
    expect(forged.res.status).toHaveBeenCalledWith(401);
    expect(forged.next).not.toHaveBeenCalled();
    expect((await invoke('devices:list', '/api/devices', '/list')).next).toHaveBeenCalledTimes(1);
  });

  test('rejects a tenant selector that differs from the signed circle destination', async () => {
    (deviceRepository.findByDeviceId as jest.Mock).mockClear();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await verifySignature({
      body: {
        type: 'devices:list',
        vpsId: 'vps-test',
        circleId: 'circle_signed',
        timestamp: Date.now(),
        nonce: 'circle-binding-regression',
        signerId: 'device-1',
        payload: {},
        signature: 'irrelevant'
      },
      familyId: 'family-1',
      circleId: 'circle_selected',
      method: 'POST',
      baseUrl: '/api/devices',
      route: { path: '/list' },
      get: (name: string) => name.toLowerCase() === 'x-circlus-circle-id' ? 'circle_selected' : undefined
    } as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(deviceRepository.findByDeviceId).not.toHaveBeenCalled();
  });

  test('requires a coordinated client update when the signed Circle destination is absent', async () => {
    (deviceRepository.findByDeviceId as jest.Mock).mockClear();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    const body = signedRequest();
    (body as typeof body & { type: string }).type = 'devices:list';
    delete (body as Partial<typeof body>).vpsId;
    delete (body as Partial<typeof body>).circleId;

    await verifySignature({
      body,
      familyId: 'family-1',
      method: 'POST',
      baseUrl: '/api/devices',
      route: { path: '/list' },
      get: () => undefined
    } as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(426);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      error: {
        code: 'CLIENT_UPDATE_REQUIRED',
        message: 'This server requires a newer Circlus client'
      }
    });
    expect(next).not.toHaveBeenCalled();
    expect(deviceRepository.findByDeviceId).not.toHaveBeenCalled();
  });

  test.each([
    { method: 'POST', baseUrl: '/api/not-in-contract', route: { path: '/list' } },
    { method: 'GET', baseUrl: '/api/devices', route: { path: '/list' } },
    { method: 'POST', baseUrl: '/api/devices', route: undefined }
  ])('rejects an unregistered HTTP operation before authorization', async (route) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await verifySignature({ ...route, familyId: 'family-1', body: { type: 'devices:list' } } as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects missing signature and missing nonce', () => {
    const store = createNonceStore();

    expect(validateSignedRequestEnvelope(signedRequest({ signature: undefined }) as any, store, 1_000_000)).toMatchObject({
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED'
    });

    expect(validateSignedRequestEnvelope(signedRequest({ nonce: '' }) as any, store, 1_000_000)).toMatchObject({
      ok: false,
      status: 401,
      code: 'INVALID_NONCE'
    });
  });

  test('rejects timestamp drift outside configured window', () => {
    process.env.MAX_TIMESTAMP_DRIFT_MS = '1000';
    const store = createNonceStore();

    expect(validateSignedRequestEnvelope(signedRequest({ timestamp: 1_000_000 }) as any, store, 1_001_001)).toMatchObject({
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED'
    });
  });
});

describe('requireFullCircleIdentity', () => {
  function createResponse() {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    return res;
  }

  test.each(['owner', 'member'])('allows %s identities', (role) => {
    const req = { identity: { role } };
    const res = createResponse();
    const next = jest.fn();

    requireFullCircleIdentity(req as any, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('rejects guest identities', () => {
    const req = { identity: { role: 'guest' } };
    const res = createResponse();
    const next = jest.fn();

    requireFullCircleIdentity(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      error: { code: 'FORBIDDEN', message: 'Member access required' }
    });
  });
});
