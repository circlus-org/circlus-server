jest.mock('../db/repositories', () => ({
  trustedDeviceRekeyRepository: {
    claimNext: jest.fn(),
    rotateNextBatch: jest.fn(),
    release: jest.fn(),
    retry: jest.fn(),
    cleanupCompleted: jest.fn(),
  },
}));

jest.mock('../ws/wsGateway', () => ({
  sendGroupChatWsEvent: jest.fn(),
}));

import { processTrustedDeviceRekeyOnce } from './trustedDeviceRekeyService';

const repositories = require('../db/repositories');
const ws = require('../ws/wsGateway');

const job = {
  job_id: 'device_rekey_1',
  family_id: 'family_1',
  identity_id: 'identity_1',
  device_id: 'device_1',
  reason: 'device_revoked',
  status: 'processing',
  attempts: 1,
  target_count: 2,
  completed_count: 0,
};

describe('trusted device rekey worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does nothing when there is no durable job ready', async () => {
    repositories.trustedDeviceRekeyRepository.claimNext.mockResolvedValue(null);

    await expect(processTrustedDeviceRekeyOnce()).resolves.toBe(false);
    expect(repositories.trustedDeviceRekeyRepository.rotateNextBatch).not.toHaveBeenCalled();
  });

  it('continues checkpointed batches and emits group updates after each commit', async () => {
    repositories.trustedDeviceRekeyRepository.claimNext.mockResolvedValue(job);
    repositories.trustedDeviceRekeyRepository.rotateNextBatch
      .mockResolvedValueOnce({
        completed: false,
        processedTargets: 1,
        groupNotifications: [{
          chatId: 'group_1',
          keyEpoch: 4,
          participantIdentityIds: ['identity_1', 'identity_2'],
          rekeyRequiredAt: 1_000,
        }],
      })
      .mockResolvedValueOnce({
        completed: true,
        processedTargets: 1,
        groupNotifications: [],
      });

    await expect(processTrustedDeviceRekeyOnce()).resolves.toBe(true);

    expect(repositories.trustedDeviceRekeyRepository.rotateNextBatch).toHaveBeenCalledTimes(2);
    expect(ws.sendGroupChatWsEvent).toHaveBeenCalledWith({
      familyId: 'family_1',
      participantIdentityIds: ['identity_1', 'identity_2'],
      eventType: 'group:chat-updated',
      payload: {
        chatId: 'group_1',
        event: 'device_revoked',
        identityId: 'identity_1',
        keyEpoch: 4,
        rekeyRequired: true,
        rekeyRequiredAt: 1_000,
      },
    });
    expect(repositories.trustedDeviceRekeyRepository.retry).not.toHaveBeenCalled();
  });

  it('retries the job when a transactional batch fails', async () => {
    repositories.trustedDeviceRekeyRepository.claimNext.mockResolvedValue(job);
    repositories.trustedDeviceRekeyRepository.rotateNextBatch.mockRejectedValue(new Error('database unavailable'));

    await expect(processTrustedDeviceRekeyOnce()).resolves.toBe(true);

    expect(repositories.trustedDeviceRekeyRepository.retry)
      .toHaveBeenCalledWith('device_rekey_1', 'database unavailable', 2);
  });

  it('does not repeat a committed rotation when a live notification fails', async () => {
    repositories.trustedDeviceRekeyRepository.claimNext.mockResolvedValue(job);
    repositories.trustedDeviceRekeyRepository.rotateNextBatch.mockResolvedValue({
      completed: true,
      processedTargets: 1,
      groupNotifications: [{
        chatId: 'group_1',
          keyEpoch: 4,
          participantIdentityIds: ['identity_1'],
          rekeyRequiredAt: 1_000,
      }],
    });
    ws.sendGroupChatWsEvent.mockImplementation(() => { throw new Error('socket failure'); });

    await expect(processTrustedDeviceRekeyOnce()).resolves.toBe(true);

    expect(repositories.trustedDeviceRekeyRepository.retry).not.toHaveBeenCalled();
    expect(repositories.trustedDeviceRekeyRepository.rotateNextBatch).toHaveBeenCalledTimes(1);
  });
});
