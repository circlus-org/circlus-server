import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { identityRepository } from '../db/repositories';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity, getSignedPayload } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type { ApiResponse, ErrorCode, IdentityId } from '../../../shared/types';

const router = Router();

const MAX_STATUS_LENGTH = 280; // Like Twitter

/**
 * Set user status for current identity
 */
router.post('/set', verifySignature, requireActiveIdentity, requireFullCircleIdentity, async (req: AuthRequest<{ statusText?: string | null }>, res) => {
  try {
    const { statusText } = getSignedPayload<{ statusText?: string | null }>(req);
    const identityId = req.device!.identityId;
    const familyId = req.familyId;

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    // Validate status text
    if (statusText !== null && statusText !== undefined) {
      if (typeof statusText !== 'string') {
        return res.status(400).json({
          status: 'error',
          error: {
            code: 'INVALID_STATE' as ErrorCode,
            message: 'Status must be a string'
          }
        } as ApiResponse);
      }

      if (statusText.length > MAX_STATUS_LENGTH) {
        return res.status(400).json({
          status: 'error',
          error: {
            code: 'INVALID_STATE' as ErrorCode,
            message: `Status text too long (max ${MAX_STATUS_LENGTH} characters)`
          }
        } as ApiResponse);
      }
    }

    // Update status
    await identityRepository.updateStatusText(
      familyId,
      identityId,
      statusText === '' ? null : (statusText ?? null)
    );

    return res.json({
      status: 'ok',
      result: {
        statusText: statusText === '' ? null : statusText,
        statusUpdatedAt: new Date().toISOString()
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Set status error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
});

/**
 * Get statuses for multiple identities
 * Used by client to fetch contact statuses
 */
router.post('/get', verifySignature, requireActiveIdentity, requireFullCircleIdentity, async (req: AuthRequest<{ identityIds?: unknown[] }>, res) => {
  try {
    const { identityIds } = getSignedPayload<{ identityIds?: unknown[] }>(req);
    const familyId = req.familyId;

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    if (!Array.isArray(identityIds)) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'identityIds must be an array'
        }
      } as ApiResponse);
    }

    // Limit to 100 identities per request
    if (identityIds.length > 100) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Maximum 100 identities per request'
        }
      } as ApiResponse);
    }

    // Get statuses
    const statusMap = await identityRepository.getStatuses(familyId, identityIds as IdentityId[]);

    // Convert Map to object for JSON response
    const statuses: Record<string, {
      statusText: string | null;
      statusUpdatedAt: string | null;
      avatarBlobId: string | null;
      presence: {
        visibility: 'visible' | 'hidden';
        isOnline: boolean;
        lastSeenAt: string | null;
        onlineUntil: string | null;
      };
    }> = {};
    for (const [identityId, statusData] of statusMap.entries()) {
      statuses[identityId] = {
        statusText: statusData.statusText,
        statusUpdatedAt: statusData.statusUpdatedAt ? statusData.statusUpdatedAt.toISOString() : null,
        avatarBlobId: statusData.avatarBlobId,
        presence: {
          visibility: statusData.presenceVisible ? 'visible' : 'hidden',
          isOnline: statusData.isOnline,
          lastSeenAt: statusData.lastSeenAt ? statusData.lastSeenAt.toISOString() : null,
          onlineUntil: statusData.onlineUntil ? statusData.onlineUntil.toISOString() : null
        }
      };
    }

    return res.json({
      status: 'ok',
      result: { statuses }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Get statuses error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
});

/**
 * Get own status
 */
router.post('/my', verifySignature, requireActiveIdentity, requireFullCircleIdentity, async (req: AuthRequest, res) => {
  try {
    const identityId = req.device!.identityId;
    const familyId = req.familyId;

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const identity = await identityRepository.findByIdentityId(familyId, identityId);

    if (!identity) {
      return res.status(404).json({
        status: 'error',
        error: {
          code: 'NOT_FOUND' as ErrorCode,
          message: 'Identity not found'
        }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        statusText: identity.status_text,
        statusUpdatedAt: identity.status_updated_at ? identity.status_updated_at.toISOString() : null,
        avatarBlobId: (identity as any).avatar_blob_id ?? null
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Get my status error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
});

/**
 * Explicit foreground-presence heartbeat. Authentication still touches the
 * device's technical last_seen_at, while this route alone advances the
 * user-visible presence timestamp.
 */
router.post('/heartbeat', verifySignature, requireActiveIdentity, async (req: AuthRequest<{ foreground?: boolean }>, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Presence context is missing'
        }
      } as ApiResponse);
    }

    const payload = getSignedPayload<{ foreground?: boolean }>(req);
    if (payload.foreground !== true) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Foreground presence assertion is required'
        }
      } as ApiResponse);
    }

    const touchedAt = await identityRepository.touchForegroundPresence(familyId, identityId);
    if (!touchedAt) {
      return res.status(404).json({
        status: 'error',
        error: {
          code: 'NOT_FOUND' as ErrorCode,
          message: 'Identity not found'
        }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        at: touchedAt.toISOString()
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Presence heartbeat error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
});

export default router;
