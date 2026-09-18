import { requireOwnDeviceManagement } from '../middleware/ownDeviceAccess';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import type { ApiResponse, ErrorCode, SignedRequest } from '../../../shared/types';
import {
  verifySignature,
  requireActiveIdentity,
  getSignedPayload,
  type AuthRequest,
  validateSignedRequestEnvelope,
  consumeSignedRequestEnvelope
} from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import { deviceEnrollmentRepository } from '../db/repositories/deviceEnrollmentRepository';
import { deviceRepository } from '../db/repositories';
import { verifySignedRequest } from '../utils/crypto';
import { sendToDeviceWs } from '../ws/wsGateway';
import {
  isEnrollmentExpired,
  readEnrollmentPayloadRateLimiter as rlReadPayload,
  usedEnrollmentActivationNonces,
  usedEnrollmentReadNonces
} from './deviceEnrollmentRouteSupport';

const router = Router();
router.post('/:enrollmentId/payload', rlReadPayload, async (req: TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const enrollment = await deviceEnrollmentRepository.findByEnrollmentId(familyId, req.params.enrollmentId);
    if (!enrollment) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Enrollment not found' }
      } as ApiResponse);
    }

    if (isEnrollmentExpired(enrollment.payload_expires_at || enrollment.enrollment_expires_at || enrollment.expires_at)) {
      await deviceEnrollmentRepository.expireStaleEnrollments();
      return res.status(410).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment expired' }
      } as ApiResponse);
    }

    // Reading the payload must be idempotent. The client may receive the
    // payload but lose the HTTP response, or fail while applying it locally.
    // In both cases it must be able to retry with a fresh signed request.
    if (enrollment.state !== 'approved' && enrollment.state !== 'consumed' && enrollment.state !== 'activated') {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Payload is not available yet' }
      } as ApiResponse);
    }

    if (!enrollment.new_device_id || !enrollment.new_device_public_key_value || !enrollment.new_device_public_key_algorithm) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Approved enrollment is missing new device metadata' }
      } as ApiResponse);
    }

    const signedRequest = req.body as SignedRequest<{ enrollmentId?: string }, string>;
    const now = Date.now();
    const envelopeCheck = validateSignedRequestEnvelope(signedRequest, usedEnrollmentReadNonces, now);
    if (!envelopeCheck.ok) {
      return res.status(envelopeCheck.status).json({
        status: 'error',
        error: { code: envelopeCheck.code, message: envelopeCheck.message }
      } as ApiResponse);
    }

    if (signedRequest.type !== 'device-enrollment:read-payload') {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid request type' }
      } as ApiResponse);
    }

    if (signedRequest.signerId !== enrollment.new_device_id) {
      return res.status(401).json({
        status: 'error',
        error: { code: 'UNAUTHORIZED' as ErrorCode, message: 'Enrollment payload signer does not match new device' }
      } as ApiResponse);
    }

    if ((signedRequest.payload?.enrollmentId || '') !== enrollment.enrollment_id) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Enrollment payload request is malformed' }
      } as ApiResponse);
    }

    const isValid = verifySignedRequest(signedRequest, {
      algorithm: enrollment.new_device_public_key_algorithm,
      value: enrollment.new_device_public_key_value
    });

    if (!isValid) {
      return res.status(401).json({
        status: 'error',
        error: { code: 'INVALID_SIGNATURE' as ErrorCode, message: 'Invalid signature' }
      } as ApiResponse);
    }

    const finalEnvelope = await consumeSignedRequestEnvelope(signedRequest, usedEnrollmentReadNonces);
    if (!finalEnvelope.ok) {
      return res.status(finalEnvelope.status).json({
        status: 'error', error: { code: finalEnvelope.code, message: finalEnvelope.message }
      } as ApiResponse);
    }

    if (enrollment.state === 'approved') {
      await deviceEnrollmentRepository.markConsumed(familyId, enrollment.enrollment_id);
    }

    return res.json({
      status: 'ok',
      result: {
        state: 'approved',
        encryptedTemporaryMembership: enrollment.encrypted_temporary_membership,
        cipher: enrollment.cipher,
        temporaryAccessExpiresAt: enrollment.temporary_access_expires_at?.toISOString() || null,
        approvalSenderPublicKey: enrollment.approval_sender_public_key_value
          ? {
              algorithm: enrollment.approval_sender_public_key_algorithm || 'ed25519',
              value: enrollment.approval_sender_public_key_value
            }
          : null
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Read device enrollment payload error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to read device enrollment payload' }
    } as ApiResponse);
  }
});

router.post('/:enrollmentId/activate', rlReadPayload, async (req: TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    const enrollment = await deviceEnrollmentRepository.findByEnrollmentId(familyId, req.params.enrollmentId);
    if (!enrollment) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Enrollment not found' } } as ApiResponse);
    }
    if (enrollment.state !== 'consumed' && enrollment.state !== 'activated') {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment payload has not been delivered' } } as ApiResponse);
    }
    if (!enrollment.new_device_id || !enrollment.new_device_public_key_value || !enrollment.new_device_public_key_algorithm) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment device metadata is missing' } } as ApiResponse);
    }

    const signedRequest = req.body as SignedRequest<{ enrollmentId?: string; activatedDeviceId?: string }, string>;
    const now = Date.now();
    const envelopeCheck = validateSignedRequestEnvelope(signedRequest, usedEnrollmentActivationNonces, now);
    if (!envelopeCheck.ok) {
      return res.status(envelopeCheck.status).json({ status: 'error', error: { code: envelopeCheck.code, message: envelopeCheck.message } } as ApiResponse);
    }
    if (signedRequest.type !== 'device-enrollment:activate' || signedRequest.signerId !== enrollment.new_device_id || signedRequest.payload?.enrollmentId !== enrollment.enrollment_id) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid enrollment activation request' } } as ApiResponse);
    }
    if (!verifySignedRequest(signedRequest, { algorithm: enrollment.new_device_public_key_algorithm, value: enrollment.new_device_public_key_value })) {
      return res.status(401).json({ status: 'error', error: { code: 'INVALID_SIGNATURE' as ErrorCode, message: 'Invalid signature' } } as ApiResponse);
    }

    if (enrollment.access_mode === 'full_circle') {
      const activatedDeviceId = String(signedRequest.payload?.activatedDeviceId || '').trim();
      const approvingDeviceId = enrollment.approved_by_device_id || '';
      const [activatedDevice, approvingDevice] = await Promise.all([
        activatedDeviceId ? deviceRepository.findByDeviceId(familyId, activatedDeviceId) : null,
        approvingDeviceId ? deviceRepository.findByDeviceId(familyId, approvingDeviceId) : null
      ]);
      if (!activatedDevice || !approvingDevice || activatedDevice.identity_id !== approvingDevice.identity_id) {
        return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Trusted device registration is not complete' } } as ApiResponse);
      }
    }

    const finalEnvelope = await consumeSignedRequestEnvelope(signedRequest, usedEnrollmentActivationNonces);
    if (!finalEnvelope.ok) {
      return res.status(finalEnvelope.status).json({
        status: 'error', error: { code: finalEnvelope.code, message: finalEnvelope.message }
      } as ApiResponse);
    }

    const activated = enrollment.state === 'activated'
      ? enrollment
      : await deviceEnrollmentRepository.markActivated(familyId, enrollment.enrollment_id);
    if (!activated) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment activation state changed' } } as ApiResponse);
    }
    routeLogger.info('[DeviceEnrollment] activation acknowledged', {
      familyId, enrollmentId: enrollment.enrollment_id,
      enrollmentDeviceId: enrollment.new_device_id,
      activatedDeviceId: signedRequest.payload?.activatedDeviceId || enrollment.new_device_id
    });
    return res.json({ status: 'ok', result: { enrollmentId: enrollment.enrollment_id, state: 'activated' } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Activate device enrollment error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to activate device enrollment' } } as ApiResponse);
  }
});

router.post('/:enrollmentId/recover', verifySignature, requireActiveIdentity, requireOwnDeviceManagement, async (req: AuthRequest<{
  enrollmentId?: string;
  trustedDeviceId?: string;
}> & TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId || !req.device) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    const enrollment = await deviceEnrollmentRepository.findByEnrollmentId(familyId, req.params.enrollmentId);
    if (!enrollment) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Enrollment not found' } } as ApiResponse);
    }
    const { enrollmentId, trustedDeviceId } = getSignedPayload<{ enrollmentId?: string; trustedDeviceId?: string }>(req);
    if (enrollmentId !== enrollment.enrollment_id || trustedDeviceId !== enrollment.requested_trusted_device_id) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Recovery acknowledgement is malformed' } } as ApiResponse);
    }
    if (req.device.identityId !== enrollment.requested_identity_id || req.device.publicKey.algorithm !== 'ed25519') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Recovered device does not belong to the requested Circle identity' } } as ApiResponse);
    }
    if (enrollment.state === 'activated' && enrollment.new_device_id === req.device.deviceId) {
      return res.json({ status: 'ok', result: { enrollmentId: enrollment.enrollment_id, state: 'activated' } } as ApiResponse);
    }
    if (isEnrollmentExpired(enrollment.enrollment_expires_at || enrollment.expires_at)) {
      await deviceEnrollmentRepository.expireStaleEnrollments();
      return res.status(410).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment expired' } } as ApiResponse);
    }
    const activated = await deviceEnrollmentRepository.markRecovered({
      familyId,
      enrollmentId: enrollment.enrollment_id,
      deviceId: req.device.deviceId,
      devicePublicKeyAlgorithm: 'ed25519',
      devicePublicKeyValue: req.device.publicKey.value
    });
    if (!activated) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment cannot be recovered in its current state' } } as ApiResponse);
    }
    if (trustedDeviceId) {
      sendToDeviceWs(trustedDeviceId, {
        type: 'enrollment:request',
        data: { enrollmentId: enrollment.enrollment_id },
        timestamp: Date.now()
      });
    }
    return res.json({ status: 'ok', result: { enrollmentId: enrollment.enrollment_id, state: 'activated' } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Recover device enrollment error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to acknowledge recovered device' } } as ApiResponse);
  }
});


export default router;
