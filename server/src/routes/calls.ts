import { reliableOperation } from '../services/reliableOperation';
import { recordExternalCallDiagnostics } from '../services/externalCallDiagnostics';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { routeLogger } from '../utils/routeLogger';
import { Router, type Response } from 'express';
import { verifySignature, requireActiveIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import type { ApiResponse, CallClientDiagnosticsReport, ErrorCode, WSCallHistorySyncResultData } from '../../../shared/types';
import { authenticatedActorFromHttpRequest } from '../services/authenticatedActor';
import {
  CallLifecycleServiceError,
  finalizeCallForActor,
  markCallConnectedForActor,
  recordCallHandlingEventForActor
} from '../services/callLifecycleService';
import {
  ackCallHistorySyncForActor,
  CallHistoryServiceError,
  listCallHistoryForActor,
  markMissedCallsSeenForActor
} from '../services/callHistoryService';
import { sendCallDeliveryStatusWs, sendToIdentityWs } from '../ws/wsGateway';

const router = Router();

router.post('/external-diagnostics', createRateLimiter({
  name: 'calls:external-diagnostics', windowMs: 60_000, max: 30, keyFn: ipFamilyKey
}), async (req: AuthRequest, res) => {
  try {
    if (!req.familyId) return res.status(400).json(errorResponse('INVALID_STATE', 'Family context required'));
    await recordExternalCallDiagnostics(req.familyId, req.body);
    return res.json({ status: 'ok', result: null });
  } catch (error) {
    return handleServiceError(res, error, 'Failed to record external call diagnostics');
  }
});

function errorResponse(code: ErrorCode, message: string): ApiResponse {
  return {
    status: 'error',
    error: { code, message }
  };
}

function handleServiceError(res: Response, error: unknown, label: string) {
  if (error instanceof CallLifecycleServiceError || error instanceof CallHistoryServiceError) {
    return res.status(error.status).json(errorResponse(error.code, error.message));
  }

  routeLogger.error(`${label} failed`, error);
  return res.status(500).json(errorResponse('INTERNAL_ERROR' as ErrorCode, label));
}

router.post('/connected', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const actor = authenticatedActorFromHttpRequest(req);
    if (!actor) {
      res.status(401).json(errorResponse('UNAUTHORIZED' as ErrorCode, 'Authentication required'));
      return;
    }
    const payload = getSignedPayload<{ callSessionId?: string; connectedAt?: number }>(req);
    await markCallConnectedForActor(actor, payload);
    res.json({ status: 'ok', result: null } satisfies ApiResponse<null>);
  } catch (error) {
    return handleServiceError(res, error, 'Failed to mark call connected');
  }
});

router.post('/finalized', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const actor = authenticatedActorFromHttpRequest(req);
    if (!actor) {
      res.status(401).json(errorResponse('UNAUTHORIZED' as ErrorCode, 'Authentication required'));
      return;
    }
    const payload = getSignedPayload<{
      callSessionId?: string;
      endedAt?: number;
      finalStatus?: 'answered' | 'rejected' | 'ended' | 'failed' | string;
      durationSeconds?: number;
      reason?: string;
      diagnostics?: CallClientDiagnosticsReport;
    }>(req);
    await finalizeCallForActor(actor, payload);
    res.json({ status: 'ok', result: null } satisfies ApiResponse<null>);
  } catch (error) {
    return handleServiceError(res, error, 'Failed to finalize call');
  }
});

router.post('/handling-event', verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const actor = authenticatedActorFromHttpRequest(req);
    if (!actor) {
      res.status(401).json(errorResponse('UNAUTHORIZED' as ErrorCode, 'Authentication required'));
      return;
    }
    const payload = getSignedPayload<{
      callSessionId?: string;
      eventType?: string;
      occurredAt?: number;
      reasonCode?: string | null;
    }>(req);
    const deliveryStatus = await recordCallHandlingEventForActor(actor, payload);
    if (deliveryStatus) {
      sendCallDeliveryStatusWs({
        familyId: actor.familyId,
        callerIdentityId: deliveryStatus.callerIdentityId,
        callSessionId: deliveryStatus.callSessionId,
        status: deliveryStatus.status,
        reason: deliveryStatus.reason,
        occurredAt: deliveryStatus.occurredAt
      });
      if (deliveryStatus.shouldEndCall) {
        const endReason = deliveryStatus.status === 'busy'
          ? 'busy'
          : deliveryStatus.reason || deliveryStatus.status;
        sendToIdentityWs(actor.familyId, deliveryStatus.callerIdentityId, {
          type: 'call:ended',
          data: {
            callSessionId: deliveryStatus.callSessionId,
            reason: endReason
          },
          timestamp: Date.now()
        });
      }
    }
    res.json({ status: 'ok', result: null } satisfies ApiResponse<null>);
  } catch (error) {
    return handleServiceError(res, error, 'Failed to record call handling event');
  }
}));

router.post('/history/list', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const actor = authenticatedActorFromHttpRequest(req);
    if (!actor) {
      res.status(401).json(errorResponse('UNAUTHORIZED' as ErrorCode, 'Authentication required'));
      return;
    }

    const payload = getSignedPayload<{ since?: number; limit?: number }>(req);
    const result = await listCallHistoryForActor(actor, payload);
    res.json({
      status: 'ok',
      result
    } satisfies ApiResponse<WSCallHistorySyncResultData>);
  } catch (error) {
    return handleServiceError(res, error, 'Failed to list call history');
  }
});

router.post('/history/ack', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const actor = authenticatedActorFromHttpRequest(req);
    if (!actor) {
      res.status(401).json(errorResponse('UNAUTHORIZED' as ErrorCode, 'Authentication required'));
      return;
    }

    const payload = getSignedPayload<{ syncedThrough?: number }>(req);
    await ackCallHistorySyncForActor(actor, payload);
    res.json({ status: 'ok', result: null } satisfies ApiResponse<null>);
  } catch (error) {
    return handleServiceError(res, error, 'Failed to ack call history');
  }
});

router.post('/history/mark-missed-seen', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const actor = authenticatedActorFromHttpRequest(req);
    if (!actor) {
      res.status(401).json(errorResponse('UNAUTHORIZED' as ErrorCode, 'Authentication required'));
      return;
    }

    const payload = getSignedPayload<{
      callSessionIds?: string[];
      peerIdentityId?: string;
      seenAt?: number;
    }>(req);
    await markMissedCallsSeenForActor(actor, payload);
    res.json({ status: 'ok', result: null } satisfies ApiResponse<null>);
  } catch (error) {
    return handleServiceError(res, error, 'Failed to mark missed calls seen');
  }
});

export default router;
