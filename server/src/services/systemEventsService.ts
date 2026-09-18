import type { ErrorCode, WSSystemSyncResultData } from '@shared/types';
import { systemEventRepository } from '../db/repositories';
import { MAX_SYSTEM_SYNC_BATCH } from '../db/repositories/systemEventRepository';
import type { AuthenticatedActor } from './authenticatedActor';

export class SystemEventsServiceError extends Error {
  status: number;
  code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'SystemEventsServiceError';
    this.status = status;
    this.code = code;
  }
}

export async function listSystemEventsForActor(
  actor: AuthenticatedActor,
  payload: { since?: number; limit?: number }
): Promise<WSSystemSyncResultData> {
  const syncState = await systemEventRepository.getSyncState(actor.familyId, actor.deviceId);
  const since = typeof payload.since === 'number' && Number.isFinite(payload.since)
    ? payload.since
    : syncState.last_system_sync_at;
  const requestedLimit = typeof payload.limit === 'number' && Number.isFinite(payload.limit)
    ? Math.max(1, Math.min(Math.floor(payload.limit), MAX_SYSTEM_SYNC_BATCH))
    : MAX_SYSTEM_SYNC_BATCH;
  const events = await systemEventRepository.fetchEventsForSync({
    familyId: actor.familyId,
    recipientIdentityId: actor.identityId,
    since,
    limit: requestedLimit + 1
  });
  const hasMore = events.length > requestedLimit;
  const page = hasMore ? events.slice(0, requestedLimit) : events;
  const syncedThrough = page.length > 0
    ? page[page.length - 1].serverTimestamp
    : since;

  return { events: page, syncedThrough, hasMore };
}

export async function ackSystemEventsForActor(
  actor: AuthenticatedActor,
  payload: { syncedThrough?: number }
): Promise<void> {
  const syncedThrough = Number(payload.syncedThrough || 0);
  if (!Number.isFinite(syncedThrough) || syncedThrough < 0) {
    throw new SystemEventsServiceError(400, 'INVALID_STATE' as ErrorCode, 'Invalid system sync ack payload');
  }

  const syncState = await systemEventRepository.getSyncState(actor.familyId, actor.deviceId);
  await systemEventRepository.updateSyncState(
    actor.familyId,
    actor.deviceId,
    Math.max(syncState.last_system_sync_at, syncedThrough)
  );
}
