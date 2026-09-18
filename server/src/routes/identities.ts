import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  identityRepository,
  circleFileAccessRepository,
  attachmentRepository,
  familyConfigRepository,
  CircleDeleteGuardError
} from '../db/repositories';
import { attachmentStorageService } from '../services/attachmentStorageService';
import { publicSiteAssetStorageService } from '../services/publicSiteAssetStorageService';
import { deleteIdentityDataFromCircle, IdentityDeletionServiceError } from '../services/identityDeletionService';
import { notifyCircleServerDataDeleted, notifyIdentityServerDataDeleted } from '../ws/wsGateway';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity, getSignedPayload } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import type { ApiResponse, PublicKey } from '../../../shared/types';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';
import { listCircleIdentityAdmissionProofs } from '../services/circleMembershipProofService';
import { listCircleMembershipStates } from '../services/circleMembershipStateService';
import { circleProfileAvatarBlobId } from '../services/circleProfileAvatarPublication';

const router = Router();

// Client compresses plaintext to ≤ 300 KB. Base64 plus authenticated encryption
// stays below the dedicated 512 KB JSON parser limit.
const AVATAR_MAX_CIPHERTEXT_BYTES = 480 * 1024;

const identityRateLimits = getRateLimitRuntimeConfig().identities;
const rlPublished = createRateLimiter({
  name: 'identities:published',
  windowMs: identityRateLimits.windowMs,
  max: identityRateLimits.publishedMax,
  keyFn: ipFamilyKey
});

const rlAvatar = createRateLimiter({
  name: 'identities:avatar-upload',
  windowMs: identityRateLimits.windowMs,
  max: identityRateLimits.avatarUploadMax,
  keyFn: ipFamilyKey
});

// ---------------------------------------------------------------------------
// POST /identities/delete-owned-circle - remove a Circle when owner is alone
// ---------------------------------------------------------------------------
router.post(
  '/delete-owned-circle',
  verifySignature,
  requireActiveIdentity,
  requireFullCircleIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      const identityId = req.device!.identityId;
      if (!familyId) {
        return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Family context missing' } } as ApiResponse);
      }

      const storageKeys = await familyConfigRepository.deleteWithData(familyId, {
        requireSoleOwnerIdentityId: identityId
      });
      for (const storageKey of storageKeys.attachmentStorageKeys) {
        try {
          await attachmentStorageService.deleteBlob(storageKey);
        } catch (error) {
          routeLogger.error('Delete Circle attachment payload failed', error);
        }
      }
      for (const storageKey of storageKeys.publicSiteAssetStorageKeys) {
        await publicSiteAssetStorageService.deleteAsset(storageKey).catch((error) => {
          routeLogger.error('Delete Circle public site asset failed', error);
        });
      }
      notifyCircleServerDataDeleted(familyId, req.device!.deviceId);

      return res.json({ status: 'ok', result: { deleted: true } } as ApiResponse<{ deleted: boolean }>);
    } catch (error) {
      if (error instanceof CircleDeleteGuardError) {
        return res.status(error.code === 'NOT_OWNER' ? 403 : 409).json({
          status: 'error',
          error: { code: 'INVALID_STATE', message: error.message }
        } as ApiResponse);
      }
      routeLogger.error('Delete owned Circle error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to delete Circle' } } as ApiResponse);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /identities/delete-self - irreversibly remove current Circle data
// ---------------------------------------------------------------------------
router.post(
  '/delete-self',
  verifySignature,
  requireActiveIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      const identityId = req.device!.identityId;
      if (!familyId) {
        return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Family context missing' } } as ApiResponse);
      }

      const result = await deleteIdentityDataFromCircle({ familyId, identityId });
      for (const storageKey of result.attachmentStorageKeys) {
        try {
          await attachmentStorageService.deleteBlob(storageKey);
        } catch (error) {
          routeLogger.error('Delete identity attachment payload failed', error);
        }
      }
      for (const storageKey of result.publicSiteAssetStorageKeys) {
        await publicSiteAssetStorageService.deleteAsset(storageKey).catch((error) => {
          routeLogger.error('Delete identity public site asset failed', error);
        });
      }
      notifyIdentityServerDataDeleted(familyId, identityId, req.device!.deviceId);

      return res.json({ status: 'ok', result: { deleted: true } } as ApiResponse<{ deleted: boolean }>);
    } catch (error) {
      if (error instanceof IdentityDeletionServiceError) {
        return res.status(error.status).json({
          status: 'error',
          error: { code: error.code, message: error.message }
        } as ApiResponse);
      }
      routeLogger.error('Delete own Circle data error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to delete Circle data' } } as ApiResponse);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /identities/avatar/get — return an avatar only to a current Circle member
// ---------------------------------------------------------------------------
router.post(
  '/avatar/get',
  verifySignature,
  requireActiveIdentity,
  requireFullCircleIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      const signedType = String(req.signedRequest?.type || '');
      const { targetIdentityId, blobId: requestedBlobId } = getSignedPayload<{ targetIdentityId?: unknown; blobId?: unknown }>(req);
      const identityId = typeof targetIdentityId === 'string' ? targetIdentityId.trim() : '';
      const requested = typeof requestedBlobId === 'string' ? requestedBlobId.trim() : '';

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'INTERNAL_ERROR', message: 'Family context missing' }
        } as ApiResponse);
      }
      if (signedType !== 'identities:avatar:get' || !identityId || !requested) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'Invalid avatar request' }
        } as ApiResponse);
      }

      const blob = await attachmentRepository.findBlobById(familyId, requested);
      if (!blob || blob.status !== 'committed' || blob.uploader_identity_id !== identityId) {
        return res.status(404).end();
      }

      const stream = await attachmentStorageService.readBlob(blob.storage_key);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Length', blob.plaintext_size_bytes);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      stream.pipe(res);
    } catch (error) {
      routeLogger.error('Avatar fetch error:', error);
      return res.status(500).end();
    }
  }
);

// ---------------------------------------------------------------------------
// POST /identities/avatar  — upload avatar for current identity (authenticated)
// Payload: { ciphertext: string, publicationId: string }. The server never
// receives image bytes or MIME type. publicationId makes staged uploads
// idempotent across devices retrying one logical profile publication.
// ---------------------------------------------------------------------------
router.post(
  '/avatar',
  rlAvatar,
  verifySignature,
  requireActiveIdentity,
  requireFullCircleIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      const identityId = req.device!.identityId;

      if (!familyId) {
        return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Family context missing' } });
      }

      const payload = getSignedPayload<{ ciphertext?: unknown; publicationId?: unknown }>(req);
      const ciphertext = typeof payload.ciphertext === 'string' ? payload.ciphertext.trim() : '';
      const publicationId = typeof payload.publicationId === 'string' ? payload.publicationId.trim() : '';
      if (!ciphertext.startsWith('cpa1:') || publicationId.length < 16 || publicationId.length > 160) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Encrypted avatar is required' } } as ApiResponse);
      }
      const imageBuffer = Buffer.from(ciphertext, 'utf8');

      if (imageBuffer.length === 0) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Empty image' } } as ApiResponse);
      }

      if (imageBuffer.length > AVATAR_MAX_CIPHERTEXT_BYTES) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Encrypted avatar is too large' } } as ApiResponse);
      }

      const blobId = circleProfileAvatarBlobId(identityId, publicationId);
      const storageKey = attachmentStorageService.buildStorageKey(familyId, blobId);

      const existing = await attachmentRepository.findBlobById(familyId, blobId);
      if (existing) {
        if (existing.uploader_identity_id !== identityId || existing.status !== 'committed') {
          return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Encrypted avatar publication conflict' } } as ApiResponse);
        }
        return res.json({ status: 'ok', result: { blobId } } as ApiResponse<{ blobId: string }>);
      }

      await attachmentStorageService.writeUploadBuffer({
        reservationId: `avatar-${blobId}`,
        storageKey,
        body: imageBuffer,
      });

      await attachmentRepository.createAvatarBlob({
        blobId,
        familyId,
        uploaderIdentityId: identityId,
        originalFileName: 'encrypted-avatar',
        mimeType: 'application/octet-stream',
        sizeBytes: imageBuffer.length,
        storageKey,
      });

      await circleFileAccessRepository.grantAccess({ familyId, blobId, purpose: 'avatar' });

      return res.json({ status: 'ok', result: { blobId } } as ApiResponse<{ blobId: string }>);
    } catch (error) {
      routeLogger.error('Avatar upload error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } as ApiResponse);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /identities/avatar/clear  — remove avatar for current identity
// ---------------------------------------------------------------------------
router.post(
  '/avatar/clear',
  verifySignature,
  requireActiveIdentity,
  requireFullCircleIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      const identityId = req.device!.identityId;

      if (!familyId) {
        return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Family context missing' } });
      }

      await identityRepository.setAvatar(familyId, identityId, null);

      return res.json({ status: 'ok', result: null } as ApiResponse);
    } catch (error) {
      routeLogger.error('Avatar clear error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } as ApiResponse);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /identities/settings  — get current identity settings in this circle
// ---------------------------------------------------------------------------
router.post(
  '/settings',
  verifySignature,
  requireActiveIdentity,
  requireFullCircleIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      const identityId = req.device!.identityId;

      if (!familyId) {
        return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Family context missing' } });
      }

      const identity = await identityRepository.findByIdentityId(familyId, identityId);
      if (!identity) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Identity not found' } } as ApiResponse);
      }

      return res.json({
        status: 'ok',
        result: {
          presenceVisible: identity.presence_visible !== false,
          identityName: null,
          publishIdentity: false,
        }
      } as ApiResponse<{
        presenceVisible: boolean;
        identityName: string | null;
        publishIdentity: boolean;
      }>);
    } catch (error) {
      routeLogger.error('Get identity settings error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } as ApiResponse);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /identities/presence-visibility  — update presence visibility in this circle
// ---------------------------------------------------------------------------
router.post(
  '/presence-visibility',
  verifySignature,
  requireActiveIdentity,
  requireFullCircleIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      const identityId = req.device!.identityId;

      if (!familyId) {
        return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Family context missing' } });
      }

      const payload = getSignedPayload<{ presenceVisible?: unknown }>(req);
      if (typeof payload.presenceVisible !== 'boolean') {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'presenceVisible must be boolean' } } as ApiResponse);
      }

      const presenceVisible = await identityRepository.updatePresenceVisible(familyId, identityId, payload.presenceVisible);

      return res.json({
        status: 'ok',
        result: { presenceVisible }
      } as ApiResponse<{ presenceVisible: boolean }>);
    } catch (error) {
      routeLogger.error('Update presence visibility error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } as ApiResponse);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /identities/published  — list discoverable identities (existing)
// ---------------------------------------------------------------------------
router.post(
  '/published',
  rlPublished,
  verifySignature,
  requireActiveIdentity,
  requireFullCircleIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        });
      }

      const [, membershipProofs, membershipStates] = await Promise.all([
        Promise.resolve([]),
        listCircleIdentityAdmissionProofs(familyId),
        listCircleMembershipStates(familyId),
      ]);
      const result = membershipProofs
        .filter((proof) => proof.status === 'active' && proof.role !== 'guest')
        .map((proof) => ({
        identityId: proof.identityId,
        publicKey: proof.publicKey,
        identityName: null
      }));

      return res.json({
        status: 'ok',
        result: { identities: result, membershipProofs, membershipStates }
      } as ApiResponse<{
        identities: Array<{ identityId: string; publicKey: PublicKey; identityName: string | null }>;
        membershipProofs: Awaited<ReturnType<typeof listCircleIdentityAdmissionProofs>>;
        membershipStates: Awaited<ReturnType<typeof listCircleMembershipStates>>;
      }>);
    } catch (error) {
      routeLogger.error('Published identities error:', error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
      });
    }
  }
);

export default router;
