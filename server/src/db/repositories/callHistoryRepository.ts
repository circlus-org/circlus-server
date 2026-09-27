import type { CallSessionId, DeviceId, IdentityId, PublicKey } from '@shared/types';
import { pool, query } from '../index';
import { getCallRuntimeConfig } from '../../config/serverRuntimeConfig';
import {
  deriveCallHistoryFinalReason,
  deriveCallHistoryEndedAt,
  deriveCallHistoryFinalStatus,
  isCallRejectionReason,
  type CallHistoryServerStatus
} from './callHistoryStatusPolicy';

export type { CallHistoryServerStatus } from './callHistoryStatusPolicy';

export type CallHistorySyncRecord = {
  callSessionId: CallSessionId;
  localIdentityId: IdentityId;
  remoteIdentityId: IdentityId;
  direction: 'incoming' | 'outgoing';
  status: 'ringing' | 'answered' | 'rejected' | 'ended' | 'failed';
  timestamp: number;
  createdAt: number;
  connectedAt?: number;
  endedAt?: number;
  durationSeconds?: number;
  reason?: string;
  isTemporaryLinkCall?: boolean;
  callLinkTitle?: string;
  lastUpdatedAt: number;
};

export const MAX_CALL_HISTORY_SYNC_BATCH = (
  getCallRuntimeConfig().webSocket.callHistorySyncBatch
);

type CallLogRow = {
  call_session_id: string;
  family_id: string;
  initiator_identity_id: string;
  target_identity_id: string;
  is_temporary_link_call: boolean;
  created_at: number;
  connected_at: number | null;
  media_connected_at: number | null;
  last_heartbeat_at: number | null;
  ended_at: number | null;
  final_status: CallHistoryServerStatus;
  final_reason: string | null;
  duration_seconds: number | null;
  missed_seen_at: number | null;
  external_initiator_public_key: PublicKey | null;
  call_link_title: string | null;
  last_updated_at: number;
};

function mapCallLogRow(row: CallLogRow): CallLogRow {
  return {
    ...row,
    created_at: Number(row.created_at),
    connected_at: row.connected_at === null ? null : Number(row.connected_at),
    media_connected_at: row.media_connected_at == null ? null : Number(row.media_connected_at),
    last_heartbeat_at: row.last_heartbeat_at === null ? null : Number(row.last_heartbeat_at),
    ended_at: row.ended_at === null ? null : Number(row.ended_at),
    duration_seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    missed_seen_at: row.missed_seen_at === null ? null : Number(row.missed_seen_at),
    last_updated_at: Number(row.last_updated_at)
  };
}

function toClientStatus(status: CallHistoryServerStatus, reason?: string | null): CallHistorySyncRecord['status'] {
  if (isCallRejectionReason(reason)) return 'rejected';
  if (status === 'missed') return 'failed';
  return status;
}

function deriveDurationSeconds(connectedAt: number | null, endedAt: number | null, reported?: number | null): number | null {
  if (connectedAt !== null && endedAt !== null && endedAt >= connectedAt) {
    return Math.max(0, Math.floor((endedAt - connectedAt) / 1000));
  }
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
    return Math.floor(reported);
  }
  return null;
}

function normalizePublicKey(value: unknown): PublicKey | null {
  if (!value) return null;
  const parsed = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      })()
    : value;
  if (!parsed || typeof parsed !== 'object') return null;
  const key = parsed as Partial<PublicKey>;
  return key.algorithm && key.value
    ? { algorithm: key.algorithm, value: key.value }
    : null;
}

export class CallHistoryRepository {
  async findByCallSessionId(familyId: string, callSessionId: CallSessionId): Promise<CallLogRow | null> {
    const result = await query<CallLogRow>(
      `SELECT *
       FROM call_logs
       WHERE family_id = $1 AND call_session_id = $2
       LIMIT 1`,
      [familyId, callSessionId]
    );
    return result.rows[0] ? mapCallLogRow(result.rows[0]) : null;
  }

  async ensureCreated(params: {
    familyId: string;
    callSessionId: CallSessionId;
    initiatorIdentityId: IdentityId;
    targetIdentityId: IdentityId;
    isTemporaryLinkCall?: boolean;
    externalInitiatorPublicKey?: PublicKey;
    callLinkTitle?: string;
    createdAt?: number;
  }): Promise<void> {
    const createdAt = typeof params.createdAt === 'number' && Number.isFinite(params.createdAt)
      ? Math.floor(params.createdAt)
      : Date.now();
    await pool.query(
      `INSERT INTO call_logs (
         call_session_id,
         family_id,
         initiator_identity_id,
         target_identity_id,
         is_temporary_link_call,
         created_at,
         final_status,
         external_initiator_public_key,
         call_link_title,
         last_updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ringing', $7::jsonb, NULL, $6)
       ON CONFLICT (call_session_id) DO NOTHING`,
      [
        params.callSessionId,
        params.familyId,
        params.initiatorIdentityId,
        params.targetIdentityId,
        params.isTemporaryLinkCall === true,
        createdAt,
        params.externalInitiatorPublicKey ? JSON.stringify(params.externalInitiatorPublicKey) : null
      ]
    );
  }

  async markAccepted(params: {
    familyId: string;
    callSessionId: CallSessionId;
    connectedAt: number;
  }): Promise<void> {
    // connected_at is the legacy acceptance timestamp; never use it as media evidence.
    await pool.query(`UPDATE call_logs
      SET connected_at = COALESCE(connected_at, $3), final_status = 'answered',
          missed_seen_at = NULL, last_updated_at = $4
      WHERE family_id = $1 AND call_session_id = $2 AND ended_at IS NULL`,
    [params.familyId, params.callSessionId, Math.floor(params.connectedAt), Date.now()]);
  }

  async recordMediaConnection(params: {
    familyId: string;
    callSessionId: CallSessionId;
    connectedAt?: number;
  }): Promise<void> {
    if (!Number.isFinite(params.connectedAt) || Number(params.connectedAt) <= 0) return;
    await pool.query(`UPDATE call_logs
      SET media_connected_at = LEAST(COALESCE(media_connected_at, $3), $3),
          duration_seconds = CASE WHEN ended_at >= $3
            THEN GREATEST(0, FLOOR((ended_at - LEAST(COALESCE(media_connected_at, $3), $3)) / 1000.0))::INT
            ELSE duration_seconds END,
          last_updated_at = $4
      WHERE family_id = $1 AND call_session_id = $2
        AND $3::bigint >= created_at - 120000 AND $3::bigint <= $4::bigint + 120000
        AND (ended_at IS NULL OR $3 <= ended_at)`,
    [params.familyId, params.callSessionId, Math.floor(Number(params.connectedAt)), Date.now()]);
  }

  async markConnected(params: {
    familyId: string;
    callSessionId: CallSessionId;
    connectedAt: number;
  }): Promise<void> {
    await this.recordMediaConnection(params);
    const existing = await this.findByCallSessionId(params.familyId, params.callSessionId);
    if (!existing) return;
    const connectedAt = Math.max(0, Math.floor(params.connectedAt));
    const nextConnectedAt = existing.connected_at ?? connectedAt;
    const endedAt = existing.ended_at;
    const durationSeconds = deriveDurationSeconds(existing.media_connected_at, endedAt, existing.duration_seconds);
    await pool.query(
      `UPDATE call_logs
       SET connected_at = $3,
           last_heartbeat_at = GREATEST(COALESCE(last_heartbeat_at, 0), $3),
           final_status = 'answered',
           duration_seconds = $4,
           missed_seen_at = NULL,
           last_updated_at = $5
       WHERE family_id = $1 AND call_session_id = $2`,
      [params.familyId, params.callSessionId, nextConnectedAt, durationSeconds, Date.now()]
    );
  }

  async markHeartbeat(params: {
    familyId: string;
    callSessionId: CallSessionId;
    connectedAt: number;
    heartbeatAt: number;
  }): Promise<void> {
    await this.recordMediaConnection(params);
    const existing = await this.findByCallSessionId(params.familyId, params.callSessionId);
    if (!existing) return;

    const connectedAt = Math.max(0, Math.floor(params.connectedAt));
    const heartbeatAt = Math.max(connectedAt, Math.floor(params.heartbeatAt));
    const nextConnectedAt = existing.connected_at ?? connectedAt;
    const nextHeartbeatAt = existing.last_heartbeat_at === null
      ? heartbeatAt
      : Math.max(existing.last_heartbeat_at, heartbeatAt);
    const durationSeconds = deriveDurationSeconds(existing.media_connected_at, nextHeartbeatAt, existing.duration_seconds);

    await pool.query(
      `UPDATE call_logs
       SET connected_at = $3,
           last_heartbeat_at = $4,
           final_status = 'answered',
           duration_seconds = $5,
           missed_seen_at = NULL,
           last_updated_at = $6
       WHERE family_id = $1 AND call_session_id = $2
         AND ended_at IS NULL`,
      [params.familyId, params.callSessionId, nextConnectedAt, nextHeartbeatAt, durationSeconds, Date.now()]
    );
  }

  async markFinalized(params: {
    familyId: string;
    callSessionId: CallSessionId;
    finalStatus: Exclude<CallHistoryServerStatus, 'missed' | 'ringing'>;
    endedAt: number;
    reason?: string;
    durationSeconds?: number;
  }): Promise<void> {
    const existing = await this.findByCallSessionId(params.familyId, params.callSessionId);
    if (!existing) return;
    const endedAt = Math.max(0, Math.floor(params.endedAt));
    const nextEndedAt = deriveCallHistoryEndedAt({
      existingEndedAt: existing.ended_at,
      existingReason: existing.final_reason,
      reportedEndedAt: endedAt
    });
    const nextStatus = deriveCallHistoryFinalStatus({
      existingStatus: existing.final_status,
      reportedStatus: params.finalStatus,
      connectedAt: existing.connected_at
    });
    const nextReason = deriveCallHistoryFinalReason({
      existingStatus: existing.final_status,
      nextStatus,
      existingReason: existing.final_reason,
      reportedReason: params.reason
    });
    const durationSeconds = deriveDurationSeconds(
      existing.media_connected_at,
      nextEndedAt,
      typeof params.durationSeconds === 'number' ? params.durationSeconds : existing.duration_seconds
    );
    await pool.query(
      `UPDATE call_logs
       SET ended_at = $3,
           final_status = $4,
           final_reason = COALESCE($5, final_reason),
           duration_seconds = $6,
           last_updated_at = $7
       WHERE family_id = $1 AND call_session_id = $2`,
      [
        params.familyId,
        params.callSessionId,
        nextEndedAt,
        nextStatus,
        nextReason,
        durationSeconds,
        Date.now()
      ]
    );
  }

  async markMissed(params: {
    familyId: string;
    callSessionId: CallSessionId;
    reason?: string;
  }): Promise<void> {
    const existing = await this.findByCallSessionId(params.familyId, params.callSessionId);
    if (!existing) return;
    if (existing.connected_at !== null) return;
    if (existing.final_status !== 'ringing') return;
    await pool.query(
      `UPDATE call_logs
       SET final_status = 'missed',
           final_reason = COALESCE($3, final_reason),
           last_updated_at = $4
       WHERE family_id = $1 AND call_session_id = $2`,
      [params.familyId, params.callSessionId, params.reason || 'unknown', Date.now()]
    );
  }

  async markRejected(params: {
    familyId: string;
    callSessionId: CallSessionId;
    reason?: string;
  }): Promise<void> {
    const existing = await this.findByCallSessionId(params.familyId, params.callSessionId);
    if (!existing) return;
    if (existing.connected_at !== null) return;
    if (existing.final_status !== 'ringing') return;
    await pool.query(
      `UPDATE call_logs
       SET final_status = 'rejected',
           final_reason = COALESCE($3, final_reason),
           last_updated_at = $4
       WHERE family_id = $1 AND call_session_id = $2`,
      [params.familyId, params.callSessionId, params.reason || 'rejected', Date.now()]
    );
  }

  async fetchHistoryForSync(params: {
    familyId: string;
    identityId: IdentityId;
    since: number;
    limit: number;
  }): Promise<CallHistorySyncRecord[]> {
    const result = await query<CallLogRow & { local_identity_id: string; remote_identity_id: string; direction: 'incoming' | 'outgoing' }>(
      `SELECT
         cl.*,
         CASE
           WHEN cl.initiator_identity_id = $2 THEN cl.initiator_identity_id
           ELSE cl.target_identity_id
         END AS local_identity_id,
         CASE
           WHEN cl.initiator_identity_id = $2 THEN cl.target_identity_id
           ELSE cl.initiator_identity_id
         END AS remote_identity_id,
         CASE
           WHEN cl.initiator_identity_id = $2 THEN 'outgoing'
           ELSE 'incoming'
         END AS direction
       FROM call_logs cl
       WHERE cl.family_id = $1
         AND cl.last_updated_at > $3
         AND (cl.initiator_identity_id = $2 OR cl.target_identity_id = $2)
       ORDER BY cl.last_updated_at ASC
       LIMIT $4`,
      [params.familyId, params.identityId, params.since, params.limit]
    );
    return result.rows.map((row) => {
      const mapped = mapCallLogRow(row);
      const timestamp = mapped.ended_at ?? mapped.created_at;
      return {
        callSessionId: mapped.call_session_id as CallSessionId,
        localIdentityId: row.local_identity_id as IdentityId,
        remoteIdentityId: row.remote_identity_id as IdentityId,
        direction: row.direction,
        status: toClientStatus(mapped.final_status, mapped.final_reason),
        timestamp,
        createdAt: mapped.created_at,
        connectedAt: mapped.media_connected_at ?? undefined,
        endedAt: mapped.ended_at ?? undefined,
        durationSeconds: mapped.duration_seconds ?? undefined,
        reason: mapped.final_reason || undefined,
        isTemporaryLinkCall: mapped.is_temporary_link_call === true,
        callLinkTitle: mapped.call_link_title || undefined,
        remotePublicKey: row.direction === 'incoming' && mapped.is_temporary_link_call === true
          ? normalizePublicKey(mapped.external_initiator_public_key) || undefined
          : undefined,
        missedSeenAt: mapped.missed_seen_at ?? undefined,
        lastUpdatedAt: mapped.last_updated_at
      };
    });
  }

  async markMissedSeen(params: {
    familyId: string;
    identityId: IdentityId;
    seenAt: number;
    callSessionIds?: CallSessionId[];
    peerIdentityId?: IdentityId;
  }): Promise<number> {
    const seenAt = Math.max(0, Math.floor(params.seenAt));
    const callSessionIds = Array.from(new Set((params.callSessionIds || [])
      .map((id) => String(id || '').trim())
      .filter(Boolean))) as CallSessionId[];
    const peerIdentityId = String(params.peerIdentityId || '').trim();
    const now = Date.now();

    const values: unknown[] = [params.familyId, params.identityId, seenAt, now];
    let extraWhere = '';

    if (callSessionIds.length > 0) {
      values.push(callSessionIds);
      extraWhere += ` AND call_session_id = ANY($${values.length}::text[])`;
    }

    if (peerIdentityId) {
      values.push(peerIdentityId);
      extraWhere += ` AND initiator_identity_id = $${values.length}`;
    }

    const result = await query(
      `UPDATE call_logs
       SET missed_seen_at = GREATEST(COALESCE(missed_seen_at, 0), $3),
           last_updated_at = $4
       WHERE family_id = $1
         AND target_identity_id = $2
         AND final_status IN ('missed', 'failed', 'ended')
         AND connected_at IS NULL
         ${extraWhere}
         AND COALESCE(missed_seen_at, 0) < $3`,
      values
    );

    return result.rowCount || 0;
  }

  async getSyncState(familyId: string, deviceId: DeviceId): Promise<{ last_call_history_sync_at: number }> {
    const result = await query<{ last_call_history_sync_at: number }>(
      `SELECT last_call_history_sync_at
       FROM call_device_sync
       WHERE family_id = $1 AND device_id = $2`,
      [familyId, deviceId]
    );
    if (result.rows[0]) {
      return { last_call_history_sync_at: Number(result.rows[0].last_call_history_sync_at) };
    }

    await pool.query(
      `INSERT INTO call_device_sync (family_id, device_id, last_call_history_sync_at)
       VALUES ($1, $2, 0)
       ON CONFLICT DO NOTHING`,
      [familyId, deviceId]
    );
    return { last_call_history_sync_at: 0 };
  }

  async updateSyncState(familyId: string, deviceId: DeviceId, lastCallHistorySyncAt: number): Promise<void> {
    await pool.query(
      `INSERT INTO call_device_sync (family_id, device_id, last_call_history_sync_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (family_id, device_id)
       DO UPDATE SET
         last_call_history_sync_at = GREATEST(call_device_sync.last_call_history_sync_at, EXCLUDED.last_call_history_sync_at)`,
      [familyId, deviceId, Math.max(0, Math.floor(lastCallHistorySyncAt))]
    );
  }

  async cleanupExpired(cutoff: number): Promise<number> {
    const result = await query(
      `DELETE FROM call_logs
       WHERE last_updated_at < $1`,
      [cutoff]
    );
    return result.rowCount || 0;
  }

  async finalizeStaleConnectedCalls(params: {
    familyId: string;
    staleBefore: number;
    fallbackReason?: string;
  }): Promise<number> {
    const fallbackReason = params.fallbackReason || 'heartbeat_timeout';
    const staleBefore = Math.max(0, Math.floor(params.staleBefore));
    const now = Date.now();
    const result = await query(
      `UPDATE call_logs
       SET ended_at = last_heartbeat_at,
           final_status = 'answered',
           final_reason = COALESCE(final_reason, $3),
           duration_seconds = CASE
             WHEN media_connected_at IS NOT NULL
               AND last_heartbeat_at IS NOT NULL
               AND last_heartbeat_at >= media_connected_at
             THEN GREATEST(0, FLOOR((last_heartbeat_at - media_connected_at) / 1000.0))::INT
             ELSE duration_seconds
           END,
           last_updated_at = $4
       WHERE family_id = $1
         AND connected_at IS NOT NULL
         AND ended_at IS NULL
         AND last_heartbeat_at IS NOT NULL
         AND last_heartbeat_at < $2`,
      [params.familyId, staleBefore, fallbackReason, now]
    );

    return result.rowCount || 0;
  }
}

export const callHistoryRepository = new CallHistoryRepository();
