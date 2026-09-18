import { routeLogger } from '../utils/routeLogger';
import type { Router } from 'express';
import type { ErrorCode } from '@shared/types';
import { query } from '../db';
import {
  clampLimit,
  jsonError,
  jsonOk,
  optionalNumber,
  requireInspectorSession,
  type InspectorRequest
} from './inspectorSupport';

type CallDiagnosticFlagSeverity = 'info' | 'warning' | 'critical';

type CallDiagnosticFlag = {
  severity: CallDiagnosticFlagSeverity;
  code: string;
  message: string;
  identityId?: string;
  deviceId?: string;
  details?: Record<string, unknown>;
};

type CallDiagnosticsInput = {
  callLog: Record<string, unknown> | null;
  clientDiagnostics: Array<Record<string, unknown>>;
  handlingEvents: Array<Record<string, unknown>>;
  iceDiagnostics: Array<Record<string, unknown>>;
};

function toMs(value: unknown): number | null {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pushFlagOnce(flags: CallDiagnosticFlag[], flag: CallDiagnosticFlag): void {
  const exists = flags.some((item) =>
    item.code === flag.code
    && item.identityId === flag.identityId
    && item.deviceId === flag.deviceId
  );
  if (!exists) flags.push(flag);
}

function buildCallDiagnosticFlags(input: CallDiagnosticsInput): CallDiagnosticFlag[] {
  const flags: CallDiagnosticFlag[] = [];
  const log = input.callLog;
  if (!log) {
    return [{
      severity: 'critical',
      code: 'missing_call_log',
      message: 'Call log row was not found for this call session.'
    }];
  }

  const createdAt = toMs(log.created_at);
  const connectedAt = toMs(log.media_connected_at);
  const endedAt = toMs(log.ended_at);
  const lastHeartbeatAt = toMs(log.last_heartbeat_at);
  const finalStatus = String(log.final_status || '');
  const expectedParticipantIds = [
    String(log.initiator_identity_id || ''),
    String(log.target_identity_id || '')
  ].filter(Boolean);
  const diagnosticIdentityIds = new Set(
    input.clientDiagnostics
      .map((row) => String(row.identity_id || ''))
      .filter(Boolean)
  );

  if (endedAt && expectedParticipantIds.length > 0 && ['answered', 'ended', 'failed'].includes(finalStatus)) {
    const missing = expectedParticipantIds.filter((identityId) => !diagnosticIdentityIds.has(identityId));
    for (const identityId of missing) {
      pushFlagOnce(flags, {
        severity: finalStatus === 'failed' ? 'info' : 'warning',
        code: 'missing_final_diagnostics',
        message: 'Call ended but this participant did not upload final client diagnostics.',
        identityId,
        details: { finalStatus }
      });
    }
    if (diagnosticIdentityIds.size === 1 && expectedParticipantIds.length > 1) {
      pushFlagOnce(flags, {
        severity: 'warning',
        code: 'one_sided_finalization',
        message: 'Only one participant uploaded final client diagnostics.',
        details: {
          expectedParticipants: expectedParticipantIds,
          diagnosticParticipants: Array.from(diagnosticIdentityIds)
        }
      });
    }
  }

  if (endedAt && !connectedAt && ['answered', 'ended', 'failed'].includes(finalStatus)) {
    pushFlagOnce(flags, {
      severity: finalStatus === 'failed' ? 'info' : 'warning',
      code: 'ended_without_connected',
      message: 'No media connection timestamp was reported. Acceptance alone does not confirm media; old clients may not report this timestamp.',
      details: { finalStatus }
    });
  }

  if (createdAt && connectedAt) {
    const setupMs = connectedAt - createdAt;
    if (setupMs > 15_000) {
      pushFlagOnce(flags, {
        severity: setupMs > 30_000 ? 'critical' : 'warning',
        code: 'long_setup_time',
        message: 'Call setup took longer than expected before reported media connection.',
        details: { setupMs }
      });
    }
  }

  if (endedAt && lastHeartbeatAt && lastHeartbeatAt > endedAt + 5_000) {
    pushFlagOnce(flags, {
      severity: 'warning',
      code: 'heartbeat_after_end',
      message: 'Server recorded a call heartbeat after the call end timestamp.',
      details: {
        endedAt,
        lastHeartbeatAt,
        deltaMs: lastHeartbeatAt - endedAt
      }
    });
  }

  if (connectedAt && input.iceDiagnostics.length === 0) {
    pushFlagOnce(flags, {
      severity: 'info',
      code: 'missing_ice_diagnostics',
      message: 'Call connected, but no server-side ICE diagnostics were recorded.'
    });
  }

  for (const row of input.clientDiagnostics) {
    const identityId = String(row.identity_id || '') || undefined;
    const deviceId = String(row.device_id || '') || undefined;
    const finalConnectionState = String(row.final_connection_state || '');
    const finalIceConnectionState = String(row.final_ice_connection_state || '');
    if (row.reached_reconnecting === true) {
      pushFlagOnce(flags, {
        severity: 'warning',
        code: 'reached_reconnecting',
        message: 'Client reported that the call reached reconnecting.',
        identityId,
        deviceId
      });
    }
    if (row.ever_connected === false) {
      pushFlagOnce(flags, {
        severity: finalStatus === 'answered' ? 'warning' : 'info',
        code: 'never_connected',
        message: 'Client final diagnostics report that media never connected.',
        identityId,
        deviceId,
        details: { finalStatus }
      });
    }
    if (row.security_verified === false) {
      pushFlagOnce(flags, {
        severity: 'warning',
        code: 'security_not_verified',
        message: 'Client final diagnostics report failed or missing call security verification.',
        identityId,
        deviceId
      });
    }
    if (finalConnectionState === 'failed' || finalIceConnectionState === 'failed') {
      pushFlagOnce(flags, {
        severity: 'warning',
        code: 'final_connection_failed',
        message: 'Client final diagnostics ended in a failed WebRTC connection state.',
        identityId,
        deviceId,
        details: {
          finalConnectionState: row.final_connection_state,
          finalIceConnectionState: row.final_ice_connection_state
        }
      });
    }
  }

  for (const row of input.handlingEvents) {
    if (row.event_type === 'call_finalized' && row.reason_code === 'final_diagnostics_queued') {
      pushFlagOnce(flags, {
        severity: 'info',
        code: 'queued_native_diagnostics',
        message: 'Android queued final diagnostics because signaling was unavailable at teardown.',
        identityId: String(row.identity_id || '') || undefined,
        deviceId: String(row.device_id || '') || undefined
      });
    }
    if (row.event_type === 'bootstrap_failed') {
      pushFlagOnce(flags, {
        severity: 'warning',
        code: 'native_bootstrap_failed',
        message: 'Native call bootstrap failed on a mobile device.',
        identityId: String(row.identity_id || '') || undefined,
        deviceId: String(row.device_id || '') || undefined,
        details: { reasonCode: row.reason_code || undefined }
      });
    }
    if (row.event_type === 'telecom_failed') {
      pushFlagOnce(flags, {
        severity: 'warning',
        code: 'telecom_failed',
        message: 'Android Telecom integration reported a failure.',
        identityId: String(row.identity_id || '') || undefined,
        deviceId: String(row.device_id || '') || undefined,
        details: { reasonCode: row.reason_code || undefined }
      });
    }
  }

  return flags;
}

export function registerInspectorReadRoutes(router: Router): void {
  router.get('/identities', requireInspectorSession, async (req: InspectorRequest, res) => {
    try {
      const result = await query(
        `SELECT identity_id, status, role, publish_identity, identity_name,
                invite_quota, invite_used, presence_visible, avatar_blob_id IS NOT NULL AS has_avatar,
                created_at, status_updated_at, avatar_updated_at
         FROM identities
         WHERE family_id = $1
         ORDER BY created_at DESC`,
        [req.familyId]
      );
      return jsonOk(res, { identities: result.rows });
    } catch (error) {
      routeLogger.error('Inspector identities error:', error);
      return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
    }
  });

  router.get('/devices', requireInspectorSession, async (req: InspectorRequest, res) => {
    try {
      const result = await query(
        `SELECT device_id, identity_id, label, web_origin, status, created_at, last_seen_at,
                encrypted_physical_device_id IS NOT NULL AS has_encrypted_physical_device_id,
                registration_attestation IS NOT NULL AS has_registration_attestation,
                encryption_public_key_value IS NOT NULL AS has_encryption_key
         FROM devices
         WHERE family_id = $1
         ORDER BY created_at DESC`,
        [req.familyId]
      );
      return jsonOk(res, { devices: result.rows });
    } catch (error) {
      routeLogger.error('Inspector devices error:', error);
      return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
    }
  });

  router.get('/chats', requireInspectorSession, async (req: InspectorRequest, res) => {
    try {
      const direct = await query(
        `SELECT direct_chat_id,
                MIN(created_at) AS first_message_at,
                MAX(content_updated_at) AS last_message_at,
                COUNT(*) AS message_count,
                COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted_message_count
         FROM messages
         WHERE family_id = $1
         GROUP BY direct_chat_id
         ORDER BY MAX(content_updated_at) DESC
         LIMIT 500`,
        [req.familyId]
      );
      const groups = await query(
        `SELECT gc.chat_id, gc.title_ciphertext, gc.owner_identity_id, gc.created_at, gc.updated_at,
                gc.last_message_at, gc.key_epoch,
                COUNT(DISTINCT gp.identity_id) FILTER (WHERE gp.is_active) AS active_participants,
                COUNT(gcm.message_id) AS message_count
         FROM group_chats gc
         LEFT JOIN group_chat_participants gp ON gp.family_id = gc.family_id AND gp.chat_id = gc.chat_id
         LEFT JOIN group_chat_messages gcm ON gcm.family_id = gc.family_id AND gcm.chat_id = gc.chat_id
         WHERE gc.family_id = $1
         GROUP BY gc.chat_id, gc.title_ciphertext, gc.owner_identity_id, gc.created_at, gc.updated_at, gc.last_message_at, gc.key_epoch
         ORDER BY COALESCE(gc.last_message_at, gc.updated_at) DESC
         LIMIT 500`,
        [req.familyId]
      );
      return jsonOk(res, { directChats: direct.rows, groupChats: groups.rows });
    } catch (error) {
      routeLogger.error('Inspector chats error:', error);
      return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
    }
  });

  router.get('/messages', requireInspectorSession, async (req: InspectorRequest, res) => {
    try {
      const chatType = String(req.query.chatType || 'direct');
      const chatId = String(req.query.chatId || '');
      const from = optionalNumber(req.query.from);
      const to = optionalNumber(req.query.to);
      const limit = clampLimit(req.query.limit, 100, 500);
      const bounds = [req.familyId, from, to, chatId || null, limit];

      if (chatType === 'group') {
        const result = await query(
          `SELECT message_id, chat_id, chat_seq, sender_identity_id, sender_device_id,
                  kind, client_message_id, client_created_at, created_at, content_updated_at,
                  edited_at, deleted_at, revision, epoch, system_type,
                  ciphertext IS NOT NULL AS has_encrypted_payload,
                  COALESCE(length(ciphertext), 0) AS encrypted_payload_bytes,
                  sender_signature IS NOT NULL AS has_sender_signature
           FROM group_chat_messages
           WHERE family_id = $1
             AND ($2::bigint IS NULL OR created_at >= $2)
             AND ($3::bigint IS NULL OR created_at <= $3)
             AND ($4::text IS NULL OR chat_id = $4)
           ORDER BY created_at DESC
           LIMIT $5`,
          bounds
        );
        return jsonOk(res, { messages: result.rows, chatType });
      }

      const result = await query(
        `SELECT server_message_id, direct_chat_id, chat_seq, sender_identity_id,
                recipient_identity_id, sender_device_id, client_message_id,
                client_created_at, created_at, content_updated_at, edited_at,
                deleted_at, revision, status, status_updated_at, epoch,
                true AS has_encrypted_payload,
                length(ciphertext) AS encrypted_payload_bytes,
                sender_ciphertext IS NOT NULL AS has_sender_ciphertext,
                sender_signature IS NOT NULL AS has_sender_signature
         FROM messages
         WHERE family_id = $1
           AND ($2::bigint IS NULL OR created_at >= $2)
           AND ($3::bigint IS NULL OR created_at <= $3)
           AND ($4::text IS NULL OR direct_chat_id = $4)
         ORDER BY created_at DESC
         LIMIT $5`,
        bounds
      );
      return jsonOk(res, { messages: result.rows, chatType: 'direct' });
    } catch (error) {
      routeLogger.error('Inspector messages error:', error);
      return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
    }
  });

  router.get('/guests', requireInspectorSession, async (req: InspectorRequest, res) => {
    try {
      const result = await query(
        `SELECT r.registration_id,
                r.guest_identity_id, gi.identity_name AS guest_name,
                r.host_identity_id, hi.identity_name AS host_name,
                r.link_id, l.title AS link_title,
                r.can_message, r.can_call, r.can_direct_file_transfer,
                r.status,
                r.created_at, r.last_seen_at, r.revoked_at
         FROM direct_guest_registrations r
         LEFT JOIN identities gi ON gi.family_id = r.family_id AND gi.identity_id = r.guest_identity_id
         LEFT JOIN identities hi ON hi.family_id = r.family_id AND hi.identity_id = r.host_identity_id
         LEFT JOIN direct_guest_links l ON l.family_id = r.family_id AND l.link_id = r.link_id
         WHERE r.family_id = $1
         ORDER BY r.created_at DESC
         LIMIT 500`,
        [req.familyId]
      );
      return jsonOk(res, { guests: result.rows });
    } catch (error) {
      routeLogger.error('Inspector guests error:', error);
      return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
    }
  });

  router.get('/calls', requireInspectorSession, async (req: InspectorRequest, res) => {
    try {
      const from = optionalNumber(req.query.from);
      const to = optionalNumber(req.query.to);
      const identityId = String(req.query.identityId || '');
      const limit = clampLimit(req.query.limit, 100, 500);
      const result = await query(
        `SELECT cl.call_session_id, cl.initiator_identity_id, cl.target_identity_id,
                cl.is_temporary_link_call, cl.created_at, cl.connected_at, cl.media_connected_at, cl.ended_at,
                cl.final_status, cl.final_reason, cl.duration_seconds,
                cl.last_updated_at, cl.last_heartbeat_at, cl.missed_seen_at,
                COALESCE(client_diag.count, 0) AS client_diagnostics_count,
                client_diag.media_reported_connected,
                COALESCE(client_diag.quality_count, 0) AS quality_diagnostics_count,
                COALESCE(client_diag.turn_cluster_ids, '') AS turn_cluster_ids,
                COALESCE(ice_diag.count, 0) AS ice_diagnostics_count,
                COALESCE(handling_events.count, 0) AS handling_events_count
         FROM call_logs cl
         LEFT JOIN (
           SELECT family_id, call_session_id, COUNT(*) AS count,
                  BOOL_OR(ever_connected) AS media_reported_connected,
                  COUNT(*) FILTER (WHERE media_quality_summary IS NOT NULL) AS quality_count,
                  STRING_AGG(
                    DISTINCT NULLIF(media_quality_summary->>'turnClusterId', ''),
                    ', '
                  ) FILTER (WHERE media_quality_summary IS NOT NULL) AS turn_cluster_ids
           FROM call_client_diagnostics
           GROUP BY family_id, call_session_id
         ) client_diag ON client_diag.family_id = cl.family_id AND client_diag.call_session_id = cl.call_session_id
         LEFT JOIN (
           SELECT family_id, call_session_id, COUNT(*) AS count
           FROM call_ice_diagnostics
           GROUP BY family_id, call_session_id
         ) ice_diag ON ice_diag.family_id = cl.family_id AND ice_diag.call_session_id = cl.call_session_id
         LEFT JOIN (
           SELECT family_id, call_session_id, COUNT(*) AS count
           FROM call_handling_events
           GROUP BY family_id, call_session_id
         ) handling_events ON handling_events.family_id = cl.family_id AND handling_events.call_session_id = cl.call_session_id
         WHERE cl.family_id = $1
           AND ($2::bigint IS NULL OR cl.created_at >= $2)
           AND ($3::bigint IS NULL OR cl.created_at <= $3)
           AND ($4::text = '' OR cl.initiator_identity_id = $4 OR cl.target_identity_id = $4)
         ORDER BY cl.created_at DESC
         LIMIT $5`,
        [req.familyId, from, to, identityId, limit]
      );
      return jsonOk(res, { calls: result.rows });
    } catch (error) {
      routeLogger.error('Inspector calls error:', error);
      return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
    }
  });

  router.get('/calls/quality-summary', requireInspectorSession, async (req: InspectorRequest, res) => {
    try {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const requestedTo = optionalNumber(req.query.to) ?? now;
      const to = Math.min(requestedTo, now + dayMs);
      const requestedFrom = optionalNumber(req.query.from) ?? (to - 29 * dayMs);
      const from = Math.max(0, Math.min(requestedFrom, to), to - 366 * dayMs);
      const fromDay = Math.floor(from / dayMs) * dayMs;
      const toDay = Math.floor(to / dayMs) * dayMs;
      const minimumRelayCalls = 10;
      const result = await query(
        `SELECT
           turn_cluster_id,
           SUM(calls_count)::bigint AS calls_count,
           SUM(reports_count)::bigint AS reports_count,
           SUM(two_sided_calls_count)::bigint AS two_sided_calls_count,
           SUM(relay_calls_count)::bigint AS relay_calls_count,
           SUM(relay_reports_count)::bigint AS relay_reports_count,
           SUM(sample_count)::bigint AS sample_count,
           SUM(reconnect_count)::bigint AS reconnect_count,
           SUM(reconnecting_reports_count)::bigint AS reconnecting_reports_count,
           SUM(rtt_reports_count)::bigint AS rtt_reports_count,
           CASE WHEN SUM(rtt_reports_count) > 0 THEN
             SUM(rtt_average_ms * rtt_reports_count) / SUM(rtt_reports_count)
           END AS rtt_average_ms,
           MAX(rtt_maximum_ms) AS rtt_maximum_ms,
           SUM(jitter_reports_count)::bigint AS jitter_reports_count,
           CASE WHEN SUM(jitter_reports_count) > 0 THEN
             SUM(jitter_average_ms * jitter_reports_count) / SUM(jitter_reports_count)
           END AS jitter_average_ms,
           MAX(jitter_maximum_ms) AS jitter_maximum_ms,
           SUM(packets_lost)::bigint AS packets_lost,
           SUM(packets_received)::bigint AS packets_received,
           SUM(outbound_bitrate_reports_count)::bigint AS outbound_bitrate_reports_count,
           CASE WHEN SUM(outbound_bitrate_reports_count) > 0 THEN
             SUM(outbound_bitrate_average_kbps * outbound_bitrate_reports_count)
               / SUM(outbound_bitrate_reports_count)
           END AS outbound_bitrate_average_kbps,
           SUM(inbound_bitrate_reports_count)::bigint AS inbound_bitrate_reports_count,
           CASE WHEN SUM(inbound_bitrate_reports_count) > 0 THEN
             SUM(inbound_bitrate_average_kbps * inbound_bitrate_reports_count)
               / SUM(inbound_bitrate_reports_count)
           END AS inbound_bitrate_average_kbps,
           SUM(traffic_reports_count)::bigint AS traffic_reports_count,
           SUM(relay_traffic_reports_count)::bigint AS relay_traffic_reports_count,
           SUM(media_bytes_sent)::bigint AS media_bytes_sent,
           SUM(media_bytes_received)::bigint AS media_bytes_received,
           SUM(relay_media_bytes_sent)::bigint AS relay_media_bytes_sent,
           SUM(relay_media_bytes_received)::bigint AS relay_media_bytes_received,
           SUM(freeze_count)::bigint AS freeze_count,
           SUM(reports_with_freezes_count)::bigint AS reports_with_freezes_count,
           MAX(updated_at)::bigint AS updated_at
         FROM call_quality_daily
         WHERE family_id = $1 AND day_start_ms >= $2 AND day_start_ms <= $3
         GROUP BY turn_cluster_id
         ORDER BY turn_cluster_id`,
        [req.familyId, fromDay, toDay]
      );
      return jsonOk(res, {
        from: fromDay,
        to: toDay + dayMs - 1,
        minimumRelayCalls,
        clusters: result.rows.map((row) => ({
          ...row,
          insufficientRelaySample: Number(row.relay_calls_count || 0) < minimumRelayCalls
        }))
      });
    } catch (error) {
      routeLogger.error('Inspector call quality summary error:', error);
      return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
    }
  });

  router.get('/calls/:callSessionId/diagnostics', requireInspectorSession, async (req: InspectorRequest, res) => {
    try {
      const callSessionId = String(req.params.callSessionId || '');
      const callLog = await query(
        `SELECT call_session_id, initiator_identity_id, target_identity_id,
                created_at, connected_at, media_connected_at, duration_seconds, ended_at, final_status, final_reason,
                last_updated_at, last_heartbeat_at
         FROM call_logs
         WHERE family_id = $1 AND call_session_id = $2
         LIMIT 1`,
        [req.familyId, callSessionId]
      );
      const clientDiagnostics = await query(
        `SELECT call_session_id, identity_id, device_id, final_connection_state,
                final_ice_connection_state, ever_connected, reached_reconnecting,
                security_verified, selected_candidate_pair, phase_history,
                end_reason, runtime_metadata, diagnostics_version,
                media_quality_summary, recorded_at
         FROM call_client_diagnostics
         WHERE family_id = $1 AND call_session_id = $2
         ORDER BY recorded_at DESC`,
        [req.familyId, callSessionId]
      );
      const iceDiagnostics = await query(
        `SELECT call_session_id, identity_id, total_candidates, relay_candidates,
                srflx_candidates, host_candidates, prflx_candidates, udp_candidates,
                tcp_candidates, recorded_at
         FROM call_ice_diagnostics
         WHERE family_id = $1 AND call_session_id = $2
         ORDER BY recorded_at DESC`,
        [req.familyId, callSessionId]
      );
      const handlingEvents = await query(
        `SELECT event_id, call_session_id, identity_id, device_id,
                event_type, reason_code, occurred_at, recorded_at
         FROM call_handling_events
         WHERE family_id = $1 AND call_session_id = $2
         ORDER BY recorded_at ASC, event_id ASC`,
        [req.familyId, callSessionId]
      );
      const timeline: Array<Record<string, unknown>> = [];
      const logRow = callLog.rows[0];
      if (logRow) {
        if (logRow.created_at) {
          timeline.push({
            at: Number(logRow.created_at),
            source: 'server',
            event: 'call_created',
            identityId: logRow.initiator_identity_id,
            details: { targetIdentityId: logRow.target_identity_id }
          });
        }
        if (logRow.connected_at) {
          timeline.push({
            at: Number(logRow.connected_at),
            source: 'server',
            event: 'call_accepted'
          });
        }
        if (logRow.media_connected_at) {
          timeline.push({ at: Number(logRow.media_connected_at), source: 'client_report', event: 'media_connected' });
        }
        if (logRow.ended_at) {
          timeline.push({
            at: Number(logRow.ended_at),
            source: 'server',
            event: 'call_ended',
            details: {
              finalStatus: logRow.final_status,
              finalReason: logRow.final_reason
            }
          });
        }
      }
      for (const row of handlingEvents.rows) {
        timeline.push({
          at: Number(row.occurred_at || row.recorded_at),
          recordedAt: Number(row.recorded_at),
          source: 'client_handling',
          event: row.event_type,
          identityId: row.identity_id,
          deviceId: row.device_id,
          details: row.reason_code ? { reasonCode: row.reason_code } : undefined
        });
      }
      for (const row of clientDiagnostics.rows) {
        timeline.push({
          at: Number(row.recorded_at),
          source: 'client_diagnostics',
          event: 'client_diagnostics_recorded',
          identityId: row.identity_id,
          deviceId: row.device_id,
          details: {
            finalConnectionState: row.final_connection_state,
            finalIceConnectionState: row.final_ice_connection_state,
            everConnected: row.ever_connected,
            reachedReconnecting: row.reached_reconnecting,
            endReason: row.end_reason,
            runtime: row.runtime_metadata || undefined
          }
        });
      }
      for (const row of iceDiagnostics.rows) {
        timeline.push({
          at: Number(row.recorded_at),
          source: 'ice_diagnostics',
          event: 'ice_diagnostics_recorded',
          identityId: row.identity_id,
          details: {
            totalCandidates: row.total_candidates,
            relayCandidates: row.relay_candidates,
            srflxCandidates: row.srflx_candidates,
            hostCandidates: row.host_candidates
          }
        });
      }
      timeline.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
      const diagnosticFlags = buildCallDiagnosticFlags({
        callLog: callLog.rows[0] || null,
        clientDiagnostics: clientDiagnostics.rows,
        handlingEvents: handlingEvents.rows,
        iceDiagnostics: iceDiagnostics.rows
      });
      const diagnosticFlagSummary = diagnosticFlags.reduce(
        (acc, flag) => {
          acc.total += 1;
          acc[flag.severity] += 1;
          return acc;
        },
        { total: 0, info: 0, warning: 0, critical: 0 }
      );
      return jsonOk(res, {
        callSessionId,
        callLog: callLog.rows[0] || null,
        timeline,
        diagnosticFlags,
        diagnosticFlagSummary,
        clientDiagnostics: clientDiagnostics.rows,
        iceDiagnostics: iceDiagnostics.rows,
        handlingEvents: handlingEvents.rows
      });
    } catch (error) {
      routeLogger.error('Inspector call diagnostics error:', error);
      return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
    }
  });
}
