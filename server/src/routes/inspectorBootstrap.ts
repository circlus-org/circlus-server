import cors from 'cors';
import { Router } from 'express';
import type { ErrorCode } from '@shared/types';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';
import { circleInspectorRepository } from '../db/repositories/circleInspectorRepository';
import { query } from '../db';
import { createCorsOptions } from '../middleware/security';
import type { AuthRequest } from '../middleware/auth';
import { routeLogger } from '../utils/routeLogger';
import {
  buildApproveUrl,
  createToken,
  jsonError,
  jsonOk,
  tokenHash,
  verifyTokenHash
} from './inspectorSupport';

const router = Router();
const REQUEST_TTL_MS = 10 * 60 * 1000;
const bootstrapCors = cors(createCorsOptions());

router.options('/requests', bootstrapCors);
router.options('/requests/:requestId', bootstrapCors);

router.post('/requests', bootstrapCors, async (req: AuthRequest, res) => {
  try {
    const now = Date.now();
    const requestToken = createToken('circt');
    const viewerLabel = typeof req.body?.viewerLabel === 'string'
      ? req.body.viewerLabel.trim().slice(0, 120) || null
      : null;
    const request = await circleInspectorRepository.createUnboundRequest({
      requestTokenHash: tokenHash(requestToken),
      viewerLabel,
      now,
      expiresAt: now + REQUEST_TTL_MS
    });

    return jsonOk(res, {
      requestId: request.request_id,
      requestToken,
      approveUrl: await buildApproveUrl(req, request.request_id, requestToken),
      status: request.status,
      expiresAt: request.expires_at,
      vpsId: getServerIdentityRuntimeConfig().vpsId
    });
  } catch (error) {
    routeLogger.error('Create unbound inspector request error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

router.get('/requests/:requestId', bootstrapCors, async (req: AuthRequest, res) => {
  try {
    const requestId = String(req.params.requestId || '');
    // Header only: a query parameter would put the pickup key into access logs.
    const requestToken = String(req.headers['x-inspector-request-token'] || '');
    const request = await circleInspectorRepository.findRequestById(requestId);
    if (!request || !verifyTokenHash(requestToken, request.request_token_hash)) {
      return jsonError(res, 404, 'NOT_FOUND' as ErrorCode, 'Inspector request not found');
    }

    const common = {
      requestId,
      expiresAt: request.expires_at,
      vpsId: getServerIdentityRuntimeConfig().vpsId
    };
    if (request.status === 'pending' && request.expires_at <= Date.now()) {
      return jsonOk(res, { ...common, status: 'expired' });
    }
    if (request.status !== 'approved' || !request.family_id) {
      return jsonOk(res, {
        ...common,
        status: request.status,
        approvedAt: request.approved_at
      });
    }

    // Delivered once, and only to a caller that asks for the pickup. The
    // approving owner reads the same request for status, and reopening the
    // approve link must not consume the waiting Inspector's credential.
    const wantsSessionToken = String(req.headers['x-inspector-session-pickup'] || '') === '1';
    const [session, circleResult] = await Promise.all([
      circleInspectorRepository.findSessionForRequestId(requestId),
      query<{ circle_id: string; server_name: string | null; server_url: string | null }>(
        `SELECT fc.circle_id, fc.server_name,
                COALESCE((SELECT fd.public_base_url FROM family_domains fd
                 WHERE fd.family_id = fc.family_id AND fd.status = 'active'
                 ORDER BY fd.is_current DESC, fd.created_at DESC LIMIT 1), fc.public_base_url) AS server_url
         FROM family_config fc WHERE fc.family_id = $1`,
        [request.family_id]
      )
    ]);
    const circle = circleResult.rows[0];
    // Resolve the Circle context before consuming the one-time credential.
    // A transient database error must not strand an approved request.
    const sessionToken = wantsSessionToken && circle?.circle_id
      ? await circleInspectorRepository.consumeSessionTokenHandoff(requestId, Date.now())
      : null;
    return jsonOk(res, {
      ...common,
      status: request.status,
      approvedAt: request.approved_at,
      circleId: circle?.circle_id || null,
      circleName: circle?.server_name || null,
      serverUrl: circle?.server_url || null,
      sessionExpiresAt: session?.expires_at ?? null,
      sessionToken,
      // Tells a caller that arrives after the single pickup to start over
      // instead of polling for a token it will never receive.
      sessionTokenClaimed: wantsSessionToken && Boolean(session) && Boolean(circle?.circle_id) && !sessionToken
    });
  } catch (error) {
    routeLogger.error('Read unbound inspector request error:', error);
    return jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
});

export default router;
