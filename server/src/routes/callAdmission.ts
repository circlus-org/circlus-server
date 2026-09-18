import { versionedAccessOperation } from '../services/versionedAccessOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { query } from '../db';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type { ApiResponse, ErrorCode, PublicKey } from '../../../shared/types';
import { deriveIdentityIdFromPublicKey } from '../../../shared/identityId';

const router = Router();

router.post('/whitelist/list', verifySignature, requireActiveIdentity, requireFullCircleIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const ownerIdentityId = req.device?.identityId;

    if (!familyId || !ownerIdentityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const result = await query<{
      external_identity_id: string;
      external_public_key_algorithm: 'ed25519' | 'x25519';
      external_public_key_value: string;
      status: 'active' | 'revoked';
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT external_identity_id, external_public_key_algorithm, external_public_key_value, status, created_at, updated_at
       FROM call_whitelist_entries
       WHERE family_id = $1 AND owner_identity_id = $2
       ORDER BY created_at DESC`,
      [familyId, ownerIdentityId]
    );

    return res.json({
      status: 'ok',
      result: {
        entries: result.rows.map((row) => ({
          externalIdentityId: row.external_identity_id,
          externalPublicKey: {
            algorithm: row.external_public_key_algorithm,
            value: row.external_public_key_value
          },
          status: row.status,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString()
        }))
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List whitelist error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
});

router.post('/whitelist/add', verifySignature, requireActiveIdentity, requireFullCircleIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const ownerIdentityId = req.device?.identityId;

    if (!familyId || !ownerIdentityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as {
      externalIdentityId?: string;
      externalPublicKey?: PublicKey;
    };

    const externalIdentityId = String(payload.externalIdentityId || '').trim();
    const externalPublicKey = payload.externalPublicKey;

    if (!externalIdentityId || !externalPublicKey?.value || !externalPublicKey?.algorithm) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'externalIdentityId and externalPublicKey are required'
        }
      } as ApiResponse);
    }

    const derived = await deriveIdentityIdFromPublicKey(externalPublicKey);
    if (derived !== externalIdentityId) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'externalIdentityId does not match externalPublicKey'
        }
      } as ApiResponse);
    }

    await query(
      `INSERT INTO call_whitelist_entries (
         family_id,
         owner_identity_id,
         external_identity_id,
         external_public_key_algorithm,
         external_public_key_value,
         status,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
       ON CONFLICT (family_id, owner_identity_id, external_identity_id)
       DO UPDATE SET
         external_public_key_algorithm = EXCLUDED.external_public_key_algorithm,
         external_public_key_value = EXCLUDED.external_public_key_value,
         status = 'active',
         updated_at = NOW()`,
      [
        familyId,
        ownerIdentityId,
        externalIdentityId,
        externalPublicKey.algorithm,
        externalPublicKey.value
      ]
    );

    return res.json({
      status: 'ok',
      result: {
        externalIdentityId,
        status: 'active'
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Add whitelist error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
}));

router.post('/whitelist/remove', verifySignature, requireActiveIdentity, requireFullCircleIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const ownerIdentityId = req.device?.identityId;

    if (!familyId || !ownerIdentityId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as { externalIdentityId?: string };
    const externalIdentityId = String(payload.externalIdentityId || '').trim();

    if (!externalIdentityId) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'externalIdentityId is required'
        }
      } as ApiResponse);
    }

    await query(
      `UPDATE call_whitelist_entries
       SET status = 'revoked', updated_at = NOW()
       WHERE family_id = $1
         AND owner_identity_id = $2
         AND external_identity_id = $3`,
      [familyId, ownerIdentityId, externalIdentityId]
    );

    return res.json({
      status: 'ok',
      result: {
        externalIdentityId,
        status: 'revoked'
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Remove whitelist error:', error);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    } as ApiResponse);
  }
}));

export default router;
