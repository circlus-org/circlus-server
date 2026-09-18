const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));
jest.mock('../db/repositories', () => ({
  deviceRepository: {
    findByDeviceId: jest.fn(),
    revoke: jest.fn(),
    revokeForInactivity: jest.fn()
  },
  identityRepository: { findByIdentityId: jest.fn() },
  trustedDeviceRekeyRepository: { enqueue: jest.fn() }
}));
jest.mock('../utils/crypto', () => ({ verifySignedRequest: jest.fn() }));
jest.mock('../ws/wsGateway', () => ({ notifyDeviceRevoked: jest.fn() }));
jest.mock('./trustedDeviceRekeyService', () => ({
  requestTrustedDeviceRekeyProcessing: jest.fn()
}));

import { transaction } from '../db';
import {
  deviceRepository,
  identityRepository,
  trustedDeviceRekeyRepository
} from '../db/repositories';
import { verifySignedRequest } from '../utils/crypto';
import { notifyDeviceRevoked } from '../ws/wsGateway';
import { requestTrustedDeviceRekeyProcessing } from './trustedDeviceRekeyService';
import {
  commitDeviceRevocation,
  IdentityDeviceRevocationError,
  revokeIdentityDevice
} from './deviceRevocationService';

const baseParams = {
  familyId: 'family-1',
  currentDeviceId: 'current-device',
  currentIdentityId: 'identity-1',
  deviceId: 'target-device',
  deleteLocalCircleData: false
};

describe('identity device revocation service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue({
      identity_id: 'identity-1',
      status: 'active'
    });
    (deviceRepository.revoke as jest.Mock).mockResolvedValue(true);
    (deviceRepository.revokeForInactivity as jest.Mock).mockResolvedValue(true);
    (trustedDeviceRekeyRepository.enqueue as jest.Mock).mockResolvedValue({
      jobId: 'rekey-1',
      status: 'pending',
      groupTargets: 2,
      directTargets: 1
    });
  });

  test('commits revocation and rekey obligation before publishing side effects', async () => {
    const result = await revokeIdentityDevice(baseParams);

    expect(deviceRepository.revoke).toHaveBeenCalledWith('family-1', 'target-device', transactionClient);
    expect(trustedDeviceRekeyRepository.enqueue).toHaveBeenCalledWith(
      transactionClient,
      expect.objectContaining({ identityId: 'identity-1', reason: 'device_revoked' })
    );
    expect(notifyDeviceRevoked).toHaveBeenCalledWith('target-device', 'identity-1');
    expect(requestTrustedDeviceRekeyProcessing).toHaveBeenCalledTimes(1);
    expect(result.rekey.jobId).toBe('rekey-1');
  });

  test('rejects another identity device before opening a transaction', async () => {
    (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue({
      identity_id: 'identity-2',
      status: 'active'
    });

    await expect(revokeIdentityDevice(baseParams))
      .rejects.toMatchObject<Partial<IdentityDeviceRevocationError>>({
        status: 403,
        code: 'FORBIDDEN'
      });
    expect(transaction).not.toHaveBeenCalled();
  });

  test('rechecks inactivity and last-device protection inside the revocation transaction', async () => {
    const inactiveBefore = new Date('2026-01-01T00:00:00.000Z');
    const warningBefore = new Date('2026-01-08T00:00:00.000Z');
    await commitDeviceRevocation({
      familyId: 'family-1',
      deviceId: 'target-device',
      identityId: 'identity-1',
      inactivityGuard: { inactiveBefore, warningBefore }
    });

    expect(deviceRepository.revokeForInactivity).toHaveBeenCalledWith(
      'family-1',
      'target-device',
      inactiveBefore,
      warningBefore,
      transactionClient
    );
    expect(deviceRepository.revoke).not.toHaveBeenCalled();
  });

  test('requires identity authorization before requesting local deletion', async () => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      public_key_algorithm: 'ed25519',
      public_key_value: 'identity-public-key'
    });
    (verifySignedRequest as jest.Mock).mockReturnValue(false);

    await expect(revokeIdentityDevice({
      ...baseParams,
      deleteLocalCircleData: true,
      now: 1_000_000,
      localDeletionAuthorization: {
        type: 'identity:device-local-circle-data-deletion-after-revoke',
        timestamp: 1_000_000,
        nonce: 'nonce-1',
        signerId: 'identity-1',
        payload: {
          version: 1,
          purpose: 'device-local-circle-data-deletion-after-revoke-v1',
          identityId: 'identity-1',
          targetDeviceId: 'target-device'
        },
        signature: 'signature'
      }
    })).rejects.toMatchObject<Partial<IdentityDeviceRevocationError>>({
      status: 400,
      code: 'INVALID_SIGNATURE'
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  test('does not publish side effects when a concurrent request already revoked the device', async () => {
    (deviceRepository.revoke as jest.Mock).mockResolvedValue(false);

    await expect(revokeIdentityDevice(baseParams))
      .rejects.toMatchObject<Partial<IdentityDeviceRevocationError>>({
        status: 400,
        code: 'INVALID_STATE'
      });
    expect(trustedDeviceRekeyRepository.enqueue).not.toHaveBeenCalled();
    expect(notifyDeviceRevoked).not.toHaveBeenCalled();
    expect(requestTrustedDeviceRekeyProcessing).not.toHaveBeenCalled();
  });
});

test('a guest self-disconnect revokes only the selected device and rotates its identity keys', async () => {
  jest.clearAllMocks();
  (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue({ identity_id: baseParams.currentIdentityId, status: 'active' });
  (deviceRepository.revoke as jest.Mock).mockResolvedValue({ device_id: baseParams.currentDeviceId });
  (trustedDeviceRekeyRepository.enqueue as jest.Mock).mockResolvedValue({ status: 'pending', jobId: 'rekey-guest' });
  await revokeIdentityDevice({ ...baseParams, deviceId: baseParams.currentDeviceId, allowCurrentDevice: true });
  expect(deviceRepository.revoke).toHaveBeenCalledWith(baseParams.familyId, baseParams.currentDeviceId, transactionClient);
  expect(notifyDeviceRevoked).toHaveBeenCalledWith(baseParams.currentDeviceId, baseParams.currentIdentityId);
});

test('self-disconnect remains forbidden unless the route explicitly allows it', async () => {
  jest.clearAllMocks();
  await expect(revokeIdentityDevice({ ...baseParams, deviceId: baseParams.currentDeviceId }))
    .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  expect(deviceRepository.revoke).not.toHaveBeenCalled();
});
