import { requireOwnDeviceManagement } from '../middleware/ownDeviceAccess';
import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router, type NextFunction, type Response } from 'express';
import { vaultRepository } from '../db/repositories';
import { verifySignature, requireActiveIdentity } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type {
  SetVaultPayload,
  GetVaultResponse,
  VaultHeadResponse,
  ApiResponse,
  ErrorCode
} from '../../../shared/types';

const router = Router();

function requireTrustedDevice(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.device?.accessLevel === 'temporary') {
    res.status(403).json({
      status: 'error',
      error: { code: 'FORBIDDEN' as ErrorCode, message: 'Temporary devices cannot access the identity vault' }
    } as ApiResponse);
    return;
  }
  next();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function encryptedVaultsEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/**
 * Get vault metadata without returning the encrypted vault body.
 */
router.post('/head', verifySignature, requireActiveIdentity, requireOwnDeviceManagement, requireTrustedDevice, async (req: AuthRequest, res) => {
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

    const vault = await vaultRepository.findByIdentityId(familyId, identityId);

    return res.json({
      status: 'ok',
      result: {
        revision: vault?.revision || 0,
        updatedAt: vault?.updated_at?.toISOString()
      }
    } as ApiResponse<VaultHeadResponse>);

  } catch (error) {
    routeLogger.error('Get vault head error:', error);
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
 * Get vault (requires authentication)
 */
router.post('/get', verifySignature, requireActiveIdentity, requireOwnDeviceManagement, requireTrustedDevice, async (req: AuthRequest, res) => {
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

    const vault = await vaultRepository.findByIdentityId(familyId, identityId);

    if (!vault) {
      return res.json({
        status: 'ok',
        result: {
          vault: undefined,
          revision: 0
        }
      } as ApiResponse<GetVaultResponse>);
    }

    return res.json({
      status: 'ok',
      result: {
        vault: vault.encrypted_vault as any,
        revision: vault.revision || 0
      }
    } as ApiResponse<GetVaultResponse>);

  } catch (error) {
    routeLogger.error('Get vault error:', error);
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
 * Set vault (requires authentication)
 */
router.post('/set', verifySignature, requireActiveIdentity, requireOwnDeviceManagement, requireTrustedDevice, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const identityId = req.device!.identityId;
    const familyId = req.familyId;
    const payload = req.signedRequest!.payload as SetVaultPayload;

    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    if (!payload.encryptedVault) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Missing encrypted vault'
        }
      } as ApiResponse);
    }

    if (!Number.isSafeInteger(payload.expectedRevision) || Number(payload.expectedRevision) < 0) {
      return res.status(400).json({status:'error',error:{code:'INVALID_REQUEST',message:'expectedRevision is required'}});
    }
    const contentLength = req.headers['content-length'];

    const currentVault = await vaultRepository.findByIdentityId(familyId, identityId);
    const currentRevision = currentVault?.revision || 0;

    if (currentVault && currentRevision === payload.expectedRevision! + 1 && encryptedVaultsEqual(currentVault.encrypted_vault, payload.encryptedVault)) {
      return res.json({status:'ok',result:{revision:currentRevision,updatedAt:currentVault.updated_at}});
    }
    // Optimistic locking: check if expectedRevision matches current revision
    if (payload.expectedRevision !== undefined) {
      if (currentRevision !== payload.expectedRevision) {
        routeLogger.info('[Vault][set] conflict', {
          familyId,
          identityId,
          expectedRevision: payload.expectedRevision,
          currentRevision,
          contentLength
        });
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'CONFLICT' as ErrorCode,
            message: 'Vault has been modified by another device'
          },
          result: {
            currentRevision,
            vault: currentVault?.encrypted_vault as any
          }
        } as ApiResponse);
      }
    }

    if (currentVault && encryptedVaultsEqual(currentVault.encrypted_vault, payload.encryptedVault)) {
      routeLogger.info('[Vault][set] noop', {
        familyId,
        identityId,
        revision: currentRevision,
        contentLength
      });
      return res.json({
        status: 'ok',
        result: {
          revision: currentRevision,
          updatedAt: currentVault.updated_at
        }
      } as ApiResponse);
    }

    const vault = await vaultRepository.compareAndSet(familyId, identityId, payload.encryptedVault, payload.expectedRevision!);
    if (!vault) {
      const latest = await vaultRepository.findByIdentityId(familyId, identityId);
      return res.status(409).json({status:'error',error:{code:'CONFLICT',message:'Vault changed during update'},result:{currentRevision:latest?.revision || 0,vault:latest?.encrypted_vault}});
    }

    routeLogger.info('[Vault][set] success', {
      familyId,
      identityId,
      revision: vault.revision,
      contentLength
    });

    return res.json({
      status: 'ok',
      result: {
        revision: vault.revision,
        updatedAt: vault.updated_at
      }
    } as ApiResponse);

  } catch (error) {
    routeLogger.error('Set vault error:', error);
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
