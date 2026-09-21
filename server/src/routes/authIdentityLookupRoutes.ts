import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { identityRepository } from '../db/repositories';
import type { TenancyRequest } from '../middleware/tenancy';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';
import type { ApiResponse, PublicKey } from '../../../shared/types';
import { sendApiError } from '../utils/apiResponses';

const router = Router();
const authRateLimits = getRateLimitRuntimeConfig().auth;
const rlIdentityEncryptedKey = createRateLimiter({
  name: 'auth:identity:encrypted-key',
  windowMs: authRateLimits.windowMs,
  max: authRateLimits.identityEncryptedKeyMax,
  keyFn: ipFamilyKey
});
router.post('/identity/encrypted-key', rlIdentityEncryptedKey, async (req, res) => {
  try {
    const { familyId } = req as TenancyRequest;
    if (!familyId) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Family context is missing');
    }

    const { publicKey } = req.body as { publicKey?: PublicKey };

    if (!publicKey?.value) {
      return sendApiError(res, 400, 'INVALID_STATE', 'Missing public key');
    }

    // Find identity by public key
    const identity = await identityRepository.findByPublicKey(familyId, publicKey.value);

    if (!identity) {
      return sendApiError(res, 404, 'NOT_FOUND', 'Identity not found');
    }

    // Return public info + encrypted private key
    // Safe to return because encrypted with user's master key
    const identityPublicKey: PublicKey = {
      algorithm: identity.public_key_algorithm as 'ed25519' | 'x25519',
      value: identity.public_key_value
    };
    return res.json({
      status: 'ok',
      result: {
        identityId: identity.identity_id,
        publicKey: identityPublicKey,
        encryptedPrivateKey: identity.encrypted_private_key,
        role: identity.role
      }
    } as ApiResponse);

  } catch (error) {
    routeLogger.error('Get encrypted key error:', error);
    return sendApiError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  }
});


export default router;
