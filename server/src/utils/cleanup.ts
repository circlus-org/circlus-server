import { query } from '../db';
import { attachmentRepository, callHistoryRepository, callQualityDailyRepository, callSessionRepository, circleSitePublicationAssetRepository, familyConfigRepository, messageRepository, systemEventRepository, temporaryDeviceRepository } from '../db/repositories';
import { circleInspectorRepository } from '../db/repositories/circleInspectorRepository';
import { bumpChatEpochsForTemporaryDevice } from '../services/chatEpochRotation';
import { createHash } from 'crypto';
import { attachmentStorageService } from '../services/attachmentStorageService';
import { publicSiteAssetStorageService } from '../services/publicSiteAssetStorageService';
import { configService } from '../services/configService';
import { getCircleFreezeState } from '../middleware/circleMigrationFreeze';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import { circleMigrationAbortService } from '../services/circleMigrationAbortService';
import { runDeviceInactivityLifecycle } from '../services/deviceInactivityLifecycleService';
import { getCleanupRuntimeConfig } from '../config/serverRuntimeConfig';
import { serverLogger } from './logger';
import {
  resolveCallLinkPresentation,
  type CallLinkPresentation
} from '../services/callSessionPresentation';

const logger = serverLogger.child({ subsystem: 'cleanup' });

/**
 * Clean up completed call sessions
 *
 * call_sessions is used only to coordinate active calls. Completed history is
 * retained by the separate server-backed call history sync.
 */
export async function cleanupCompletedCalls(familyId: string): Promise<number> {
  try {
    // Delete completed calls older than one hour.
    const result = await query(
      `DELETE FROM call_sessions
       WHERE state IN ('ended', 'failed', 'expired')
       AND family_id = $1
       AND (
         ended_at < NOW() - INTERVAL '1 hour'
         OR created_at < NOW() - INTERVAL '1 hour'
       )`,
      [familyId]
    );

    const deletedCount = result.rowCount || 0;

    if (deletedCount > 0) {
      logger.info('cleanup_completed_call_sessions_deleted', { familyId, deletedCount });
    }

    return deletedCount;
  } catch (error) {
    logger.error('cleanup_completed_call_sessions_failed', { familyId, error });
    return 0;
  }
}

/**
 * Clean up expired call sessions (timeout before completion)
 */
export async function cleanupExpiredCalls(familyId: string): Promise<number> {
  try {
    const expired = await callSessionRepository.cleanupExpired(familyId);

    // Create system events for missed calls.
    // NOTE: We only generate for sessions that expired before being accepted.
    // The expiration mark is done by the DB trigger + scheduler, so this is best-effort.
    const familyConfig = await configService.requireFamilyConfig(familyId);
    const circleId = familyConfig.circle_id;

    for (const session of expired) {
      let callLinkPresentation: CallLinkPresentation = { isTemporaryLinkCall: false };
      try {
        const fullSession = await callSessionRepository.findByCallSessionId(familyId, session.callSessionId);
        callLinkPresentation = resolveCallLinkPresentation(fullSession);
      } catch {
        callLinkPresentation = { isTemporaryLinkCall: false };
      }

      // We treat "expired" as "callee never answered".
      // Recipients are all participants except the initiator.
      const recipients = (session.participants || []).filter((p) => p !== session.initiator);
      for (const recipientIdentityId of recipients) {
        // Deterministic ID prevents duplicate events if cleanup runs multiple times.
        const stable = createHash('sha256')
          .update(`${familyId}:${session.callSessionId}:${recipientIdentityId}:call:missed`)
          .digest('hex')
          .slice(0, 24);
        const eventId = `sev_missed_${stable}`;
        await systemEventRepository.insertEvent({
          eventId,
          familyId,
          recipientIdentityId,
          circleId,
          type: 'call:missed',
          payload: {
            callSessionId: session.callSessionId,
            remoteIdentityId: session.initiator,
            direction: 'incoming',
            reason: 'timeout',
            isTemporaryLinkCall: callLinkPresentation.isTemporaryLinkCall,
            callLinkTitle: callLinkPresentation.callLinkTitle,
            callCreatedAt: session.createdAt?.getTime?.() ? session.createdAt.getTime() : undefined
          },
          // Use insertion time for sync cursor safety.
          createdAt: Date.now()
        });
        await callHistoryRepository.markMissed({
          familyId,
          callSessionId: session.callSessionId,
          reason: 'timeout'
        });
      }
    }

    if (expired.length > 0) {
      logger.info('cleanup_call_sessions_expired', { familyId, expiredCount: expired.length });
    }

    return expired.length;
  } catch (error) {
    logger.error('cleanup_call_session_expiration_failed', { familyId, error });
    return 0;
  }
}

/**
 * Run all cleanup tasks
 */
async function getFamilyIds(): Promise<string[]> {
  const configs = await familyConfigRepository.findAll();
  return configs.map((config) => config.family_id);
}

export async function runCleanupTasks(): Promise<void> {
  logger.info('cleanup_run_started');

  await cleanupCircleMigrations();
  const familyIds = await getFamilyIds();

  if (familyIds.length === 0) {
    logger.info('cleanup_run_skipped', { reason: 'no_family_configurations' });
    return;
  }

  let hasFrozenCircle = false;
  for (const familyId of familyIds) {
    if (await getCircleFreezeState(familyId)) {
      hasFrozenCircle = true;
      continue;
    }
    await cleanupExpiredCalls(familyId);
    await cleanupCompletedCalls(familyId);
  }

  if (!hasFrozenCircle) {
    await cleanupExpiredMessages();
    await cleanupExpiredChatEpochKeyEnvelopes();
    await cleanupAttachments();
    await cleanupPublicSiteAssets();
    await cleanupExpiredTemporaryDevices();
    await runDeviceInactivityLifecycle();
    await cleanupInactiveInspectorAccess();

    // Global table cleanup (not per-family).
    await cleanupExpiredSystemEvents();
    // Preserve identifier-free daily quality data before detailed call rows
    // reach their short retention cutoff.
    await refreshCallQualityAggregates();
    await cleanupExpiredCallHistory();
  } else {
    logger.info('cleanup_global_tasks_paused', { reason: 'circle_migration_freeze' });
  }

  logger.info('cleanup_run_completed', { familyCount: familyIds.length });
}

async function cleanupCircleMigrations(): Promise<void> {
  try {
    const expiredSlots = await circleMigrationRepository.expireUnusedSlots(new Date());
    if (expiredSlots > 0) {
      logger.info('cleanup_circle_migration_slots_expired', { expiredSlots });
    }
    const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await circleMigrationRepository.findStaleAbortableSourceMigrations(staleBefore);
    for (const migration of stale) {
      try {
        await circleMigrationAbortService.abort({
          familyId: migration.family_id,
          ownerIdentityId: migration.started_by_identity_id,
          migrationId: migration.migration_id,
          reason: 'Automatically aborted after 24 hours without migration progress'
        });
        logger.info('cleanup_circle_migration_auto_aborted', {
          migrationId: migration.migration_id
        });
      } catch (error) {
        logger.error('cleanup_circle_migration_auto_abort_failed', {
          migrationId: migration.migration_id,
          error
        });
      }
    }
  } catch (error) {
    logger.error('cleanup_circle_migrations_failed', { error });
  }
}

async function cleanupInactiveInspectorAccess(): Promise<void> {
  try {
    const deleted = await circleInspectorRepository.cleanupInactiveAccess(Date.now());
    if (deleted.sessions > 0 || deleted.requests > 0) {
      logger.info('cleanup_inspector_access_deleted', {
        sessionCount: deleted.sessions,
        requestCount: deleted.requests
      });
    }
  } catch (error) {
    logger.error('cleanup_inspector_access_failed', { error });
  }
}

/**
 * Mark expired invites that were never accepted while retaining them for the
 * owner's invitation journal and per-creator lifetime summary.
 *
 * Rules:
 * - expire invites with expires_at < NOW(), used_count = 0, accepted_at IS NULL;
 * - do not change legacy quota counters; invitation creation is permission-based.
 */
export async function cleanupExpiredUnacceptedInvites(): Promise<number> {
  try {
    if (await circleMigrationRepository.hasAnyFrozenSourceMigrations()) {
      logger.info('cleanup_expired_invites_paused', { reason: 'circle_migration_freeze' });
      return 0;
    }
    const result = await query<{ expired_count: string }>(
      `WITH expired AS (
         UPDATE invites i
            SET status = 'expired'
          WHERE i.expires_at < NOW()
            AND i.used_count = 0
            AND i.accepted_at IS NULL
            AND i.status = 'active'
        RETURNING i.invite_id
       )
       SELECT COUNT(*)::TEXT AS expired_count FROM expired`
    );

    const row = result.rows[0];
    const expiredCount = Number.parseInt(row?.expired_count || '0', 10) || 0;

    if (expiredCount > 0) {
      logger.info('cleanup_expired_invites_marked', { expiredCount });
    }

    return expiredCount;
  } catch (error) {
    logger.error('cleanup_expired_invites_failed', { error });
    return 0;
  }
}

async function cleanupExpiredMessages(): Promise<void> {
  const defaultTtlHours = getCleanupRuntimeConfig().messageTtlHours;
  try {
    const deletedCount = await messageRepository.cleanupExpiredMessages(defaultTtlHours, Date.now());
    if (deletedCount > 0) {
      logger.info('cleanup_expired_messages_deleted', { deletedCount });
    }
  } catch (error) {
    logger.error('cleanup_expired_messages_failed', { error });
  }
}

async function cleanupExpiredChatEpochKeyEnvelopes(): Promise<void> {
  try {
    const deletedCount = await messageRepository.cleanupExpiredChatEpochKeyEnvelopes(Date.now());
    if (deletedCount > 0) {
      logger.info('cleanup_expired_chat_epoch_envelopes_deleted', { deletedCount });
    }
  } catch (error) {
    logger.error('cleanup_expired_chat_epoch_envelopes_failed', { error });
  }
}

async function cleanupAttachments(): Promise<void> {
  try {
    const expiredReservations = await attachmentRepository.expireStaleReservations(new Date());
    for (const reservation of expiredReservations) {
      await attachmentStorageService.deleteTempUpload(reservation.reservation_id);
      await attachmentRepository.finalizeDeletion({
        familyId: reservation.family_id,
        blobId: reservation.blob_id,
        finalStatus: 'deleted'
      });
    }

    const blobs = await attachmentRepository.listExpiredOrPendingDeleteBlobs(new Date());
    for (const blob of blobs) {
      const finalStatus = blob.status === 'pending_delete' ? 'deleted' : 'expired';
      await attachmentStorageService.deleteBlob(blob.storage_key);
      await attachmentRepository.finalizeDeletion({
        familyId: blob.family_id,
        blobId: blob.blob_id,
        finalStatus
      });
    }
  } catch (error) {
    logger.error('cleanup_attachments_failed', { error });
  }
}

async function cleanupPublicSiteAssets(): Promise<void> {
  try {
    const readyTtlHours = getCleanupRuntimeConfig().publicSiteAssetReadyTtlHours;
    const assets = await circleSitePublicationAssetRepository.claimExpiredUnpublishedAssets({
      now: new Date(),
      readyCutoff: new Date(Date.now() - readyTtlHours * 60 * 60 * 1000),
    });
    for (const asset of assets) {
      await publicSiteAssetStorageService.deleteAsset(asset.storage_key);
      await circleSitePublicationAssetRepository.deleteClaimedAsset(asset.asset_id);
    }
    if (assets.length > 0) {
      logger.info('cleanup_public_site_assets_deleted', { deletedCount: assets.length });
    }
  } catch (error) {
    logger.error('cleanup_public_site_assets_failed', { error });
  }
}

async function cleanupExpiredSystemEvents(): Promise<void> {
  const ttlHours = getCleanupRuntimeConfig().systemEventTtlHours;
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
  try {
    const deletedCount = await systemEventRepository.cleanupExpiredEvents(cutoff);
    if (deletedCount > 0) {
      logger.info('cleanup_system_events_deleted', { deletedCount });
    }
  } catch (error) {
    logger.error('cleanup_system_events_failed', { error });
  }
}

async function cleanupExpiredCallHistory(): Promise<void> {
  const ttlHours = getCleanupRuntimeConfig().callHistoryTtlHours;
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
  try {
    const deletedCount = await callHistoryRepository.cleanupExpired(cutoff);
    if (deletedCount > 0) {
      logger.info('cleanup_call_history_deleted', { deletedCount });
    }
  } catch (error) {
    logger.error('cleanup_call_history_failed', { error });
  }
}

async function refreshCallQualityAggregates(): Promise<void> {
  try {
    await callQualityDailyRepository.refreshRecent();
  } catch (error) {
    logger.error('refresh_call_quality_daily_failed', { error });
  }
}

export async function finalizeStaleConnectedCalls(): Promise<void> {
  const timeoutMs = getCleanupRuntimeConfig().callHistoryHeartbeatTimeoutMs;
  const staleBefore = Date.now() - timeoutMs;

  try {
    const familyIds = await getFamilyIds();
    for (const familyId of familyIds) {
      if (await getCircleFreezeState(familyId)) continue;
      const finalizedCount = await callHistoryRepository.finalizeStaleConnectedCalls({
        familyId,
        staleBefore,
        fallbackReason: 'heartbeat_timeout'
      });
      if (finalizedCount > 0) {
        logger.info('cleanup_stale_connected_calls_finalized', { familyId, finalizedCount });
      }
    }
  } catch (error) {
    logger.error('cleanup_stale_connected_calls_failed', { error });
  }
}

async function cleanupExpiredTemporaryDevices(): Promise<void> {
  try {
    const expired = await temporaryDeviceRepository.findExpiredActiveTemporaryDevices();
    for (const device of expired) {
      await bumpChatEpochsForTemporaryDevice({
        familyId: device.family_id,
        temporaryDeviceId: device.device_id,
        reason: 'device_expired'
      });
    }
    if (expired.length > 0) {
      logger.info('cleanup_temporary_devices_expired', { expiredCount: expired.length });
    }
  } catch (error) {
    logger.error('cleanup_temporary_devices_failed', { error });
  }
}

/**
 * Start periodic cleanup (every 10 minutes)
 */
export type StopScheduler = () => Promise<void>;

function startPeriodicScheduler(params: {
  intervalMs: number;
  task: () => Promise<void>;
  initialErrorMessage: string;
  scheduledErrorMessage: string;
}): StopScheduler {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const run = (errorMessage: string) => {
    if (stopped || inFlight) return;
    inFlight = params.task()
      .catch((error) => logger.error('cleanup_scheduled_task_failed', { operation: errorMessage, error }))
      .finally(() => { inFlight = null; });
  };
  run(params.initialErrorMessage);
  const interval = setInterval(() => run(params.scheduledErrorMessage), params.intervalMs);
  interval.unref?.();
  return async () => {
    stopped = true;
    clearInterval(interval);
    await inFlight;
  };
}

export function startCleanupScheduler(): StopScheduler {
  const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

  logger.info('cleanup_scheduler_started', { intervalMs: CLEANUP_INTERVAL });

  return startPeriodicScheduler({
    intervalMs: CLEANUP_INTERVAL,
    task: runCleanupTasks,
    initialErrorMessage: '[Cleanup] Initial cleanup failed:',
    scheduledErrorMessage: '[Cleanup] Scheduled cleanup failed:'
  });
}

export function startCallHistoryHeartbeatCleanupScheduler(): StopScheduler {
  const intervalMs = getCleanupRuntimeConfig().callHistoryHeartbeatSweepMs;

  logger.info('cleanup_call_heartbeat_scheduler_started', { intervalMs });

  return startPeriodicScheduler({
    intervalMs,
    task: async () => { await finalizeStaleConnectedCalls(); },
    initialErrorMessage: '[Cleanup] Initial stale connected call sweep failed:',
    scheduledErrorMessage: '[Cleanup] Scheduled stale connected call sweep failed:'
  });
}

/**
 * Start daily expired-invite cleanup scheduler.
 * Interval is configurable via INVITE_CLEANUP_INTERVAL_HOURS (default: 24).
 */
export function startExpiredInviteCleanupScheduler(): StopScheduler {
  const intervalHours = getCleanupRuntimeConfig().inviteCleanupIntervalHours;
  const intervalMs = intervalHours * 60 * 60 * 1000;

  logger.info('cleanup_expired_invites_scheduler_started', { intervalMs });

  return startPeriodicScheduler({
    intervalMs,
    task: async () => { await cleanupExpiredUnacceptedInvites(); },
    initialErrorMessage: '[InviteCleanup] Initial run failed:',
    scheduledErrorMessage: '[InviteCleanup] Scheduled run failed:'
  });
}
