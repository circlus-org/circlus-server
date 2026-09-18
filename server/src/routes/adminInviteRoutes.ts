import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { verifySignature, requireActiveIdentity, requireAdmin, type AuthRequest } from '../middleware/auth';
import type { ApiResponse } from '../../../shared/types';
import { inviteRepository } from '../db/repositories';
import { sendApiError } from '../utils/apiResponses';
import { query } from '../db';

const router = Router();
router.post(
  '/invites',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;

      if (!familyId) {
        return sendApiError(res, 500, 'MISSING_FAMILY_ID', 'Family context not set');
      }

      const invites = await inviteRepository.findAll(familyId);
      const acceptances = await query<{
        invite_id: string;
        accepted_by_identity_id: string;
        accepted_at: Date;
      }>(
        `SELECT invite_id, accepted_by_identity_id, accepted_at
           FROM invite_acceptances
          WHERE family_id = $1
          ORDER BY accepted_at DESC`,
        [familyId]
      );
      const acceptancesByInviteId = new Map<string, Array<{ identityId: string; acceptedAt: string }>>();
      for (const acceptance of acceptances.rows) {
        const current = acceptancesByInviteId.get(acceptance.invite_id) || [];
        current.push({
          identityId: acceptance.accepted_by_identity_id,
          acceptedAt: acceptance.accepted_at.toISOString()
        });
        acceptancesByInviteId.set(acceptance.invite_id, current);
      }

      return res.json({
        status: 'ok',
        result: {
          invites: invites.map(i => ({
            inviteId: i.invite_id,
            createdBy: i.created_by,
            createdAt: i.created_at.toISOString(),
            expiresAt: i.expires_at.toISOString(),
            maxUses: i.max_uses,
            usedCount: i.used_count,
            status: i.status,
            reusable: (i as typeof i & { capability_mode?: string | null }).capability_mode === 'unlimited'
              || i.max_uses > 1,
            acceptances: acceptancesByInviteId.get(i.invite_id) || []
          }))
        }
      } as ApiResponse);

    } catch (error) {
      routeLogger.error('Get invites error:', error);
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to get invites');
    }
  }
);

/**
 * Revoke invite (admin only)
 */
router.post(
  '/invites/:inviteId/revoke',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const { inviteId } = req.params;
      const familyId = req.familyId;

      if (!familyId) {
        return sendApiError(res, 500, 'MISSING_FAMILY_ID', 'Family context not set');
      }

      const updated = await inviteRepository.updateStatus(familyId, inviteId, 'revoked');

      if (!updated) {
        return sendApiError(res, 404, 'NOT_FOUND', 'Invite not found');
      }

      return res.json({
        status: 'ok',
        result: {
          inviteId: updated.invite_id,
          status: updated.status
        }
      } as ApiResponse);

    } catch (error) {
      routeLogger.error('Revoke invite error:', error);
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to revoke invite');
    }
  }
);


export default router;
