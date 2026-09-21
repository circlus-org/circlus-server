import type { DeviceId, IdentityId } from '@shared/types';
import { deviceLifecyclePolicyRepository, systemEventRepository } from '../db/repositories';
import { serverLogger } from '../utils/logger';
import { commitDeviceRevocation } from './deviceRevocationService';

const logger = serverLogger.child({ subsystem: 'device-inactivity-lifecycle' });
const DAY_MS = 86400000;

export async function runDeviceInactivityLifecycle(now = new Date()): Promise<{ warned: number; revoked: number }> {
  const policy = await deviceLifecyclePolicyRepository.get();
  if (!policy.autoRevokeEnabled) return { warned: 0, revoked: 0 };

  const inactiveBefore = new Date(now.getTime() - policy.autoRevokeAfterDays * DAY_MS);
  const warningBefore = new Date(now.getTime() - policy.warningDays * DAY_MS);
  const candidates = await deviceLifecyclePolicyRepository.listAutoRevokeCandidates(inactiveBefore);
  let warned = 0;
  let revoked = 0;

  for (const candidate of candidates) {
    try {
      if (!candidate.warningSentAt) {
        const payload = {
          deviceId: candidate.deviceId,
          inactiveDays: Math.max(0, Math.floor((now.getTime() - candidate.lastActivityAt.getTime()) / DAY_MS)),
          reviewAfterDays: policy.reviewAfterDays,
          autoRevokeAfterDays: policy.autoRevokeAfterDays
        };
        if (await deviceLifecyclePolicyRepository.warnCandidate({
          eventId: systemEventRepository.createEventId(),
          familyId: candidate.familyId,
          circleId: candidate.circleId,
          deviceId: candidate.deviceId,
          identityId: candidate.identityId,
          inactiveBefore,
          createdAt: now.getTime(),
          payload
        })) warned += 1;
        continue;
      }
      if (candidate.warningSentAt > warningBefore) continue;
      const outcome = await commitDeviceRevocation({
        familyId: candidate.familyId,
        deviceId: candidate.deviceId as DeviceId,
        identityId: candidate.identityId as IdentityId,
        inactivityGuard: { inactiveBefore, warningBefore }
      });
      if (outcome) revoked += 1;
    } catch (error) {
      logger.error('device_inactivity_candidate_failed', {
        familyId: candidate.familyId,
        deviceId: candidate.deviceId,
        error
      });
    }
  }

  if (warned > 0 || revoked > 0) {
    logger.info('device_inactivity_lifecycle_completed', { warned, revoked });
  }
  return { warned, revoked };
}
