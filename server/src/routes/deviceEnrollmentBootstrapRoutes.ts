import { requireOwnDeviceManagement } from '../middleware/ownDeviceAccess';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import crypto from 'crypto';
import type { ApiResponse, ErrorCode, IdentityId } from '../../../shared/types';
import {
  verifySignature,
  requireActiveIdentity,
  getSignedPayload,
  type AuthRequest
} from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import { configService } from '../services/configService';
import { deviceEnrollmentRepository } from '../db/repositories/deviceEnrollmentRepository';
import { deviceRepository, identityRepository } from '../db/repositories';
import { isTrustedClientOrigin, normalizeTrustedOrigin } from '../utils/trustedOrigins';
import { sendToDeviceWs } from '../ws/wsGateway';
import {
  encodeDeviceEnrollmentBootstrap,
  type DeviceEnrollmentBootstrapPayload
} from '../../../shared/deviceEnrollmentLink';
import {
  createEnrollmentRateLimiter as rlCreateEnrollment,
  deviceEnrollmentPolicies,
  getRequestIp,
  isEnrollmentExpired
} from './deviceEnrollmentRouteSupport';

const router = Router();
router.post('/reserve', rlCreateEnrollment, verifySignature, requireActiveIdentity, requireOwnDeviceManagement, async (req: AuthRequest<{
  enrollmentId?: string;
  trustedDeviceId?: string;
  bootstrapCommitment?: string;
  bootstrapPayload?: DeviceEnrollmentBootstrapPayload;
}> & TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const { enrollmentId, trustedDeviceId, bootstrapCommitment, bootstrapPayload } = getSignedPayload<{
      enrollmentId?: string;
      trustedDeviceId?: string;
      bootstrapCommitment?: string;
      bootstrapPayload?: DeviceEnrollmentBootstrapPayload;
    }>(req);
    const normalizedEnrollmentId = String(enrollmentId || '').trim();
    if (!normalizedEnrollmentId || !trustedDeviceId || trustedDeviceId !== req.device?.deviceId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Enrollment reservation is malformed' }
      } as ApiResponse);
    }

    const normalizedCommitment = String(bootstrapCommitment || '').trim();
    let normalizedBootstrap: DeviceEnrollmentBootstrapPayload | null = null;
    if (normalizedCommitment || bootstrapPayload) {
      const identity = await identityRepository.findByIdentityId(familyId, req.device!.identityId);
      const candidate = bootstrapPayload as DeviceEnrollmentBootstrapPayload | undefined;
      const validCandidate = candidate
        && candidate.v === 2
        && String(candidate.enrollmentId || '').trim() === normalizedEnrollmentId
        && String(candidate.trustedDeviceId || '').trim() === trustedDeviceId
        && String(candidate.identityPublicKey || '').trim() === String(identity?.public_key_value || '').trim()
        && !!String(candidate.server || '').trim()
        && !!String(candidate.sessionPublicKey || '').trim();
      const expectedCommitment = validCandidate
        ? crypto.createHash('sha256')
            .update(encodeDeviceEnrollmentBootstrap(candidate), 'utf8')
            .digest('base64url')
        : '';
      if (!validCandidate || !normalizedCommitment || expectedCommitment !== normalizedCommitment) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Enrollment bootstrap commitment is invalid' }
        } as ApiResponse);
      }
      normalizedBootstrap = {
        v: 2,
        server: candidate.server.trim(),
        identityPublicKey: candidate.identityPublicKey.trim(),
        enrollmentId: normalizedEnrollmentId,
        sessionPublicKey: candidate.sessionPublicKey.trim(),
        trustedDeviceId: trustedDeviceId.trim()
      };
    }

    const enrollment = await deviceEnrollmentRepository.reserve({
      familyId,
      enrollmentId: normalizedEnrollmentId,
      expiresAt: new Date(Date.now() + deviceEnrollmentPolicies.reservationTtlMs),
      requestedTrustedDeviceId: trustedDeviceId,
      requestedIdentityId: req.device!.identityId,
      bootstrapCommitment: normalizedCommitment || null,
      bootstrapPayload: normalizedBootstrap
    });
    if (!enrollment) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment ID is already in use' }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        enrollmentId: enrollment.enrollment_id,
        expiresAt: enrollment.expires_at.toISOString(),
        state: 'reserved'
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Reserve device enrollment error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to reserve device enrollment' }
    } as ApiResponse);
  }
});

router.post('/', rlCreateEnrollment, async (req: TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const { enrollmentId, newDeviceCiphertext, cipher, trustedDeviceId } = req.body as {
      enrollmentId?: string;
      newDeviceCiphertext?: string;
      cipher?: string;
      trustedDeviceId?: string;
    };

    if (!enrollmentId || !newDeviceCiphertext || !cipher || !trustedDeviceId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'enrollmentId, newDeviceCiphertext, cipher and trustedDeviceId are required' }
      } as ApiResponse);
    }

    const familyConfig = await configService.getFamilyConfig(familyId);
    if (!familyConfig) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Family configuration not found' }
      } as ApiResponse);
    }

    const origin = normalizeTrustedOrigin(req.get('origin'));
    const originAllowed = isTrustedClientOrigin(origin, familyConfig);
    if (!originAllowed) {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'Origin is not trusted for device enrollment' }
      } as ApiResponse);
    }

    const requestedTrustedDevice = await deviceRepository.findByDeviceId(familyId, String(trustedDeviceId).trim());
    if (!requestedTrustedDevice || requestedTrustedDevice.status !== 'active') {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Trusted enrollment device was not found' }
      } as ApiResponse);
    }

    const normalizedEnrollmentId = String(enrollmentId).trim();
    const normalizedCiphertext = String(newDeviceCiphertext).trim();
    const normalizedCipher = String(cipher).trim();
    const existing = await deviceEnrollmentRepository.findByEnrollmentId(familyId, normalizedEnrollmentId);
    let enrollment;
    if (existing) {
      if (existing.state === 'rejected' || existing.state === 'expired'
        || isEnrollmentExpired(existing.enrollment_expires_at || existing.expires_at)) {
        return res.status(410).json({
          status: 'error',
          error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment was cancelled or expired' }
        } as ApiResponse);
      }
      if (existing.requested_trusted_device_id !== requestedTrustedDevice.device_id) {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN' as ErrorCode, message: 'Enrollment is bound to another trusted device' }
        } as ApiResponse);
      }
      if (existing.state === 'reserved') {
        enrollment = await deviceEnrollmentRepository.attachRequestToReservation({
          familyId,
          enrollmentId: normalizedEnrollmentId,
          requestedTrustedDeviceId: requestedTrustedDevice.device_id,
          newDeviceCiphertext: normalizedCiphertext,
          newDeviceCipher: normalizedCipher,
          origin: origin!,
          requestIp: getRequestIp(req),
          requestUserAgent: String(req.get('user-agent') || '').trim() || null
        });
      } else if (
        ['pending_trusted_read', 'pending_trusted_approval'].includes(existing.state)
        && existing.new_device_ciphertext === normalizedCiphertext
        && existing.new_device_cipher === normalizedCipher
      ) {
        enrollment = existing;
      } else {
        enrollment = null;
      }
      if (!enrollment) {
        return res.status(409).json({
          status: 'error',
          error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment cannot accept this device request' }
        } as ApiResponse);
      }
    } else {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Enrollment reservation not found' }
      } as ApiResponse);
    }

    // Push directly to the exact trusted device that generated the QR.
    if (trustedDeviceId) {
      sendToDeviceWs(trustedDeviceId.trim(), {
        type: 'enrollment:request',
        data: { enrollmentId: enrollment.enrollment_id },
        timestamp: Date.now()
      });
    }

    return res.json({
      status: 'ok',
      result: {
        enrollmentId: enrollment.enrollment_id,
        expiresAt: enrollment.expires_at.toISOString()
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Create device enrollment error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to create device enrollment' }
    } as ApiResponse);
  }
});

router.post('/:enrollmentId/validate-recovery', rlCreateEnrollment, async (req: TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    const enrollment = await deviceEnrollmentRepository.findByEnrollmentId(familyId, req.params.enrollmentId);
    if (!enrollment) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Enrollment not found' } } as ApiResponse);
    }
    if (enrollment.state !== 'reserved' || isEnrollmentExpired(enrollment.enrollment_expires_at || enrollment.expires_at)) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment is not available for Profile Key recovery' } } as ApiResponse);
    }
    const trustedDeviceId = String(req.body?.trustedDeviceId || '').trim();
    const identityPublicKey = String(req.body?.identityPublicKey || '').trim();
    if (!trustedDeviceId || trustedDeviceId !== enrollment.requested_trusted_device_id || !identityPublicKey) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Recovery validation request is malformed' } } as ApiResponse);
    }
    const identity = enrollment.requested_identity_id
      ? await identityRepository.findByIdentityId(familyId, enrollment.requested_identity_id as IdentityId)
      : null;
    if (!identity || identity.public_key_value !== identityPublicKey) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Enrollment identity does not match the connection QR' } } as ApiResponse);
    }
    return res.json({ status: 'ok', result: { enrollmentId: enrollment.enrollment_id, state: 'reserved' } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Validate device enrollment recovery error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to validate Profile Key recovery' } } as ApiResponse);
  }
});


export default router;
