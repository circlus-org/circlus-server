import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

const router = Router();

/**
 * Get VPS identifier for this server.
 * Requires an authenticated member or owner identity (guests are not allowed).
 */
router.post('/vps-id', verifySignature, requireActiveIdentity, requireFullCircleIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: { vpsId: getServerIdentityRuntimeConfig().vpsId }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Get VPS ID error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

export default router;
