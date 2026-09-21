import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { backupRepository } from '../db/repositories';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type { ApiResponse, EncryptedBlob, ErrorCode } from '../../../shared/types';

const openCors = cors({ origin: '*' });

const router = Router();

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

/**
 * POST /backup/set
 * Upload or update the encrypted backup for this profile-device slot.
 * Requires authentication.
 */
router.post('/set', verifySignature, requireActiveIdentity, requireFullCircleIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const identityId = req.device!.identityId;
    const deviceId = req.device!.deviceId;
    const familyId = req.familyId;

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const payload = req.signedRequest!.payload as {
      backupProtocolVersion?: number;
      encryptedBackup?: EncryptedBlob;
      backupLookupSecretHash?: string;
      backupSlotId?: string;
    };

    if (payload.backupProtocolVersion !== 2) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Unsupported backup protocol version' }
      } as ApiResponse);
    }

    if (!payload.encryptedBackup) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Missing encryptedBackup' }
      } as ApiResponse);
    }

    if (!isSha256Hex(payload.backupLookupSecretHash)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Missing backup lookup secret hash' }
      } as ApiResponse);
    }

    if (typeof payload.backupSlotId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.backupSlotId)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Missing or invalid backupSlotId' }
      } as ApiResponse);
    }

    const result = await backupRepository.upsert({
      familyId,
      uploaderIdentityId: identityId,
      uploaderDeviceId: deviceId,
      backupSlotId: payload.backupSlotId,
      encryptedBackup: payload.encryptedBackup,
      lookupSecretHash: payload.backupLookupSecretHash.toLowerCase()
    });

    return res.json({
      status: 'ok',
      result: { version: result.version, updatedAt: result.updatedAt }
    } as ApiResponse);

  } catch (error) {
    routeLogger.error('Backup set error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}, req => 'backup:'+String(req.signedRequest.payload?.backupLookupSecretHash || "").toLowerCase()+':'+req.signedRequest.payload.backupSlotId));

/**
 * POST /backup/list
 * Fetch backup blobs from a Circle-scoped secret namespace. UNAUTHENTICATED —
 * no device signature is required during restore. The 256-bit lookup secret is
 * the capability; the response contains only encrypted blobs and versions.
 * Open CORS: callers may be web apps on a different origin (e.g. restoring
 * from a package while the WebView is loaded from a different circle server).
 */
router.options('/list', openCors);
router.post('/list', openCors, async (req, res) => {
  try {
    const familyId = (req as AuthRequest).familyId;

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const body = req.body as { backupProtocolVersion?: number; backupLookupSecret?: string };

    if (body.backupProtocolVersion !== 2) {
      return res.json({ status: 'ok', result: { backups: [] } } as ApiResponse);
    }

    if (typeof body.backupLookupSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.backupLookupSecret)) {
      return res.json({ status: 'ok', result: { backups: [] } } as ApiResponse);
    }

    const rows = await backupRepository.listByLookupSecretHash(
      familyId,
      sha256Hex(body.backupLookupSecret)
    );

    return res.json({
      status: 'ok',
      result: { backups: rows }
    } as ApiResponse);

  } catch (error) {
    routeLogger.error('Backup list error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

export default router;
