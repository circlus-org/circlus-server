import type { CallSessionId, ErrorCode, PublicKey, WSCallHistorySyncResultData } from '@shared/types';
import { callHistoryRepository } from '../db/repositories';
import { MAX_CALL_HISTORY_SYNC_BATCH } from '../db/repositories/callHistoryRepository';
import { query } from '../db';
import type { AuthenticatedActor } from './authenticatedActor';

export class CallHistoryServiceError extends Error {
  status: number;
  code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'CallHistoryServiceError';
    this.status = status;
    this.code = code;
  }
}

async function resolveCallPeerPublicKeysById(familyId: string, identityIds: string[]): Promise<Map<string, PublicKey>> {
  const result = new Map<string, PublicKey>();
  if (identityIds.length === 0) return result;

  // Call history is returned only to a participant in each call. Unlike names
  // in the circle directory, a peer key must remain available after the call.
  const rows = await query<{
    identity_id: string;
    public_key_algorithm: 'ed25519' | 'x25519';
    public_key_value: string;
  }>(
    `SELECT identity_id, public_key_algorithm, public_key_value
     FROM identities
     WHERE family_id = $1
       AND identity_id = ANY($2::text[])`,
    [familyId, identityIds]
  );

  for (const row of rows.rows) {
    if (!row.public_key_value) continue;
    result.set(row.identity_id, {
      algorithm: row.public_key_algorithm,
      value: row.public_key_value
    });
  }
  return result;
}

export async function listCallHistoryForActor(
  actor: AuthenticatedActor,
  payload: { since?: number; limit?: number }
): Promise<WSCallHistorySyncResultData> {
  const syncState = await callHistoryRepository.getSyncState(actor.familyId, actor.deviceId);
  const since = typeof payload.since === 'number' && Number.isFinite(payload.since)
    ? payload.since
    : syncState.last_call_history_sync_at;
  const requestedLimit = typeof payload.limit === 'number' && Number.isFinite(payload.limit)
    ? Math.max(1, Math.min(Math.floor(payload.limit), MAX_CALL_HISTORY_SYNC_BATCH))
    : MAX_CALL_HISTORY_SYNC_BATCH;
  const candidates = await callHistoryRepository.fetchHistoryForSync({
    familyId: actor.familyId,
    identityId: actor.identityId,
    since,
    limit: requestedLimit + 1
  });
  const hasMore = candidates.length > requestedLimit;
  const page = hasMore ? candidates.slice(0, requestedLimit) : candidates;
  const remotePublicKeys = await resolveCallPeerPublicKeysById(
    actor.familyId,
    Array.from(new Set(page.map((item) => item.remoteIdentityId)))
  );
  const events = page.map((item) => ({
    ...item,
    remotePublicKey: remotePublicKeys.get(item.remoteIdentityId)
  }));
  const syncedThrough = page.length > 0
    ? page[page.length - 1].lastUpdatedAt
    : since;

  return { events, syncedThrough, hasMore };
}

export async function markMissedCallsSeenForActor(
  actor: AuthenticatedActor,
  payload: { callSessionIds?: string[]; peerIdentityId?: string; seenAt?: number }
): Promise<void> {
  const callSessionIds = Array.isArray(payload.callSessionIds)
    ? payload.callSessionIds.map((id) => String(id || '').trim()).filter(Boolean) as CallSessionId[]
    : undefined;
  const peerIdentityId = String(payload.peerIdentityId || '').trim() || undefined;
  const seenAt = Number(payload.seenAt || 0);
  if (!Number.isFinite(seenAt) || seenAt <= 0 || ((!callSessionIds || callSessionIds.length === 0) && !peerIdentityId)) {
    throw new CallHistoryServiceError(400, 'INVALID_STATE' as ErrorCode, 'Invalid missed seen payload');
  }

  await callHistoryRepository.markMissedSeen({
    familyId: actor.familyId,
    identityId: actor.identityId,
    seenAt,
    callSessionIds,
    peerIdentityId
  });
}

export async function ackCallHistorySyncForActor(
  actor: AuthenticatedActor,
  payload: { syncedThrough?: number }
): Promise<void> {
  const syncedThrough = Number(payload.syncedThrough || 0);
  if (!Number.isFinite(syncedThrough) || syncedThrough < 0) {
    throw new CallHistoryServiceError(400, 'INVALID_REQUEST' as ErrorCode, 'Invalid call history sync ack');
  }

  const syncState = await callHistoryRepository.getSyncState(actor.familyId, actor.deviceId);
  await callHistoryRepository.updateSyncState(
    actor.familyId,
    actor.deviceId,
    Math.max(syncState.last_call_history_sync_at, syncedThrough)
  );
}
