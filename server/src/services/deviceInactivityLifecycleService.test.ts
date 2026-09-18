jest.mock('../db/repositories', () => ({
  deviceLifecyclePolicyRepository: {
    get: jest.fn(),
    listAutoRevokeCandidates: jest.fn(),
    warnCandidate: jest.fn()
  },
  systemEventRepository: {
    createEventId: jest.fn(() => 'event-1')
  }
}));
jest.mock('./deviceRevocationService', () => ({
  commitDeviceRevocation: jest.fn()
}));

import { deviceLifecyclePolicyRepository } from '../db/repositories';
import { commitDeviceRevocation } from './deviceRevocationService';
import { runDeviceInactivityLifecycle } from './deviceInactivityLifecycleService';

const policy = {
  reviewAfterDays: 60,
  autoRevokeEnabled: true,
  autoRevokeAfterDays: 180,
  warningDays: 7,
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const now = new Date('2026-08-23T00:00:00.000Z');
const candidate = {
  familyId: 'family-1',
  circleId: 'https://circle.example',
  deviceId: 'device-old',
  identityId: 'identity-1',
  label: 'Old phone',
  lastActivityAt: new Date('2025-01-01T00:00:00.000Z'),
  warningSentAt: null as Date | null
};

describe('device inactivity lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (deviceLifecyclePolicyRepository.get as jest.Mock).mockResolvedValue(policy);
    (deviceLifecyclePolicyRepository.listAutoRevokeCandidates as jest.Mock).mockResolvedValue([]);
    (deviceLifecyclePolicyRepository.warnCandidate as jest.Mock).mockResolvedValue(true);
    (commitDeviceRevocation as jest.Mock).mockResolvedValue({ rekey: { status: 'pending' } });
  });

  test('does nothing while automatic revocation is disabled', async () => {
    (deviceLifecyclePolicyRepository.get as jest.Mock).mockResolvedValue({ ...policy, autoRevokeEnabled: false });

    await expect(runDeviceInactivityLifecycle(now)).resolves.toEqual({ warned: 0, revoked: 0 });
    expect(deviceLifecyclePolicyRepository.listAutoRevokeCandidates).not.toHaveBeenCalled();
  });

  test('warns first and does not revoke in the same scheduler pass', async () => {
    (deviceLifecyclePolicyRepository.listAutoRevokeCandidates as jest.Mock).mockResolvedValue([candidate]);

    await expect(runDeviceInactivityLifecycle(now)).resolves.toEqual({ warned: 1, revoked: 0 });
    expect(deviceLifecyclePolicyRepository.warnCandidate).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family-1',
      deviceId: 'device-old',
      identityId: 'identity-1'
    }));
    expect(commitDeviceRevocation).not.toHaveBeenCalled();
  });

  test('waits for the warning grace period', async () => {
    (deviceLifecyclePolicyRepository.listAutoRevokeCandidates as jest.Mock).mockResolvedValue([{
      ...candidate,
      warningSentAt: new Date(now.getTime() - 6 * 86400000)
    }]);

    await expect(runDeviceInactivityLifecycle(now)).resolves.toEqual({ warned: 0, revoked: 0 });
    expect(commitDeviceRevocation).not.toHaveBeenCalled();
  });

  test('uses guarded revocation after the warning grace period', async () => {
    (deviceLifecyclePolicyRepository.listAutoRevokeCandidates as jest.Mock).mockResolvedValue([{
      ...candidate,
      warningSentAt: new Date(now.getTime() - 8 * 86400000)
    }]);

    await expect(runDeviceInactivityLifecycle(now)).resolves.toEqual({ warned: 0, revoked: 1 });
    expect(commitDeviceRevocation).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family-1',
      deviceId: 'device-old',
      identityId: 'identity-1',
      inactivityGuard: expect.objectContaining({
        inactiveBefore: expect.any(Date),
        warningBefore: expect.any(Date)
      })
    }));
  });
});
