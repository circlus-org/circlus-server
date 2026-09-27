import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { directGuestRegistrationRepository, identityRepository } from '../db/repositories';
import { query, transaction } from '../db';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity, getRequestAuthorization, getSignedPayload } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type { ApiResponse, CircleEncryptedIdentityStatus, ErrorCode, IdentityId } from '../../../shared/types';

const router = Router();

type EncryptedStatusRow = {
  owner_identity_id: string;
  epoch: number;
  revision: number;
  ciphertext: string;
  updated_at: Date;
};

function mapEncryptedStatus(row: EncryptedStatusRow): CircleEncryptedIdentityStatus {
  return {
    ownerIdentityId: row.owner_identity_id,
    epoch: Number(row.epoch),
    revision: Number(row.revision),
    ciphertext: row.ciphertext,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Set user status for current identity
 */
router.post('/set', verifySignature, requireActiveIdentity, requireFullCircleIdentity, async (req: AuthRequest<{ encryptedStatus?: Partial<CircleEncryptedIdentityStatus> }>, res) => {
  try {
    const { encryptedStatus } = getSignedPayload<{ encryptedStatus?: Partial<CircleEncryptedIdentityStatus> }>(req);
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

    const ownerIdentityId = typeof encryptedStatus?.ownerIdentityId === 'string' ? encryptedStatus.ownerIdentityId.trim() : '';
    const epoch = Number(encryptedStatus?.epoch);
    const revision = Number(encryptedStatus?.revision);
    const ciphertext = typeof encryptedStatus?.ciphertext === 'string' ? encryptedStatus.ciphertext.trim() : '';
    if (ownerIdentityId !== identityId || !Number.isSafeInteger(epoch) || epoch < 1
      || !Number.isSafeInteger(revision) || revision < 1 || !ciphertext || ciphertext.length > 16384) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid encrypted status' } } as ApiResponse);
    }

    const stored = await transaction(async (client) => {
      const latestEpoch = await client.query<{ epoch: number }>(
        `SELECT epoch FROM circle_profile_epochs WHERE family_id = $1 ORDER BY epoch DESC LIMIT 1 FOR UPDATE`,
        [familyId]
      );
      if (Number(latestEpoch.rows[0]?.epoch) !== epoch) return null;
      const current = await client.query<EncryptedStatusRow>(
        `SELECT owner_identity_id, epoch, revision, ciphertext, updated_at
           FROM circle_encrypted_identity_statuses
          WHERE family_id = $1 AND owner_identity_id = $2 FOR UPDATE`,
        [familyId, identityId]
      );
      if (current.rows[0] && revision <= Number(current.rows[0].revision)) return mapEncryptedStatus(current.rows[0]);
      const saved = await client.query<EncryptedStatusRow>(
        `INSERT INTO circle_encrypted_identity_statuses
           (family_id, owner_identity_id, epoch, revision, ciphertext)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (family_id, owner_identity_id) DO UPDATE SET
           epoch = EXCLUDED.epoch, revision = EXCLUDED.revision,
           ciphertext = EXCLUDED.ciphertext, updated_at = NOW()
         RETURNING owner_identity_id, epoch, revision, ciphertext, updated_at`,
        [familyId, identityId, epoch, revision, ciphertext]
      );
      return mapEncryptedStatus(saved.rows[0]!);
    });
    if (!stored) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Circle profile epoch changed' } } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        encryptedStatus: stored
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
router.post('/get', verifySignature, requireActiveIdentity, async (req: AuthRequest<{ identityIds?: unknown[] }>, res) => {
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
    const fullCircleMember = getRequestAuthorization(req).fullCircleMember;
    if (!fullCircleMember && req.identity?.role !== 'guest') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN', message: 'Presence access denied' } } as ApiResponse);
    }
    let normalizedIdentityIds = [...new Set(identityIds.map(String))] as IdentityId[];
    if (!fullCircleMember) {
      // Guests may see only their registered peers, including guests they host.
      // Filter mixed batches so an unrelated contact cannot block a valid peer.
      const viewerIdentityId = req.device!.identityId;
      const allowed = await Promise.all(normalizedIdentityIds.map(async (targetIdentityId) => (
        targetIdentityId === viewerIdentityId
        || Boolean(await directGuestRegistrationRepository.findActiveByPair(familyId, viewerIdentityId, targetIdentityId))
      )));
      normalizedIdentityIds = normalizedIdentityIds.filter((_, index) => allowed[index]);
    }
    const [statusMap, encryptedRows] = await Promise.all([
      identityRepository.getStatuses(familyId, normalizedIdentityIds),
      fullCircleMember ? query<EncryptedStatusRow>(
        `SELECT owner_identity_id, epoch, revision, ciphertext, updated_at
           FROM circle_encrypted_identity_statuses
          WHERE family_id = $1 AND owner_identity_id = ANY($2::text[])`,
        [familyId, normalizedIdentityIds]
      ) : Promise.resolve({ rows: [] as EncryptedStatusRow[] }),
    ]);
    const encryptedByIdentity = new Map(encryptedRows.rows.map((row) => [row.owner_identity_id, mapEncryptedStatus(row)]));

    // Convert Map to object for JSON response
    const statuses: Record<string, {
      encryptedStatus: CircleEncryptedIdentityStatus | null;
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
        encryptedStatus: encryptedByIdentity.get(identityId) || null,
        avatarBlobId: fullCircleMember ? statusData.avatarBlobId : null,
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

    const result = await query<EncryptedStatusRow>(
      `SELECT owner_identity_id, epoch, revision, ciphertext, updated_at
         FROM circle_encrypted_identity_statuses
        WHERE family_id = $1 AND owner_identity_id = $2`,
      [familyId, identityId]
    );
    if (!req.identity) {
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
        encryptedStatus: result.rows[0] ? mapEncryptedStatus(result.rows[0]) : null
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
