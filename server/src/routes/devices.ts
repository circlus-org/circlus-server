import { requireOwnDeviceManagement } from '../middleware/ownDeviceAccess';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  deviceRepository,
  deviceLifecyclePolicyRepository,
  directGuestRegistrationRepository,
  identityRepository,
  quickReceiveControlRepository
} from '../db/repositories';
import { verifySignature, requireActiveIdentity, getSignedPayload } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import type {
  ApiResponse,
  ErrorCode,
  IdentityId,
  RevokeDevicePayload
} from '../../../shared/types';
import { resolveDirectCommunicationAccess } from '../services/directGuestAccessService';
import {
  IdentityDeviceRevocationError,
  revokeIdentityDevice
} from '../services/deviceRevocationService';
import { sendToIdentityWs } from '../ws/wsGateway';

const router = Router();
const QUICK_RECEIVE_CONTROL_MAX_BYTES = 64 * 1024;
const QUICK_RECEIVE_CONTROL_RETENTION_DAYS = 90;

type SendQuickReceiveControlPayload = {
  controlId: string;
  recipientIdentityId: string;
  ciphertext: string;
};

type ListQuickReceiveControlsPayload = {
  afterSequence?: number;
  limit?: number;
};

/**
 * Get list of devices for current identity
 */
router.post('/list', verifySignature, requireActiveIdentity, requireOwnDeviceManagement, async (req: AuthRequest, res) => {
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

    // Get all devices (including revoked) for this identity
    const [devices, lifecyclePolicy] = await Promise.all([
      deviceRepository.findByIdentityId(familyId, identityId),
      deviceLifecyclePolicyRepository.get()
    ]);
    const activeDeviceCount = devices.filter((device) => device.status === 'active').length;
    const now = Date.now();

    const result = devices.map((device) => ({
      deviceId: device.device_id,
      publicKey: {
        algorithm: device.public_key_algorithm,
        value: device.public_key_value
      },
      encryptionPublicKey: (device as any).encryption_public_key_value
        ? {
            algorithm: (device as any).encryption_public_key_algorithm,
            value: (device as any).encryption_public_key_value
          }
        : null,
      registrationAttestation: (device as any).registration_attestation || null,
      webOrigin: (device as any).web_origin || null,
      encryptedPhysicalDeviceId: (device as any).encrypted_physical_device_id || null,
      createdAt: device.created_at.toISOString(),
      lastSeenAt: device.last_seen_at?.toISOString() || null,
      status: device.status,
      inactivity: device.status === 'active' ? (() => {
        const lastActivityAt = (device.last_seen_at || device.created_at).getTime();
        const inactiveDays = Math.max(0, Math.floor((now - lastActivityAt) / 86400000));
        return {
          inactiveDays,
          reviewRecommended: inactiveDays >= lifecyclePolicy.reviewAfterDays,
          autoRevokeAt: lifecyclePolicy.autoRevokeEnabled && (device as any).inactivity_warning_sent_at
            ? new Date((device as any).inactivity_warning_sent_at.getTime() + lifecyclePolicy.warningDays * 86400000).toISOString()
            : null,
          protectedAsLastDevice: activeDeviceCount <= 1
        };
      })() : null
    }));

    return res.json({
      status: 'ok',
      result: {
        devices: result,
        currentDeviceId: req.device!.deviceId,
        lifecyclePolicy
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List devices error:', error);
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
 * Store an opaque E2EE quick-receive control for another identity (or another
 * device of the same identity). This is a mailbox, not a server-side ACL.
 */
router.post('/quick-receive-controls/send', verifySignature, requireActiveIdentity, async (req: AuthRequest<SendQuickReceiveControlPayload>, res) => {
  try {
    const familyId = req.familyId;
    const issuerIdentityId = req.device!.identityId;
    if (req.device!.accessLevel === 'temporary') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN', message: 'Trusted device access required' } } as ApiResponse);
    }
    const { controlId, recipientIdentityId, ciphertext } = getSignedPayload<SendQuickReceiveControlPayload>(req);
    const normalizedControlId = String(controlId || '').trim();
    const normalizedRecipientId = String(recipientIdentityId || '').trim();
    const normalizedCiphertext = String(ciphertext || '').trim();
    if (!familyId || !normalizedControlId || normalizedControlId.length > 200 || !normalizedRecipientId || !normalizedCiphertext) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Invalid quick receive control' } } as ApiResponse);
    }
    if (Buffer.byteLength(normalizedCiphertext, 'utf8') > QUICK_RECEIVE_CONTROL_MAX_BYTES) {
      return res.status(413).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Quick receive control is too large' } } as ApiResponse);
    }

    const recipient = await identityRepository.findByIdentityId(familyId, normalizedRecipientId);
    if (!recipient || recipient.status !== 'active') {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Recipient identity not found' } } as ApiResponse);
    }
    if (normalizedRecipientId !== issuerIdentityId) {
      // The recipient will become the sender, so check the permission in that
      // direction at issuance time. Every transfer is checked again later.
      const access = await resolveDirectCommunicationAccess(
        familyId,
        normalizedRecipientId,
        issuerIdentityId,
        'direct_files'
      );
      if (!access.allowed) {
        // Revocation uses the same opaque E2EE mailbox, so the server cannot
        // inspect whether this control grants or revokes. Keep the mailbox open
        // for an existing guest pair even after its direct_files flag is turned
        // off; actual file offers still require the live permission.
        const existingGuestPair = await directGuestRegistrationRepository.findActiveByPair(
          familyId,
          normalizedRecipientId,
          issuerIdentityId
        );
        if (!existingGuestPair) {
          return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN', message: 'No direct relationship exists with this recipient' } } as ApiResponse);
        }
      }
    }

    const inserted = await quickReceiveControlRepository.upsert({
      controlId: normalizedControlId,
      familyId,
      issuerIdentityId: issuerIdentityId as IdentityId,
      recipientIdentityId: normalizedRecipientId as IdentityId,
      issuerDeviceId: req.device!.deviceId,
      ciphertext: normalizedCiphertext
    });
    sendToIdentityWs(familyId, normalizedRecipientId as IdentityId, {
      type: 'quick-receive:control-available',
      data: { sequence: inserted.sequence },
      timestamp: Date.now()
    });
    return res.json({
      status: 'ok',
      result: {
        controlId: normalizedControlId,
        sequence: inserted.sequence,
        createdAt: inserted.createdAt.toISOString()
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Send quick receive control error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/quick-receive-controls/list', verifySignature, requireActiveIdentity, async (req: AuthRequest<ListQuickReceiveControlsPayload>, res) => {
  try {
    const familyId = req.familyId;
    if (req.device!.accessLevel === 'temporary') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN', message: 'Trusted device access required' } } as ApiResponse);
    }
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Family context is missing' } } as ApiResponse);
    }
    const payload = getSignedPayload<ListQuickReceiveControlsPayload>(req);
    const afterSequence = Math.max(0, Number(payload.afterSequence || 0));
    const limit = Math.min(200, Math.max(1, Number(payload.limit || 100)));
    const recipientIdentityId = req.device!.identityId;
    const rows = await quickReceiveControlRepository.listAfter({
      familyId,
      recipientIdentityId: recipientIdentityId as IdentityId,
      afterSequence,
      limit
    });
    void quickReceiveControlRepository.deleteOlderThanDays(QUICK_RECEIVE_CONTROL_RETENTION_DAYS).catch(() => {});
    const controls = rows.map((row) => ({
      sequence: row.sequence,
      controlId: row.controlId,
      issuerIdentityId: row.issuerIdentityId,
      issuerPublicKey: row.issuerPublicKey,
      ciphertext: row.ciphertext,
      createdAt: row.createdAt.toISOString()
    }));
    return res.json({
      status: 'ok',
      result: {
        controls,
        nextSequence: controls.length ? controls[controls.length - 1].sequence : afterSequence,
        hasMore: controls.length === limit
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List quick receive controls error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } as ApiResponse);
  }
});

/**
 * Revoke device access
 *
 * Security checks:
 * - Cannot revoke current device
 * - Device must belong to current identity
 */
router.post('/revoke', verifySignature, requireActiveIdentity, requireOwnDeviceManagement, async (req: AuthRequest<Partial<RevokeDevicePayload>>, res) => {
  try {
    const { deviceId, deleteLocalCircleData = false, localDeletionAuthorization } = getSignedPayload<Partial<RevokeDevicePayload>>(req);
    const currentDeviceId = req.device!.deviceId;
    const currentIdentityId = req.device!.identityId;
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

    if (!deviceId) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Missing deviceId'
        }
      } as ApiResponse);
    }

    const outcome = await revokeIdentityDevice({
      familyId,
      currentDeviceId,
      currentIdentityId,
      allowCurrentDevice: req.identity?.role === 'guest',
      deviceId,
      deleteLocalCircleData: deleteLocalCircleData === true,
      localDeletionAuthorization
    });

    return res.json({
      status: 'ok',
      result: {
        deviceId,
        status: 'revoked',
        localDeletionRequested: deleteLocalCircleData === true,
        rekeyJobId: outcome.rekey.jobId,
        rekeyStatus: outcome.rekey.status,
        affectedGroupChats: outcome.rekey.groupTargets,
        affectedDirectChats: outcome.rekey.directTargets
      }
    } as ApiResponse);
  } catch (error) {
    if (error instanceof IdentityDeviceRevocationError) {
      return res.status(error.status).json({
        status: 'error',
        error: { code: error.code as ErrorCode, message: error.message }
      } as ApiResponse);
    }
    routeLogger.error('Revoke device error:', error);
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
