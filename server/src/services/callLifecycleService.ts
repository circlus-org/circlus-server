import type { CallClientDiagnosticsReport, CallDeliveryStatus, CallHandlingEventReport, CallHandlingEventType, CallSessionId, ErrorCode, IdentityId } from '@shared/types';
import { callClientDiagnosticsRepository, callHandlingEventRepository, callHistoryRepository, callQualityDailyRepository, callSessionRepository } from '../db/repositories';
import type { AuthenticatedActor } from './authenticatedActor';
import { getRequestLogger } from '../middleware/requestContext';

export class CallLifecycleServiceError extends Error {
  status: number;
  code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'CallLifecycleServiceError';
    this.status = status;
    this.code = code;
  }
}

function invalidRequest(message: string): CallLifecycleServiceError {
  return new CallLifecycleServiceError(400, 'INVALID_STATE' as ErrorCode, message);
}

const CALL_HANDLING_EVENT_TYPES = new Set<CallHandlingEventType>([
  'fcm_received',
  'fcm_target_missing',
  'incoming_call_security_rejected',
  'incoming_call_accepted',
  'push_received',
  'foreground_service_start_requested',
  'foreground_service_received',
  'foreground_service_started',
  'incoming_ui_shown',
  'ringing_started',
  'answered',
  'declined',
  'incoming_suppressed',
  'expired',
  'notifications_disabled',
  'bootstrap_started',
  'bootstrap_success',
  'bootstrap_failed',
  'native_answer_start',
  'native_runtime_registered',
  'answer_sent',
  'telecom_reported',
  'telecom_failed',
  'busy',
  'call_finalized'
]);

async function assertKnownCallParticipant(actor: AuthenticatedActor, callSessionId: CallSessionId): Promise<void> {
  const callSession = await callSessionRepository.findByCallSessionId(actor.familyId, callSessionId);
  if (callSession) {
    if (!callSession.participants.includes(actor.identityId)) {
      throw new CallLifecycleServiceError(403, 'FORBIDDEN', 'Not a participant in this call');
    }
    return;
  }

  const callLog = await callHistoryRepository.findByCallSessionId(actor.familyId, callSessionId);
  if (!callLog) {
    throw new CallLifecycleServiceError(404, 'NOT_FOUND', 'Call session not found');
  }
  if (callLog.initiator_identity_id !== actor.identityId && callLog.target_identity_id !== actor.identityId) {
    throw new CallLifecycleServiceError(403, 'FORBIDDEN', 'Not a participant in this call');
  }
}

function sanitizeReasonCode(value: unknown): string | null {
  const reason = String(value || '').trim();
  if (!reason) return null;
  return reason.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
}

function mapHandlingEventToDeliveryStatus(report: CallHandlingEventReport): { status: CallDeliveryStatus; reason?: string | null } | null {
  switch (report.eventType) {
    case 'fcm_received':
    case 'incoming_call_accepted':
    case 'push_received':
    case 'foreground_service_start_requested':
    case 'foreground_service_received':
    case 'foreground_service_started':
    case 'telecom_reported':
    case 'incoming_ui_shown':
      return { status: 'delivered', reason: report.eventType };
    case 'incoming_call_security_rejected':
      return { status: 'failed', reason: report.reasonCode || report.eventType };
    case 'fcm_target_missing':
      return { status: 'could_not_reach_device', reason: report.reasonCode || report.eventType };
    case 'ringing_started':
      return { status: 'ringing', reason: report.reasonCode || report.eventType };
    case 'answered':
      return { status: 'answered', reason: report.reasonCode || report.eventType };
    case 'declined':
      return { status: 'declined', reason: report.reasonCode || report.eventType };
    case 'busy':
      return { status: 'busy', reason: report.reasonCode || report.eventType };
    case 'notifications_disabled':
      return { status: 'could_not_reach_device', reason: 'notifications_disabled' };
    case 'expired':
      return { status: 'could_not_reach_device', reason: report.reasonCode || report.eventType };
    case 'bootstrap_failed':
    case 'telecom_failed':
      return { status: 'failed', reason: report.reasonCode || report.eventType };
    case 'incoming_suppressed':
      if (report.reasonCode === 'locally_declined') return { status: 'declined', reason: report.reasonCode };
      return null;
    case 'call_finalized':
      return null;
    default:
      return null;
  }
}

export async function recordCallHandlingEventForActor(
  actor: AuthenticatedActor,
  payload: {
    callSessionId?: string;
    eventType?: string;
    occurredAt?: number;
    reasonCode?: string | null;
    blockingCallSessionId?: string | null;
  }
): Promise<{
  callerIdentityId: IdentityId;
  callSessionId: CallSessionId;
  status: CallDeliveryStatus;
  reason?: string | null;
  occurredAt: number;
  shouldEndCall?: boolean;
} | null> {
  const callSessionId = String(payload.callSessionId || '').trim() as CallSessionId;
  const eventType = String(payload.eventType || '').trim() as CallHandlingEventType;
  const occurredAt = Number(payload.occurredAt || 0);
  if (
    !callSessionId
    || !CALL_HANDLING_EVENT_TYPES.has(eventType)
    || !Number.isFinite(occurredAt)
    || occurredAt <= 0
  ) {
    throw invalidRequest('Invalid call handling event payload');
  }

  await assertKnownCallParticipant(actor, callSessionId);
  const report: CallHandlingEventReport = {
    callSessionId,
    eventType,
    occurredAt: Math.floor(occurredAt),
    reasonCode: sanitizeReasonCode(payload.reasonCode),
    blockingCallSessionId: eventType === 'busy'
      ? sanitizeReasonCode(payload.blockingCallSessionId)
      : null
  };
  await callHandlingEventRepository.save({
    familyId: actor.familyId,
    callSessionId,
    identityId: actor.identityId,
    deviceId: actor.deviceId,
    report
  });

  const deliveryStatus = mapHandlingEventToDeliveryStatus(report);
  if (!deliveryStatus) return null;

  const callLog = await callHistoryRepository.findByCallSessionId(actor.familyId, callSessionId);
  if (!callLog) return null;
  if (callLog.initiator_identity_id === actor.identityId) return null;

  const callSession = await callSessionRepository.findByCallSessionId(actor.familyId, callSessionId);
  // A late Android handling report must not mark an answered call as declined.
  if (
    deliveryStatus.status === 'declined' &&
    (!callSession || (callSession.state !== 'new' && callSession.state !== 'ringing'))
  ) return null;
  const shouldEndCall =
    report.eventType === 'busy' &&
    !!callSession &&
    (callSession.state === 'new' || callSession.state === 'ringing');
  if (shouldEndCall) {
    await callSessionRepository.end(actor.familyId, callSessionId);
    await callHistoryRepository.markRejected({
      familyId: actor.familyId,
      callSessionId,
      reason: 'busy'
    });
  }

  return {
    callerIdentityId: callLog.initiator_identity_id,
    callSessionId,
    status: deliveryStatus.status,
    reason: deliveryStatus.reason,
    occurredAt: report.occurredAt,
    shouldEndCall
  };
}

export async function markCallConnectedForActor(
  actor: AuthenticatedActor,
  payload: { callSessionId?: string; connectedAt?: number }
): Promise<void> {
  const callSessionId = String(payload.callSessionId || '').trim() as CallSessionId;
  const connectedAt = Number(payload.connectedAt || 0);
  if (!callSessionId || !Number.isFinite(connectedAt) || connectedAt <= 0) {
    throw invalidRequest('Invalid call connected payload');
  }

  const callSession = await callSessionRepository.findByCallSessionId(actor.familyId, callSessionId);
  if (!callSession) {
    throw new CallLifecycleServiceError(404, 'NOT_FOUND', 'Call session not found');
  }
  if (!callSession.participants.includes(actor.identityId)) {
    throw new CallLifecycleServiceError(403, 'FORBIDDEN', 'Not a participant in this call');
  }
  if (callSession.state !== 'accepted' && callSession.state !== 'active') {
    return;
  }
  await callHistoryRepository.markConnected({
    familyId: actor.familyId,
    callSessionId,
    connectedAt
  });
}

export async function markCallHeartbeatForActor(
  actor: AuthenticatedActor,
  payload: { callSessionId?: string; connectedAt?: number; sentAt?: number }
): Promise<void> {
  const callSessionId = String(payload.callSessionId || '').trim() as CallSessionId;
  const connectedAt = Number(payload.connectedAt || 0);
  const sentAt = Number(payload.sentAt || 0);
  if (
    !callSessionId
    || !Number.isFinite(connectedAt)
    || connectedAt <= 0
    || !Number.isFinite(sentAt)
    || sentAt <= 0
  ) {
    throw invalidRequest('Invalid call heartbeat payload');
  }

  const callSession = await callSessionRepository.findByCallSessionId(actor.familyId, callSessionId);
  if (!callSession) {
    throw new CallLifecycleServiceError(404, 'NOT_FOUND', 'Call session not found');
  }
  if (!callSession.participants.includes(actor.identityId)) {
    throw new CallLifecycleServiceError(403, 'FORBIDDEN', 'Not a participant in this call');
  }
  if (callSession.state !== 'accepted' && callSession.state !== 'active') {
    return;
  }
  await callHistoryRepository.markHeartbeat({
    familyId: actor.familyId,
    callSessionId,
    connectedAt,
    heartbeatAt: sentAt
  });
}

export async function finalizeCallForActor(
  actor: AuthenticatedActor,
  payload: {
    callSessionId?: string;
    endedAt?: number;
    finalStatus?: 'answered' | 'rejected' | 'ended' | 'failed' | string;
    durationSeconds?: number;
    reason?: string;
    diagnostics?: CallClientDiagnosticsReport;
  }
): Promise<void> {
  const callSessionId = String(payload.callSessionId || '').trim() as CallSessionId;
  const endedAt = Number(payload.endedAt || 0);
  const finalStatus = payload.finalStatus;
  if (
    !callSessionId
    || !Number.isFinite(endedAt)
    || endedAt <= 0
    || (finalStatus !== 'answered' && finalStatus !== 'rejected' && finalStatus !== 'ended' && finalStatus !== 'failed')
  ) {
    throw invalidRequest('Invalid call finalized payload');
  }

  const callSession = await callSessionRepository.findByCallSessionId(actor.familyId, callSessionId);
  if (!callSession) {
    throw new CallLifecycleServiceError(404, 'NOT_FOUND', 'Call session not found');
  }
  if (!callSession.participants.includes(actor.identityId)) {
    throw new CallLifecycleServiceError(403, 'FORBIDDEN', 'Not a participant in this call');
  }

  if (payload.diagnostics?.everConnected && payload.diagnostics.mediaConnectedAtMs) {
    await callHistoryRepository.recordMediaConnection({
      familyId: actor.familyId, callSessionId, connectedAt: payload.diagnostics.mediaConnectedAtMs
    });
  }

  // call:finalized is a client lifecycle/diagnostics report, not an authority to
  // terminate the server call session. Actual terminal intent must arrive as
  // call:cancel, call:decline, or call:hangup so sibling-device cleanup cannot
  // accidentally end a live call.
  if (callSession.state === 'ended' || callSession.state === 'expired' || callSession.state === 'failed') {
    await callHistoryRepository.markFinalized({
      familyId: actor.familyId,
      callSessionId,
      endedAt,
      finalStatus,
      durationSeconds: payload.durationSeconds,
      reason: payload.reason
    });
  }

  if (payload.diagnostics) {
    try {
      const diagnosticsRecordedAt = await callClientDiagnosticsRepository.save({
        familyId: actor.familyId,
        callSessionId,
        identityId: actor.identityId,
        deviceId: actor.deviceId,
        report: payload.diagnostics
      });
      void callQualityDailyRepository.refreshDay(actor.familyId, diagnosticsRecordedAt).catch((error) => {
        getRequestLogger({ subsystem: 'call_lifecycle' }).warn(
          'call_quality_daily_refresh_failed',
          {
            familyId: actor.familyId,
            callSessionId,
            error
          }
        );
      });
    } catch (error) {
      // Diagnostics are best-effort — never let a malformed/failed report block call finalization.
      getRequestLogger({ subsystem: 'call_lifecycle' }).warn(
        'call_client_diagnostics_persist_failed',
        {
          familyId: actor.familyId,
          callSessionId,
          identityId: actor.identityId,
          deviceId: actor.deviceId,
          error
        }
      );
    }
  }
}
