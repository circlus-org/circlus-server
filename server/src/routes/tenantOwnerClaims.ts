import { redeemClaim, ClaimRedemptionError } from '../services/claimRedemption';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import { circleOwnerRecoveryRepository, familyConfigRepository, identityRepository, inviteRepository, serverAdminRepository } from '../db/repositories';
import { hashClaimToken } from '../utils/claimTokens';
import type { CircleOwnerRecoveryAcceptance } from '@shared/types';
import {
  CircleOwnershipError,
  deliverCircleOwnerChangedPush,
  recoverCircleOwnerWithNewIdentity
} from '../services/circleOwnershipService';

const router = Router();

router.post('/recovery-claims/inspect', async (req, res) => {
  try {
    const familyId = (req as AuthRequest).familyId;
    const claimToken = String(req.body?.claimToken || '').trim();
    if (!familyId || !claimToken) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Owner recovery claim is required' } });
    }
    const claim = await circleOwnerRecoveryRepository.findByTokenHash(hashClaimToken(claimToken));
    if (!claim || claim.family_id !== familyId) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Owner recovery claim not found' } });
    }
    if (claim.status !== 'pending' || claim.expires_at.getTime() <= Date.now()) {
      return res.status(410).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Owner recovery claim is no longer active' } });
    }
    const config = await familyConfigRepository.findByFamilyId(familyId);
    if (!config || config.owner_identity_id !== claim.expected_owner_identity_id) {
      return res.status(409).json({ status: 'error', error: { code: 'OWNER_CHANGED', message: 'Circle owner changed after this recovery link was issued' } });
    }
    return res.json({
      status: 'ok',
      result: {
        claimId: claim.claim_id,
        familyId,
        circleName: config.server_name,
        publicBaseUrl: config.public_base_url,
        noNamesOnServer: config.no_names_on_server,
        expectedOwnerIdentityId: claim.expected_owner_identity_id,
        expiresAt: claim.expires_at.toISOString()
      }
    });
  } catch (error) {
    routeLogger.error('Inspect Circle owner recovery claim error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to inspect owner recovery claim' } });
  }
});

router.post('/recovery-claims/redeem', async (req, res) => {
  try {
    const familyId = (req as AuthRequest).familyId;
    const claimToken = String(req.body?.claimToken || '').trim();
    const acceptance = req.body?.acceptance as CircleOwnerRecoveryAcceptance | undefined;
    if (!familyId || !claimToken || !acceptance) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Owner recovery claim and acceptance are required' } });
    }
    const tokenHash = hashClaimToken(claimToken);
    const claim = await circleOwnerRecoveryRepository.findByTokenHash(tokenHash);
    if (!claim || claim.family_id !== familyId) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Owner recovery claim not found' } });
    }
    const administrator = await serverAdminRepository.findById(claim.created_by_server_admin_id);
    if (!administrator) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Recovery authorization issuer is unavailable' } });
    }
    const createdAuthorization = claim.created_authorization as { signerId?: string } | null;
    const result = await recoverCircleOwnerWithNewIdentity({
      familyId,
      expectedOwnerIdentityId: claim.expected_owner_identity_id,
      acceptance,
      initiatedByIdentityId: administrator.principal_identity_id,
      initiatedByDeviceId: String(createdAuthorization?.signerId || ''),
      initiatedByServerAdminId: claim.created_by_server_admin_id,
      signedAuthorization: claim.created_authorization,
      recoveryClaim: { claimId: claim.claim_id, tokenHash }
    });
    void deliverCircleOwnerChangedPush(result);
    return res.json({ status: 'ok', result });
  } catch (error) {
    if (error instanceof CircleOwnershipError) {
      return res.status(error.status).json({ status: 'error', error: { code: error.code, message: error.message } });
    }
    routeLogger.error('Redeem Circle owner recovery claim error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to redeem owner recovery claim' } });
  }
});

router.post(
  '/claims/redeem',
  verifySignature,
  requireActiveIdentity,
  requireFullCircleIdentity,
  async (req: AuthRequest<{ claimToken?: string }>, res) => {
    try {
      const familyId = req.familyId;
      const identityId = req.identity?.identityId;
      const { claimToken: rawClaimToken } = getSignedPayload<{ claimToken?: string }>(req);
      const claimToken = String(rawClaimToken || '').trim();

      if (!familyId || !identityId) {
        return res.status(401).json({ status: 'error', error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      }
      if (!claimToken) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'claimToken is required' } });
      }

      const tokenHash = hashClaimToken(claimToken);
      const response = await redeemClaim('owner', tokenHash, identityId, familyId, async () => {
      const owners = await identityRepository.findByRole(familyId, 'owner');
      const anotherOwner = owners.find((owner) => owner.identity_id !== identityId && owner.status === 'active');
      if (anotherOwner) {
        throw new ClaimRedemptionError(409, 'Tenant already has an owner');
      }

      await identityRepository.updateRole(familyId, identityId, 'owner');
      await familyConfigRepository.activate(familyId, identityId);

      const config = await familyConfigRepository.findByFamilyId(familyId);
      if (config?.join_invite_id) {
        const joinInvite = await inviteRepository.findById(familyId, config.join_invite_id);
        if (joinInvite?.status === 'active') {
          await inviteRepository.updateStatus(familyId, config.join_invite_id, 'revoked');
        }
      }
      const circleCount = await familyConfigRepository.countAll();
      const activeServerAdmins = await serverAdminRepository.listActive();
      const serverAdmin = circleCount === 1 && activeServerAdmins.length === 0
        ? await serverAdminRepository.grantToIdentity({ identityId, grantedVia: 'bootstrap' })
        : null;

      return {
        status: 'ok',
        result: {
          familyId,
          identityId,
          role: 'owner',
          tenantStatus: 'active',
          serverAdmin: serverAdmin
            ? {
                serverAdminId: serverAdmin.server_admin_id,
                identityId: serverAdmin.principal_identity_id,
                grantedAt: serverAdmin.granted_at.toISOString()
              }
            : null
        }
      };
      });
      return res.json(response);
    } catch (error) {
      if (error instanceof ClaimRedemptionError) return res.status(error.status).json({status:'error',error:{code:'INVALID_STATE',message:error.message}});
      routeLogger.error('Redeem tenant owner claim error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to redeem tenant owner claim' } });
    }
  }
);

export default router;
