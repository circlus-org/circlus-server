import { requireOwnDeviceManagement } from '../middleware/ownDeviceAccess';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  getSignedPayload,
  requireActiveIdentity,
  verifySignature,
  type AuthRequest
} from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import { deviceEnrollmentRepository } from '../db/repositories/deviceEnrollmentRepository';
import type { ApiResponse, ErrorCode } from '../../../shared/types';

const router = Router();

router.post('/:enrollmentId/status', verifySignature, requireActiveIdentity, requireOwnDeviceManagement, async (req: AuthRequest<{ trustedDeviceId?: string }> & TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    const { trustedDeviceId } = getSignedPayload<{ trustedDeviceId?: string }>(req);
    if (!trustedDeviceId || trustedDeviceId !== req.device?.deviceId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'trustedDeviceId must match the authenticated device' } } as ApiResponse);
    }
    const enrollment = await deviceEnrollmentRepository.findByEnrollmentId(familyId, req.params.enrollmentId);
    if (!enrollment) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Enrollment not found' } } as ApiResponse);
    }
    if (enrollment.approved_by_device_id && enrollment.approved_by_device_id !== trustedDeviceId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Enrollment was approved by another device' } } as ApiResponse);
    }
    if (enrollment.requested_trusted_device_id && enrollment.requested_trusted_device_id !== trustedDeviceId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Enrollment is bound to another trusted device' } } as ApiResponse);
    }
    return res.json({
      status: 'ok',
      result: {
        enrollmentId: enrollment.enrollment_id,
        state: enrollment.state,
        accessMode: enrollment.access_mode,
        activatedAt: enrollment.activated_at?.toISOString() || null
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Read device enrollment status error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to read enrollment status' } } as ApiResponse);
  }
});

router.post('/:enrollmentId/reject', verifySignature, requireActiveIdentity, requireOwnDeviceManagement, async (req: AuthRequest<{ trustedDeviceId?: string }> & TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const { trustedDeviceId } = getSignedPayload<{ trustedDeviceId?: string }>(req);
    if (!trustedDeviceId || trustedDeviceId !== req.device?.deviceId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'trustedDeviceId must match the authenticated device' }
      } as ApiResponse);
    }

    const enrollment = await deviceEnrollmentRepository.findByEnrollmentId(familyId, req.params.enrollmentId);
    if (enrollment?.requested_trusted_device_id && enrollment.requested_trusted_device_id !== trustedDeviceId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Enrollment is bound to another trusted device' } } as ApiResponse);
    }

    const existing = enrollment;
    if (!existing) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Enrollment not found' }
      } as ApiResponse);
    }
    if (existing.state === 'rejected' || existing.state === 'expired') {
      return res.json({
        status: 'ok',
        result: {
          enrollmentId: existing.enrollment_id,
          state: existing.state
        }
      } as ApiResponse);
    }
    const updated = await deviceEnrollmentRepository.markRejected(familyId, req.params.enrollmentId);
    if (!updated) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment cannot be rejected in its current state' }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        enrollmentId: updated.enrollment_id,
        state: 'rejected'
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Reject device enrollment error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to reject device enrollment' }
    } as ApiResponse);
  }
});

export default router;

