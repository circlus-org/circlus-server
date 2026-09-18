const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: unknown) => unknown) => work(transactionClient))
}));

jest.mock('../db/repositories/deviceEnrollmentRepository', () => ({
  deviceEnrollmentRepository: {
    markApproved: jest.fn()
  }
}));

jest.mock('../db/repositories', () => ({
  temporaryDeviceRepository: {
    createOrRefresh: jest.fn(),
    setCallCapability: jest.fn(),
    storeApprovalAttestation: jest.fn(),
    storeChatAccess: jest.fn(),
    upsertGroupChatKeyEnvelope: jest.fn(),
    upsertDirectChatKeyEnvelope: jest.fn()
  }
}));

import { deviceEnrollmentRepository } from '../db/repositories/deviceEnrollmentRepository';
import { temporaryDeviceRepository } from '../db/repositories';
import {
  approveDeviceEnrollment,
  DeviceEnrollmentApprovalConflict
} from './deviceEnrollmentApprovalService';

const baseParams = {
  familyId: 'family-1',
  enrollmentId: 'enrollment-1',
  approvingIdentityId: 'identity-1',
  approvingDeviceId: 'trusted-device-1',
  accessMode: 'temporary' as const,
  temporaryDeviceId: 'temporary-device-1',
  temporaryDevicePublicKey: { algorithm: 'ed25519', value: 'public-key' },
  temporaryDeviceEncryptionPublicKey: { algorithm: 'x25519', value: 'encryption-key' },
  encryptedTemporaryMembership: 'gcm1:membership',
  cipher: 'aes-256-gcm',
  accessExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
  payloadExpiresAt: new Date('2029-01-01T00:00:00.000Z'),
  canCall: true,
  chatAccess: [
    {
      chatId: 'group-1',
      chatType: 'group' as const,
      epoch: 3,
      envelopeCiphertext: 'gcm1:group-envelope',
      publisherIdentityId: 'identity-1',
      publisherEncPublicKeyAlgo: 'x25519',
      publisherEncPublicKeyValue: 'publisher-key'
    },
    {
      chatId: 'identity-1::identity-2',
      chatType: 'direct' as const,
      epoch: 4,
      envelopeCiphertext: 'gcm1:direct-envelope',
      publisherIdentityId: 'identity-1',
      publisherEncPublicKeyAlgo: 'x25519',
      publisherEncPublicKeyValue: 'publisher-key'
    }
  ],
  approvalAttestation: {
    payload: '{}',
    signature: 'signature',
    approvingDevicePublicKey: 'trusted-public-key'
  }
};

describe('device enrollment approval service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (deviceEnrollmentRepository.markApproved as jest.Mock).mockResolvedValue({ enrollment_id: 'enrollment-1' });
  });

  test('persists temporary access grants and enrollment approval in one transaction', async () => {
    await expect(approveDeviceEnrollment(baseParams)).resolves.toEqual({ enrollment_id: 'enrollment-1' });

    expect(temporaryDeviceRepository.createOrRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'temporary-device-1', identityId: 'identity-1' }),
      transactionClient
    );
    expect(temporaryDeviceRepository.storeChatAccess).toHaveBeenCalledWith(
      'family-1',
      'temporary-device-1',
      [
        { chatId: 'group-1', chatType: 'group' },
        { chatId: 'identity-1::identity-2', chatType: 'direct' }
      ],
      transactionClient
    );
    expect(temporaryDeviceRepository.upsertGroupChatKeyEnvelope).toHaveBeenCalledTimes(1);
    expect(temporaryDeviceRepository.upsertDirectChatKeyEnvelope).toHaveBeenCalledTimes(1);
    expect(deviceEnrollmentRepository.markApproved).toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentId: 'enrollment-1', accessMode: 'temporary' }),
      transactionClient
    );
  });

  test('does not create a temporary-device record for full-circle approval', async () => {
    await approveDeviceEnrollment({ ...baseParams, accessMode: 'full_circle' });

    expect(temporaryDeviceRepository.createOrRefresh).not.toHaveBeenCalled();
    expect(deviceEnrollmentRepository.markApproved).toHaveBeenCalledWith(
      expect.objectContaining({ accessMode: 'full_circle' }),
      transactionClient
    );
  });

  test('reports a concurrent enrollment transition as a domain conflict', async () => {
    (deviceEnrollmentRepository.markApproved as jest.Mock).mockResolvedValue(null);

    await expect(approveDeviceEnrollment(baseParams)).rejects.toBeInstanceOf(DeviceEnrollmentApprovalConflict);
  });
});
