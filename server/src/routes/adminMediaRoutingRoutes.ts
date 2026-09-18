import { Router } from 'express';
import type { ApiResponse } from '../../../shared/types';
import {
  getSignedPayload,
  requireActiveIdentity,
  requireAdmin,
  verifySignature,
  type AuthRequest
} from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import {
  circleMediaRoutingService,
  CircleMediaRoutingValidationError,
  type CircleMediaRoutingConfiguration
} from '../services/circleMediaRoutingService';
import { routeLogger } from '../utils/routeLogger';

const router = Router();

router.post(
  '/media-routing',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest<Record<string, never>> & TenancyRequest, res) => {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
      } as ApiResponse);
    }
    try {
      const result = await circleMediaRoutingService.getConfiguration(familyId);
      return res.json({ status: 'ok', result } as ApiResponse<CircleMediaRoutingConfiguration>);
    } catch (error) {
      routeLogger.error('Error getting Circle media routing settings:', error);
      return res.status(503).json({
        status: 'error',
        error: { code: 'ICE_CONFIG_UNAVAILABLE', message: 'Failed to retrieve media routing settings' }
      } as ApiResponse);
    }
  }
);

router.put(
  '/media-routing',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest<{ strategy?: unknown; turnClusterId?: unknown }> & TenancyRequest, res) => {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
      } as ApiResponse);
    }
    const payload = getSignedPayload<{ strategy?: unknown; turnClusterId?: unknown }>(req);
    try {
      const result = await circleMediaRoutingService.updateSettings({
        familyId,
        strategy: payload.strategy,
        turnClusterId: payload.turnClusterId
      });
      return res.json({ status: 'ok', result } as ApiResponse<CircleMediaRoutingConfiguration>);
    } catch (error) {
      if (error instanceof CircleMediaRoutingValidationError) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: error.message }
        } as ApiResponse);
      }
      routeLogger.error('Error updating Circle media routing settings:', error);
      return res.status(503).json({
        status: 'error',
        error: { code: 'ICE_CONFIG_UNAVAILABLE', message: 'Failed to update media routing settings' }
      } as ApiResponse);
    }
  }
);

export default router;
