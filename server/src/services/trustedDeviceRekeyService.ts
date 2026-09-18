import { trustedDeviceRekeyRepository } from '../db/repositories';
import { sendGroupChatWsEvent } from '../ws/wsGateway';
import { serverLogger } from '../utils/logger';

const TARGET_BATCH_SIZE = 25;
const MAX_BATCHES_PER_JOB_TURN = 10;
const logger = serverLogger.child({ subsystem: 'trusted_device_rekey' });
let requestDrain: (() => void) | null = null;

export async function processTrustedDeviceRekeyOnce(): Promise<boolean> {
  const job = await trustedDeviceRekeyRepository.claimNext();
  if (!job) return false;

  try {
    let processedTargets = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_JOB_TURN; batch += 1) {
      const result = await trustedDeviceRekeyRepository.rotateNextBatch(job.job_id, TARGET_BATCH_SIZE);
      processedTargets += result.processedTargets;

      for (const notification of result.groupNotifications) {
        try {
          sendGroupChatWsEvent({
            familyId: job.family_id,
            participantIdentityIds: notification.participantIdentityIds,
            eventType: 'group:chat-updated',
            payload: {
              chatId: notification.chatId,
              event: job.reason,
              identityId: job.identity_id,
              keyEpoch: notification.keyEpoch,
              rekeyRequired: true,
              rekeyRequiredAt: notification.rekeyRequiredAt,
            },
          });
        } catch (error) {
          // The epoch is already committed. Clients also discover it through
          // normal sync, so a transient live-notification failure must not
          // repeat the rotation.
          logger.warn('trusted_device_rekey_notification_failed', {
            jobId: job.job_id,
            chatId: notification.chatId,
            error,
          });
        }
      }

      if (result.completed) {
        logger.info('trusted_device_rekey_job_completed', {
          jobId: job.job_id,
          reason: job.reason,
          targets: job.target_count,
          processedTargets,
          attempts: job.attempts,
        });
        return true;
      }
    }

    // Yield after a bounded amount of work. A later scheduler turn can claim
    // the same durable job and continue with the remaining targets.
    await trustedDeviceRekeyRepository.release(job.job_id);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const delaySeconds = Math.min(300, 2 ** Math.min(8, Math.max(1, Number(job.attempts || 1))));
    await trustedDeviceRekeyRepository.retry(job.job_id, message, delaySeconds);
    logger.error('trusted_device_rekey_job_failed', {
      jobId: job.job_id,
      reason: job.reason,
      attempts: job.attempts,
      error,
    });
    return true;
  }
}

export function requestTrustedDeviceRekeyProcessing(): void {
  requestDrain?.();
}

export function startTrustedDeviceRekeyScheduler(): () => Promise<void> {
  let running = false;
  let stopped = false;
  let nextCleanupAt = 0;
  const drain = async () => {
    if (running || stopped) return;
    running = true;
    try {
      if (Date.now() >= nextCleanupAt) {
        nextCleanupAt = Date.now() + 24 * 60 * 60 * 1000;
        const removed = await trustedDeviceRekeyRepository.cleanupCompleted(30);
        if (removed > 0) {
          logger.info('trusted_device_rekey_jobs_cleaned', { removed });
        }
      }
      for (let count = 0; count < 10 && await processTrustedDeviceRekeyOnce(); count += 1) {
        // Keep each scheduler turn bounded so request handling stays responsive.
      }
    } catch (error) {
      logger.error('trusted_device_rekey_scheduler_failed', { error });
    } finally {
      running = false;
    }
  };
  requestDrain = () => { void drain(); };
  const interval = setInterval(() => { void drain(); }, 2_000);
  interval.unref?.();
  void drain();
  return async () => {
    stopped = true;
    requestDrain = null;
    clearInterval(interval);
    while (running) await new Promise((resolve) => setTimeout(resolve, 10));
  };
}
