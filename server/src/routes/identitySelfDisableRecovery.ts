import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ApiResponse, IdentityId, SignedRequest } from '../../../shared/types';
import type { TenancyRequest } from '../middleware/tenancy';
import { identityRepository } from '../db/repositories';
import { getServerIdentityRuntimeConfig, getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { verifySignedRequest } from '../utils/crypto';
import { getSelfDisableStatus } from '../services/identitySelfDisableRecoveryService';
import { routeLogger } from '../utils/routeLogger';

const router = Router();
const limits = getRateLimitRuntimeConfig().identities;
const limit = createRateLimiter({
  name: 'identity:self-disable-recovery', windowMs: limits.windowMs,
  max: limits.directoryMax, keyFn: ipFamilyKey
});

type RecoveryPayload = Record<string, never>;

async function authenticateOldIdentity(req: Request & TenancyRequest, res: Response, type: string): Promise<IdentityId | null> {
  const claim = req.body as SignedRequest<RecoveryPayload>;
  const familyId = req.familyId;
  if (!familyId || !req.circleId || !claim || claim.type !== type
    || claim.circleId !== req.circleId || claim.vpsId !== getServerIdentityRuntimeConfig().vpsId
    || !claim.signerId || !claim.signature || !Number.isFinite(claim.timestamp)
    || Math.abs(Date.now() - claim.timestamp) > 5 * 60 * 1000
    || typeof claim.nonce !== 'string' || !claim.nonce || claim.nonce.length > 256) {
    res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Invalid self-disable claim' } } as ApiResponse);
    return null;
  }
  const identity = await identityRepository.findByIdentityId(familyId, claim.signerId as IdentityId);
  if (!identity || identity.public_key_algorithm !== 'ed25519' || !verifySignedRequest(claim, {
    algorithm: 'ed25519', value: identity.public_key_value
  })) {
    res.status(401).json({ status: 'error', error: { code: 'INVALID_SIGNATURE', message: 'Invalid identity signature' } } as ApiResponse);
    return null;
  }
  return claim.signerId as IdentityId;
}

// Identity-signed, because disable-self revokes every old device signing key.
router.post('/status', limit, async (req: Request & TenancyRequest, res) => {
  try {
    const identityId = await authenticateOldIdentity(req, res, 'identity:self-disable-status');
    if (!identityId) return;
    const result = await getSelfDisableStatus(req.familyId!, identityId);
    if (!result) return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Identity not found' } } as ApiResponse);
    return res.json({ status: 'ok', result });
  } catch (error) {
    routeLogger.error('Self-disable status failed:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Unable to read self-disable status' } } as ApiResponse);
  }
});

export default router;
