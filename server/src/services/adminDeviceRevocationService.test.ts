const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: unknown) => unknown) => work(transactionClient))
}));
jest.mock('../db/repositories', () => ({
  deviceRepository: {
    findByDeviceId: jest.fn(),
    revoke: jest.fn()
  },
  trustedDeviceRekeyRepository: {
    enqueue: jest.fn()
  }
}));
jest.mock('./trustedDeviceRekeyService', () => ({
  requestTrustedDeviceRekeyProcessing: jest.fn()
}));
jest.mock('../ws/wsGateway', () => ({ notifyDeviceRevoked: jest.fn() }));

import { deviceRepository, trustedDeviceRekeyRepository } from '../db/repositories';
import { requestTrustedDeviceRekeyProcessing } from './trustedDeviceRekeyService';
import { notifyDeviceRevoked } from '../ws/wsGateway';
import {
  AdminDeviceRevocationError,
  revokeDeviceAsAdmin
} from './adminDeviceRevocationService';

describe('admin device revocation service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue({ identity_id: 'identity-1' });
    (deviceRepository.revoke as jest.Mock).mockResolvedValue(true);
    (trustedDeviceRekeyRepository.enqueue as jest.Mock).mockResolvedValue({
      jobId: 'rekey-1',
      status: 'pending',
      groupTargets: 2,
      directTargets: 1
    });
  });

  test('commits revocation and rekey obligation before notifying clients', async () => {
    const result = await revokeDeviceAsAdmin({ familyId: 'family-1', deviceId: 'device-1' });

    expect(deviceRepository.revoke).toHaveBeenCalledWith('family-1', 'device-1', transactionClient);
    expect(trustedDeviceRekeyRepository.enqueue).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({ deviceId: 'device-1', reason: 'device_revoked' })
    );
    expect(notifyDeviceRevoked).toHaveBeenCalledWith('device-1', 'identity-1');
    expect(requestTrustedDeviceRekeyProcessing).toHaveBeenCalledTimes(1);
    expect(result.rekey.jobId).toBe('rekey-1');
  });

  test('reports a missing device without creating a rekey obligation', async () => {
    (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue(null);

    await expect(revokeDeviceAsAdmin({ familyId: 'family-1', deviceId: 'missing' }))
      .rejects.toMatchObject<Partial<AdminDeviceRevocationError>>({ status: 404, code: 'NOT_FOUND' });
    expect(trustedDeviceRekeyRepository.enqueue).not.toHaveBeenCalled();
  });

  test('preserves the existing invalid-state response for an already revoked device', async () => {
    (deviceRepository.revoke as jest.Mock).mockResolvedValue(false);

    await expect(revokeDeviceAsAdmin({ familyId: 'family-1', deviceId: 'device-1' }))
      .rejects.toMatchObject<Partial<AdminDeviceRevocationError>>({ status: 400, code: 'INVALID_STATE' });
    expect(notifyDeviceRevoked).not.toHaveBeenCalled();
  });
});
