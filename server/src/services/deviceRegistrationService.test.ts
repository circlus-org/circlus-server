const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));
jest.mock('../db/repositories', () => ({
  deviceRepository: { create: jest.fn() },
  trustedDeviceRekeyRepository: { enqueue: jest.fn() }
}));
jest.mock('./trustedDeviceRekeyService', () => ({
  requestTrustedDeviceRekeyProcessing: jest.fn()
}));

import { deviceRepository, trustedDeviceRekeyRepository } from '../db/repositories';
import { requestTrustedDeviceRekeyProcessing } from './trustedDeviceRekeyService';
import { registerIdentityDevice } from './deviceRegistrationService';

const params = {
  familyId: 'family-1',
  identityId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
  deviceId: 'device-1',
  devicePublicKey: { algorithm: 'ed25519' as const, value: 'device-public-key' },
  deviceEncryptionPublicKey: { algorithm: 'x25519' as const, value: 'device-encryption-key' },
  registrationAttestation: null,
  label: 'Phone',
  webOrigin: 'https://circle.example',
  encryptedPhysicalDeviceId: { cipher: 'aes-256-gcm', data: 'ciphertext' }
};

describe('device registration service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transactionClient.query.mockReset();
    transactionClient.query
      .mockResolvedValueOnce({ rows: [{ identity_id: params.identityId, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    (deviceRepository.create as jest.Mock).mockResolvedValue({ device_id: 'device-1' });
    (trustedDeviceRekeyRepository.enqueue as jest.Mock).mockResolvedValue({ status: 'pending' });
  });

  test('registers the first device without scheduling an unnecessary rekey', async () => {
    const result = await registerIdentityDevice(params);

    expect(deviceRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ identityId: params.identityId, deviceId: 'device-1' }),
      transactionClient
    );
    expect(trustedDeviceRekeyRepository.enqueue).not.toHaveBeenCalled();
    expect(requestTrustedDeviceRekeyProcessing).not.toHaveBeenCalled();
    expect(result.rekey).toBeNull();
  });

  test('commits a rekey obligation when adding another device', async () => {
    transactionClient.query.mockReset();
    transactionClient.query
      .mockResolvedValueOnce({ rows: [{ identity_id: params.identityId, status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] });

    await registerIdentityDevice(params);

    expect(trustedDeviceRekeyRepository.enqueue).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({ identityId: params.identityId, reason: 'device_added' })
    );
    expect(requestTrustedDeviceRekeyProcessing).toHaveBeenCalledTimes(1);
  });

  test('rechecks identity status while holding the registration lock', async () => {
    transactionClient.query.mockReset();
    transactionClient.query.mockResolvedValueOnce({
      rows: [{ identity_id: params.identityId, status: 'removed' }]
    });

    await expect(registerIdentityDevice(params)).rejects.toThrow('Identity is not active');
    expect(deviceRepository.create).not.toHaveBeenCalled();
    expect(trustedDeviceRekeyRepository.enqueue).not.toHaveBeenCalled();
  });
});

describe('additional guest devices', () => {
  beforeEach(() => { jest.clearAllMocks(); transactionClient.query.mockReset(); });
  test('uses the same guest identity and rotates keys without consuming another invitation', async () => {
    transactionClient.query
      .mockResolvedValueOnce({ rows: [{ identity_id: params.identityId, status: 'active', role: 'guest' }] })
      .mockResolvedValueOnce({ rows: [{ registration_id: 'registration-1' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });
    (deviceRepository.create as jest.Mock).mockResolvedValue({ device_id: params.deviceId });
    (trustedDeviceRekeyRepository.enqueue as jest.Mock).mockResolvedValue({ status: 'pending' });
    await registerIdentityDevice(params);
    expect(transactionClient.query.mock.calls[1][0]).toContain('FOR SHARE');
    expect(transactionClient.query.mock.calls[1][1]).toEqual([params.familyId, params.identityId]);
    expect(deviceRepository.create).toHaveBeenCalledWith(expect.objectContaining({ identityId: params.identityId }), transactionClient);
    expect(trustedDeviceRekeyRepository.enqueue).toHaveBeenCalledWith(transactionClient,
      expect.objectContaining({ identityId: params.identityId, reason: 'device_added' }));
  });
  test('cannot add a device after withdrawal or host revocation even if the identity is active', async () => {
    transactionClient.query
      .mockResolvedValueOnce({ rows: [{ identity_id: params.identityId, status: 'active', role: 'guest' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(registerIdentityDevice(params)).rejects.toThrow('Guest access is no longer active');
    expect(deviceRepository.create).not.toHaveBeenCalled();
    expect(trustedDeviceRekeyRepository.enqueue).not.toHaveBeenCalled();
  });
});
