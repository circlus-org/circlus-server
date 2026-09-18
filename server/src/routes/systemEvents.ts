import { routeLogger } from '../utils/routeLogger';
import { Router, type Response } from 'express';
import { verifySignature, requireActiveIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import type { ApiResponse, ErrorCode, WSSystemSyncResultData } from '../../../shared/types';
import { authenticatedActorFromHttpRequest } from '../services/authenticatedActor';
import {
  SystemEventsServiceError,
  ackSystemEventsForActor,
  listSystemEventsForActor
} from '../services/systemEventsService';

const router = Router();

function errorResponse(code: ErrorCode, message: string): ApiResponse {
  return {
    status: 'error',
    error: { code, message }
  };
}

function handleServiceError(res: Response, error: unknown, label: string) {
  if (error instanceof SystemEventsServiceError) {
    return res.status(error.status).json(errorResponse(error.code, error.message));
  }

  routeLogger.error(`${label} failed`, error);
  return res.status(500).json(errorResponse('INTERNAL_ERROR' as ErrorCode, label));
}

router.post('/list', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const actor = authenticatedActorFromHttpRequest(req);
    if (!actor) {
      res.status(401).json(errorResponse('UNAUTHORIZED' as ErrorCode, 'Authentication required'));
      return;
    }

    const result = await listSystemEventsForActor(actor, getSignedPayload<{ since?: number; limit?: number }>(req));
    res.json({ status: 'ok', result } satisfies ApiResponse<WSSystemSyncResultData>);
  } catch (error) {
    return handleServiceError(res, error, 'Failed to list system events');
  }
});

router.post('/ack', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const actor = authenticatedActorFromHttpRequest(req);
    if (!actor) {
      res.status(401).json(errorResponse('UNAUTHORIZED' as ErrorCode, 'Authentication required'));
      return;
    }

    await ackSystemEventsForActor(actor, getSignedPayload<{ syncedThrough?: number }>(req));
    res.json({ status: 'ok', result: null } satisfies ApiResponse<null>);
  } catch (error) {
    return handleServiceError(res, error, 'Failed to ack system events');
  }
});

export default router;
