import { versionedAccessOperation } from '../services/versionedAccessOperation';
import { redeemClaim, ClaimRedemptionError } from '../services/claimRedemption';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  getSignedPayload,
  requireActiveIdentity,
  requireServerAdmin,
  verifySignature,
  type AuthRequest
} from '../middleware/auth';
import {
  familyConfigRepository,
  identityRepository,
  serverAdminRepository
} from '../db/repositories';
import { hashClaimToken } from '../utils/claimTokens';
import { getCircleAddressRuntimeConfig } from '../config/serverRuntimeConfig';

const router = Router();
const MAX_ADMIN_DISPLAY_NAME_LENGTH = 160;

function normalizeAdminDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, MAX_ADMIN_DISPLAY_NAME_LENGTH) : null;
}

function defaultAdminDisplayName(
  _identityName: string | null | undefined,
  circleName: string,
  identityId: string
): string {
  return `${identityId} · ${circleName}`;
}

router.post(
  '/status',
  verifySignature,
  requireActiveIdentity,
  async (req: AuthRequest, res) => {
    try {
      const identityId = req.identity?.identityId;
      if (!identityId) {
        return res.status(401).json({ status: 'error', error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      }

      const serverAdmin = await serverAdminRepository.findActiveByIdentityId(identityId);
      const managedWildcardAvailable = Boolean(
        getCircleAddressRuntimeConfig().managedWildcardBaseDomain
      );
      return res.json({
        status: 'ok',
        result: {
          isServerAdmin: !!serverAdmin,
          managedWildcardAvailable,
          serverAdmin: serverAdmin
            ? {
                serverAdminId: serverAdmin.server_admin_id,
                identityId: serverAdmin.principal_identity_id,
                grantedAt: serverAdmin.granted_at
              }
            : null
        }
      });
    } catch (error) {
      routeLogger.error('Get server admin status error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to get server admin status' } });
    }
  }
);

router.post(
  '/claims/redeem',
  verifySignature,
  requireActiveIdentity,
  async (req: AuthRequest<{ claimToken?: string; displayName?: string }>, res) => {
    try {
      const identityId = req.identity?.identityId;
      const { claimToken: rawClaimToken, displayName: rawDisplayName } = getSignedPayload<{ claimToken?: string; displayName?: string }>(req);
      const claimToken = String(rawClaimToken || '').trim();
      const displayName = normalizeAdminDisplayName(rawDisplayName);

      if (!identityId) {
        return res.status(401).json({ status: 'error', error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      }
      if (!claimToken) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'claimToken is required' } });
      }

      const tokenHash = hashClaimToken(claimToken);
      const result = await redeemClaim('admin', tokenHash, identityId, req.familyId!, async () => {
      const serverAdmin = await serverAdminRepository.grantToIdentity({
        identityId,
        grantedVia: 'recovery',
        displayName
      });


      return {
        status: 'ok',
        result: {
          serverAdmin: {
            serverAdminId: serverAdmin.server_admin_id,
            identityId: serverAdmin.principal_identity_id,
            grantedAt: serverAdmin.granted_at
          }
        }
      };
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof ClaimRedemptionError) return res.status(error.status).json({status:'error',error:{code:'INVALID_STATE',message:error.message}});
      routeLogger.error('Redeem server admin claim error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to redeem server admin claim' } });
    }
  }
);

router.post(
  '/admins/list',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (_req: AuthRequest, res) => {
    try {
      const admins = await serverAdminRepository.listActiveDetailed();
      return res.json({
        status: 'ok',
        result: {
          admins: admins.map((admin) => ({
            serverAdminId: admin.server_admin_id,
            identityId: admin.principal_identity_id,
            displayName: admin.display_name || defaultAdminDisplayName(
              admin.identity_name,
              admin.carrier_circle_name,
              admin.principal_identity_id
            ),
            carrierFamilyId: admin.carrier_family_id,
            carrierCircleName: admin.carrier_circle_name,
            activeDeviceCount: admin.active_device_count,
            grantedAt: admin.granted_at,
            grantedVia: admin.granted_via,
            grantedByServerAdminId: admin.granted_by_server_admin_id
          }))
        }
      });
    } catch (error) {
      routeLogger.error('List server admins error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to list server admins' } });
    }
  }
);

router.post(
  '/admins/candidates',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId) {
        return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Family context is missing' } });
      }
      const config = await familyConfigRepository.findByFamilyId(familyId);
      if (!config) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Circle not found' } });
      }
      const identities = await serverAdminRepository.listEligibleCandidatesDetailed();
      const activeAdmins = new Set((await serverAdminRepository.listActive()).map((admin) => admin.principal_identity_id));
      return res.json({
        status: 'ok',
        result: {
          circle: { familyId, name: config.server_name },
          candidates: identities
            .map((identity) => ({
              identityId: identity.identity_id,
              identityName: null,
              role: identity.role,
              familyId: identity.family_id,
              circleName: identity.circle_name,
              alreadyServerAdmin: activeAdmins.has(identity.identity_id),
              defaultDisplayName: defaultAdminDisplayName(null, identity.circle_name, identity.identity_id)
            }))
        }
      });
    } catch (error) {
      routeLogger.error('List server admin candidates error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to list server admin candidates' } });
    }
  }
);

router.post(
  '/admins/grant',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  versionedAccessOperation(async (req: AuthRequest<{ familyId?: string; identityId?: string; displayName?: string }>, res) => {
    try {
      const {
        familyId: rawTargetFamilyId,
        identityId: rawIdentityId,
        displayName: rawDisplayName
      } = getSignedPayload<{ familyId?: string; identityId?: string; displayName?: string }>(req);
      const familyId = String(rawTargetFamilyId || '').trim();
      const identityId = String(rawIdentityId || '').trim();
      if (!familyId || !identityId) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'familyId and identityId are required' } });
      }
      const [target, config, existing] = await Promise.all([
        identityRepository.findByIdentityId(familyId, identityId),
        familyConfigRepository.findByFamilyId(familyId),
        serverAdminRepository.findActiveByIdentityId(identityId)
      ]);
      if (!target || !config || config.status !== 'active' || target.status !== 'active' || (target.role !== 'owner' && target.role !== 'member')) {
        return res.status(409).json({
          status: 'error',
          error: { code: 'INVALID_STATE', message: 'New server admin must be an active owner or member of an active Circle on this server' }
        });
      }
      if (existing) {
        return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Profile already has server admin access' } });
      }
      const displayName = normalizeAdminDisplayName(rawDisplayName)
        || defaultAdminDisplayName(null, config.server_name, target.identity_id);
      const granted = await serverAdminRepository.grantToIdentity({
        identityId: target.identity_id,
        grantedVia: 'admin_grant',
        grantedByServerAdminId: req.serverAdmin!.serverAdminId,
        displayName
      });
      return res.json({
        status: 'ok',
        result: {
          serverAdminId: granted.server_admin_id,
          identityId: granted.principal_identity_id,
          displayName,
          carrierFamilyId: familyId,
          carrierCircleName: config.server_name,
          grantedAt: granted.granted_at,
          grantedVia: granted.granted_via
        }
      });
    } catch (error) {
      routeLogger.error('Grant server admin error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to grant server admin access' } });
    }
  })
);

router.post(
  '/admins/:serverAdminId/rename',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest<{ displayName?: string }>, res) => {
    try {
      const serverAdminId = String(req.params.serverAdminId || '').trim();
      const { displayName: rawDisplayName } = getSignedPayload<{ displayName?: string }>(req);
      const displayName = normalizeAdminDisplayName(rawDisplayName);
      if (!serverAdminId || !displayName) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'A non-empty displayName is required' } });
      }
      const updated = await serverAdminRepository.updateDisplayName(serverAdminId, displayName);
      if (!updated) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Active server admin not found' } });
      }
      return res.json({ status: 'ok', result: { serverAdminId, displayName } });
    } catch (error) {
      routeLogger.error('Rename server admin error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to rename server admin access' } });
    }
  }
);

router.post(
  '/admins/:serverAdminId/revoke',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  versionedAccessOperation(async (req: AuthRequest, res) => {
    try {
      const serverAdminId = String(req.params.serverAdminId || '').trim();
      if (!serverAdminId) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'serverAdminId is required' } });
      }
      const revoked = await serverAdminRepository.revoke(serverAdminId);
      if (!revoked) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Active server admin not found' } });
      }
      return res.json({
        status: 'ok',
        result: {
          serverAdminId,
          identityId: revoked.principal_identity_id,
          revokedAt: revoked.revoked_at
        }
      });
    } catch (error) {
      routeLogger.error('Revoke server admin error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke server admin access' } });
    }
  })
);

export default router;
