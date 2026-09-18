import { createHash } from 'crypto';
import type { FindByCallSessionIdResult } from '../db/repositories/callSessionRepository.queries';
import {
  callHandlingEventRepository,
  callHistoryRepository,
  callSessionRepository,
  systemEventRepository
} from '../db/repositories';
import { classifyCallerCancellation } from './callCancellationOutcomePolicy';
import type { CallTerminationContext } from './callTerminationPolicy';
import { configService } from './configService';
import type { CallSessionId, IdentityId } from '@shared/types';
import { getRequestLogger } from '../middleware/requestContext';
import { resolveCallLinkPresentation } from './callSessionPresentation';

export function stableMissedCallEventId(
  familyId: string,
  callSessionId: CallSessionId,
  recipientIdentityId: IdentityId
): string {
  const stable = createHash('sha256')
    .update(`${familyId}:${callSessionId}:${recipientIdentityId}:call:missed`)
    .digest('hex')
    .slice(0, 24);
  return `sev_missed_${stable}`;
}

export async function persistCallTermination(params: {
  familyId: string;
  callSessionId: CallSessionId;
  callSession: FindByCallSessionIdResult;
  context: CallTerminationContext;
  terminationAt: number;
  cancellationDeliveredGraceMs: number;
  cancellationNoDeliveryFallbackMs: number;
  afterSessionEnded: () => void;
}): Promise<{ historyEndReason: string }> {
  await callSessionRepository.end(params.familyId, params.callSessionId);
  params.afterSessionEnded();

  let historyEndReason = params.context.endReason;
  const recipientIdentityId = params.context.cancelledRecipientIdentityId as IdentityId | undefined;
  if (recipientIdentityId) {
    let handlingEvents: Awaited<ReturnType<typeof callHandlingEventRepository.listByCallSession>> = [];
    try {
      handlingEvents = await callHandlingEventRepository.listByCallSession(
        params.familyId,
        params.callSessionId
      );
    } catch (error) {
      getRequestLogger({ subsystem: 'call_termination' }).warn(
        'call_cancellation_delivery_evidence_load_failed',
        { familyId: params.familyId, callSessionId: params.callSessionId, error }
      );
    }
    const cancellationOutcome = classifyCallerCancellation({
      callCreatedAt: params.callSession.created_at.getTime(),
      endedAt: params.terminationAt,
      recipientIdentityId,
      handlingEvents: handlingEvents.map((event) => ({
        identityId: event.identity_id,
        eventType: event.event_type,
        recordedAt: event.recorded_at
      })),
      deliveredGraceMs: params.cancellationDeliveredGraceMs,
      noDeliveryFallbackMs: params.cancellationNoDeliveryFallbackMs
    });
    historyEndReason = cancellationOutcome.reason;
    getRequestLogger({ subsystem: 'call_termination' }).info(
      'call_cancellation_history_outcome_resolved',
      {
        familyId: params.familyId,
        callSessionId: params.callSessionId,
        reason: historyEndReason,
        evidence: cancellationOutcome.evidence,
        totalWaitMs: cancellationOutcome.totalWaitMs,
        waitAfterReachMs: cancellationOutcome.waitAfterReachMs,
        reachedAt: cancellationOutcome.reachedAt
      }
    );

    const familyConfig = await configService.requireFamilyConfig(params.familyId);
    const circleId = familyConfig.circle_id;
    const callLinkPresentation = resolveCallLinkPresentation(params.callSession);
    await systemEventRepository.insertEvent({
      eventId: stableMissedCallEventId(params.familyId, params.callSessionId, recipientIdentityId),
      familyId: params.familyId,
      recipientIdentityId,
      circleId,
      type: 'call:missed',
      payload: {
        callSessionId: params.callSessionId,
        remoteIdentityId: params.callSession.initiator as IdentityId,
        direction: 'incoming',
        reason: 'unknown',
        isTemporaryLinkCall: callLinkPresentation.isTemporaryLinkCall,
        callLinkTitle: callLinkPresentation.callLinkTitle,
        callCreatedAt: params.callSession.created_at?.getTime?.()
          ? params.callSession.created_at.getTime()
          : undefined
      },
      createdAt: Date.now()
    });
    await callHistoryRepository.markMissed({
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      reason: historyEndReason
    });
  }

  if (params.context.kind === 'decline') {
    await callHistoryRepository.markRejected({
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      reason: params.context.endReason
    });
  }

  if (params.context.connectedCallState) {
    await callHistoryRepository.markFinalized({
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      endedAt: Date.now(),
      finalStatus: 'ended',
      reason: params.context.endReason
    });
  } else if (!params.context.ringingCallState) {
    await callHistoryRepository.markFinalized({
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      endedAt: Date.now(),
      finalStatus: 'failed',
      reason: params.context.endReason
    });
  }

  return { historyEndReason };
}
