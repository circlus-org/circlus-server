jest.mock('../services/durableNonce', () => { const used = new Set<string>(); return { claimDurableNonce: jest.fn(async (signer: string, nonce: string) => {const key = signer+':'+nonce;if (used.has(key)) return false;used.add(key);return true;}) }; });
jest.mock('../db/repositories', () => ({
  identityRepository: { findByIdentityId: jest.fn() },
  deviceRepository: {
    findByPublicKey: jest.fn(),
    findByDeviceId: jest.fn(),
    updateEncryptedPhysicalDeviceId: jest.fn()
  }
}));

jest.mock('../utils/crypto', () => ({ verifySignedRequest: jest.fn(() => true) }));
jest.mock('../utils/routeLogger', () => ({ routeLogger: { error: jest.fn() } }));
jest.mock('../utils/trustedOrigins', () => ({ normalizeTrustedOrigin: jest.fn(() => null) }));
jest.mock('../middleware/rateLimit', () => ({
  createRateLimiter: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  ipFamilyKey: jest.fn()
}));
jest.mock('../config/serverRuntimeConfig', () => ({
  ...jest.requireActual('../config/serverRuntimeConfig'),
  getRateLimitRuntimeConfig: jest.fn(() => ({ auth: { windowMs: 60_000, registerDeviceMax: 100 } })),
  getSecurityRuntimeConfig: jest.fn(() => ({ maxTimestampDriftMs: 60_000, nonceWindowMs: 60_000 }))
}));
jest.mock('../services/deviceRegistrationService', () => ({ registerIdentityDevice: jest.fn() }));

import { deviceRepository, identityRepository } from '../db/repositories';
import { convertEd25519PublicKeyToX25519 } from '../utils/deviceEncryptionKeyAudit';

jest.useFakeTimers();
const router = require('./authDeviceRegistrationRoutes').default;

type MockResponse = { status: jest.Mock; json: jest.Mock };

function getHandler() {
  const layer = router.stack.find((item: any) => item.route?.path === '/register-device');
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function makeResponse(): MockResponse {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  return response;
}

const signingPublicKey = Buffer.alloc(32, 1).toString('base64');
const independentEncryptionPublicKey = Buffer.alloc(32, 2).toString('base64');
const otherIndependentEncryptionPublicKey = Buffer.alloc(32, 3).toString('base64');
const derivedEncryptionPublicKey = Buffer.from(
  convertEd25519PublicKeyToX25519(Buffer.alloc(32, 1))!
).toString('base64');

const validRegistrationAttestation = {
  version: 1,
  identitySignedRequest: { signature: 'identity-signature' },
  deviceKeyBinding: { signature: 'device-signature' }
};

function makeDevice(
  encryptionPublicKeyValue: string | null,
  registrationAttestation: unknown = validRegistrationAttestation
) {
  return {
    device_id: 'device-12345678',
    identity_id: 'identity-1',
    public_key_algorithm: 'ed25519',
    public_key_value: signingPublicKey,
    encryption_public_key_algorithm: encryptionPublicKeyValue ? 'x25519' : null,
    encryption_public_key_value: encryptionPublicKeyValue,
    registration_attestation: registrationAttestation,
    encrypted_physical_device_id: null,
    label: null,
    web_origin: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    status: 'active'
  };
}

function makeRequest(encryptionPublicKeyValue: string | null, nonce: string) {
  const deviceEncryptionPublicKey = encryptionPublicKeyValue
    ? { algorithm: 'x25519', value: encryptionPublicKeyValue }
    : undefined;
  return {
    familyId: 'family-1',
    circleId: 'circle-1',
    get: jest.fn(() => undefined),
    body: {
      type: 'auth:register-device',
      vpsId: 'vps-test',
      circleId: 'circle-1',
      signerId: 'identity-1',
      timestamp: Date.now(),
      nonce,
      signature: 'identity-signature',
      payload: {
        deviceId: 'device-12345678',
        devicePublicKey: { algorithm: 'ed25519', value: signingPublicKey },
        deviceEncryptionPublicKey,
        deviceKeyBinding: deviceEncryptionPublicKey ? {
          type: 'device:key-binding',
          signerId: 'device-12345678',
          timestamp: Date.now(),
          nonce: `binding-${nonce}`,
          signature: 'device-signature',
          payload: {
            version: 1,
            purpose: 'device-key-binding-v1',
            identityId: 'identity-1',
            devicePublicKey: { algorithm: 'ed25519', value: signingPublicKey },
            deviceEncryptionPublicKey
          }
        } : undefined
      }
    }
  };
}

describe('strict idempotent device registration', () => {
  beforeEach(() => {
    process.env.VPS_ID = 'vps-test';
    jest.clearAllMocks();
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      identity_id: 'identity-1',
      public_key_algorithm: 'ed25519',
      public_key_value: signingPublicKey,
      status: 'active'
    });
  });

  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test.each([NaN, Infinity, -Infinity, Date.now() - 120_000])('rejects invalid or expired timestamp %s', async timestamp => {
    const req = makeRequest(independentEncryptionPublicKey, 'invalid-time-' + timestamp);
    req.body.timestamp = timestamp;
    const response = makeResponse();
    await getHandler()(req, response);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(identityRepository.findByIdentityId).not.toHaveBeenCalled();
  });

  test('consumes one envelope atomically under concurrent registration', async () => {
    (deviceRepository.findByPublicKey as jest.Mock).mockResolvedValue(makeDevice(independentEncryptionPublicKey));
    const request = makeRequest(independentEncryptionPublicKey, 'concurrent-registration');
    const responses = [makeResponse(), makeResponse()];
    await Promise.all(responses.map(response => getHandler()(request, response)));
    expect(responses.filter(response => response.status.mock.calls.some(([status]) => status === 401))).toHaveLength(1);
    expect(responses.filter(response => response.json.mock.calls.some(([body]) => body.status === 'ok'))).toHaveLength(1);
  });

  test('returns an already registered modern device without mutating its key metadata', async () => {
    const existing = makeDevice(independentEncryptionPublicKey);
    (deviceRepository.findByPublicKey as jest.Mock).mockResolvedValue(existing);

    const response = makeResponse();
    await getHandler()(makeRequest(independentEncryptionPublicKey, 'nonce-modern'), response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        encryptionPublicKey: { algorithm: 'x25519', value: independentEncryptionPublicKey }
      })
    }));
  });

  test.each([
    { name: 'missing encryption key', existingValue: null, attestation: validRegistrationAttestation },
    { name: 'derived encryption key', existingValue: derivedEncryptionPublicKey, attestation: validRegistrationAttestation },
    { name: 'missing attestation', existingValue: independentEncryptionPublicKey, attestation: null }
  ])('rejects an existing device with $name instead of upgrading it', async ({ name, existingValue, attestation }) => {
    (deviceRepository.findByPublicKey as jest.Mock).mockResolvedValue(
      makeDevice(existingValue, attestation)
    );

    const response = makeResponse();
    await getHandler()(makeRequest(independentEncryptionPublicKey, `nonce-existing-${name}`), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(deviceRepository.updateEncryptedPhysicalDeviceId).not.toHaveBeenCalled();
  });

  test('rejects replacement of an independent key', async () => {
    (deviceRepository.findByPublicKey as jest.Mock).mockResolvedValue(makeDevice(independentEncryptionPublicKey));

    const response = makeResponse();
    await getHandler()(makeRequest(otherIndependentEncryptionPublicKey, 'nonce-conflict'), response);

    expect(response.status).toHaveBeenCalledWith(409);
  });

  test.each([
    { name: 'missing encryption key', value: null },
    { name: 'derived legacy encryption key', value: derivedEncryptionPublicKey }
  ])('rejects a new device with $name', async ({ value }) => {
    (deviceRepository.findByPublicKey as jest.Mock).mockResolvedValue(null);

    const response = makeResponse();
    await getHandler()(makeRequest(value, `nonce-new-${value ? 'derived' : 'missing'}`), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(deviceRepository.findByDeviceId).not.toHaveBeenCalled();
  });
});
