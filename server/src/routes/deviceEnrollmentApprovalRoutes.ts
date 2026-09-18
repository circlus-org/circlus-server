import { requireOwnDeviceManagement, requireOwnDeviceEnrollmentMode } from '../middleware/ownDeviceAccess';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import type { ApiResponse, ErrorCode, PublicKey } from '../../../shared/types';
import {
  verifySignature,
  requireActiveIdentity,
  getSignedPayload,
  type AuthRequest
} from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import { deviceEnrollmentRepository } from '../db/repositories/deviceEnrollmentRepository';
import { deviceRepository, groupChatRepository, messageRepository, temporaryDeviceRepository } from '../db/repositories';
import { resolveDirectCommunicationAccess } from '../services/directGuestAccessService';
import {
  approveDeviceEnrollment,
  DeviceEnrollmentApprovalConflict
} from '../services/deviceEnrollmentApprovalService';
import {
  canonicalChatGrants,
  deviceEnrollmentPolicies,
  isEnrollmentExpired,
  type TemporaryChatGrant
} from './deviceEnrollmentRouteSupport';

const router = Router();
router.post('/:enrollmentId/read-request', verifySignature, requireActiveIdentity, requireOwnDeviceManagement, async (req: AuthRequest<{
  trustedDeviceId?: string;
}> & TenancyRequest, res) => {
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

    if (isEnrollmentExpired(enrollment.enrollment_expires_at || enrollment.expires_at)) {
      await deviceEnrollmentRepository.expireStaleEnrollments();
      return res.status(410).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment expired' }
      } as ApiResponse);
    }

    if (!enrollment.origin_verified || (enrollment.state !== 'pending_trusted_read' && enrollment.state !== 'pending_trusted_approval')) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment is not ready for trusted read' }
      } as ApiResponse);
    }

    const { trustedDeviceId } = getSignedPayload<{ trustedDeviceId?: string }>(req);
    if (!trustedDeviceId || trustedDeviceId !== req.device?.deviceId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'trustedDeviceId must match the authenticated device' }
      } as ApiResponse);
    }
    if (enrollment.requested_trusted_device_id && enrollment.requested_trusted_device_id !== trustedDeviceId) {
      return res.status(403).json({
        status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Enrollment is bound to another trusted device' }
      } as ApiResponse);
    }

    const updated = await deviceEnrollmentRepository.markTrustedRead({
      familyId,
      enrollmentId: enrollment.enrollment_id
    });

    return res.json({
      status: 'ok',
      result: {
        enrollmentId: updated?.enrollment_id || enrollment.enrollment_id,
        origin: enrollment.origin,
        originVerified: enrollment.origin_verified,
        requestIp: enrollment.request_ip,
        requestUserAgent: enrollment.request_user_agent,
        requestedAt: enrollment.created_at.toISOString(),
        expiresAt: enrollment.expires_at.toISOString(),
        newDeviceCiphertext: enrollment.new_device_ciphertext,
        cipher: enrollment.new_device_cipher
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Read device enrollment request error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to read device enrollment request' }
    } as ApiResponse);
  }
});

router.post('/:enrollmentId/complete', (req, res, next) => {
  const traceId = randomUUID();
  const startedAt = Date.now();
  res.locals.deviceEnrollmentTraceId = traceId;
  routeLogger.info('[DeviceEnrollment] completion HTTP request received', {
    traceId,
    enrollmentId: req.params.enrollmentId,
    contentLength: Number(req.get('content-length') || 0) || null
  });
  res.on('finish', () => {
    routeLogger.info('[DeviceEnrollment] completion HTTP response sent', {
      traceId,
      enrollmentId: req.params.enrollmentId,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  next();
}, verifySignature, requireActiveIdentity, requireOwnDeviceManagement, requireOwnDeviceEnrollmentMode, async (req: AuthRequest<{
  trustedDeviceId?: string;
  accessMode?: 'temporary' | 'full_circle';
  temporaryDeviceId?: string;
  temporaryDevicePublicKey?: PublicKey;
  temporaryDeviceEncryptionPublicKey?: PublicKey;
  encryptedTemporaryMembership?: string;
  temporaryAccessExpiresAt?: string;
  cipher?: string;
  chatAccess?: Array<{
    chatId: string;
    chatType: 'group' | 'direct';
    epoch: number;
    envelopeCiphertext: string;
    publisherIdentityId: string;
    publisherEncPublicKeyAlgo: string;
    publisherEncPublicKeyValue: string;
  }>;
  approvalAttestation?: {
    payload: string;
    signature: string;
    approvingDevicePublicKey: string;
  };
  approvalSenderPublicKey?: PublicKey;
}> & TenancyRequest, res) => {
  let completionStage = 'loading_enrollment';
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

    routeLogger.info('[DeviceEnrollment] completion requested', {
      traceId: res.locals.deviceEnrollmentTraceId,
      familyId,
      enrollmentId: enrollment.enrollment_id,
      approvingDeviceId: req.device?.deviceId || null,
      state: enrollment.state
    });

    if (isEnrollmentExpired(enrollment.enrollment_expires_at || enrollment.expires_at)) {
      await deviceEnrollmentRepository.expireStaleEnrollments();
      return res.status(410).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment expired' }
      } as ApiResponse);
    }

    if (enrollment.state !== 'pending_trusted_approval') {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Enrollment cannot be completed in its current state' }
      } as ApiResponse);
    }

    completionStage = 'validating_payload';
    const { trustedDeviceId, accessMode = 'temporary', temporaryDeviceId, temporaryDevicePublicKey, temporaryDeviceEncryptionPublicKey, encryptedTemporaryMembership, temporaryAccessExpiresAt, cipher, chatAccess, approvalAttestation, approvalSenderPublicKey, canCall = false } = getSignedPayload<{
      trustedDeviceId?: string;
      accessMode?: 'temporary' | 'full_circle';
      temporaryDeviceId?: string;
      temporaryDevicePublicKey?: PublicKey;
      temporaryDeviceEncryptionPublicKey?: PublicKey;
      encryptedTemporaryMembership?: string;
      temporaryAccessExpiresAt?: string;
      cipher?: string;
      chatAccess?: Array<{
        chatId: string;
        chatType: 'group' | 'direct';
        epoch: number;
        envelopeCiphertext: string;
        publisherIdentityId: string;
        publisherEncPublicKeyAlgo: string;
        publisherEncPublicKeyValue: string;
      }>;
      approvalAttestation?: {
        payload: string;
        signature: string;
        approvingDevicePublicKey: string;
      };
      approvalSenderPublicKey?: PublicKey;
      canCall?: boolean;
    }>(req);

    if (accessMode !== 'temporary' && accessMode !== 'full_circle') {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'accessMode must be temporary or full_circle' }
      } as ApiResponse);
    }

    if (!trustedDeviceId || trustedDeviceId !== req.device?.deviceId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'trustedDeviceId must match the authenticated device' }
      } as ApiResponse);
    }
    if (enrollment.requested_trusted_device_id && enrollment.requested_trusted_device_id !== trustedDeviceId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Enrollment is bound to another trusted device' } } as ApiResponse);
    }

    if (!temporaryDeviceId || !temporaryDevicePublicKey?.value || temporaryDevicePublicKey.algorithm !== 'ed25519') {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'temporaryDeviceId and ed25519 temporaryDevicePublicKey are required' }
      } as ApiResponse);
    }
    const recoveryTranscript = enrollment.platform_recovery_proof?.transcript;
    if (enrollment.enrollment_kind === 'platform_recovery' && (
      !recoveryTranscript
      || recoveryTranscript.identityId !== req.device?.identityId
      || recoveryTranscript.newDeviceId !== temporaryDeviceId
      || recoveryTranscript.newDeviceSigningPublicKey.algorithm !== temporaryDevicePublicKey.algorithm
      || recoveryTranscript.newDeviceSigningPublicKey.value !== temporaryDevicePublicKey.value
      || recoveryTranscript.newDeviceEncryptionPublicKey.algorithm !== temporaryDeviceEncryptionPublicKey?.algorithm
      || recoveryTranscript.newDeviceEncryptionPublicKey.value !== temporaryDeviceEncryptionPublicKey?.value
    )) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Approved device keys do not match the verified recovery proof' }
      } as ApiResponse);
    }
    if (temporaryDeviceEncryptionPublicKey && temporaryDeviceEncryptionPublicKey.algorithm !== 'x25519') {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'temporaryDeviceEncryptionPublicKey must be x25519' }
      } as ApiResponse);
    }

    if (!encryptedTemporaryMembership || !cipher || !temporaryAccessExpiresAt) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'encryptedTemporaryMembership, temporaryAccessExpiresAt and cipher are required' }
      } as ApiResponse);
    }
    if (enrollment.enrollment_kind === 'platform_recovery'
      && (approvalSenderPublicKey?.algorithm !== 'ed25519' || !approvalSenderPublicKey.value)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Platform recovery approval sender key is required' }
      } as ApiResponse);
    }

    const accessExpiresAt = new Date(temporaryAccessExpiresAt);
    if (Number.isNaN(accessExpiresAt.getTime()) || accessExpiresAt.getTime() <= Date.now()) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'temporaryAccessExpiresAt must be a future ISO date' }
      } as ApiResponse);
    }

    completionStage = 'validating_chat_access';
    const normalizedChatAccess = Array.isArray(chatAccess)
      ? chatAccess.map((item) => ({ ...item, chatId: String(item.chatId || '').trim() }))
      : [];
    const grantKeys = new Set<string>();
    for (const item of normalizedChatAccess) {
      const chatId = String(item.chatId || '').trim();
      const key = `${item.chatType}:${chatId}`;
      if (
        !chatId ||
        (item.chatType !== 'group' && item.chatType !== 'direct') ||
        !Number.isSafeInteger(item.epoch) ||
        item.epoch < 1 ||
        !item.envelopeCiphertext ||
        !item.publisherIdentityId ||
        !item.publisherEncPublicKeyAlgo ||
        !item.publisherEncPublicKeyValue ||
        grantKeys.has(key)
      ) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'chatAccess contains an invalid or unsupported grant' }
        } as ApiResponse);
      }
      if (item.chatType === 'group') {
        const participant = await groupChatRepository.findParticipant(familyId, chatId, req.device!.identityId);
        if (!participant?.is_active) {
          return res.status(403).json({
            status: 'error',
            error: { code: 'FORBIDDEN' as ErrorCode, message: 'Cannot grant a group chat that is not accessible to the approving identity' }
          } as ApiResponse);
        }
      } else {
        const participants = chatId.split('::').map((identityId) => identityId.trim()).filter(Boolean);
        const expectedChatId = [...participants].sort().join('::');
        if (participants.length !== 2 || !participants.includes(req.device!.identityId) || expectedChatId !== chatId) {
          return res.status(400).json({
            status: 'error',
            error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Direct chat grant does not belong to the approving identity' }
          } as ApiResponse);
        }
        const peerIdentityId = participants.find((identityId) => identityId !== req.device!.identityId)!;
        const access = await resolveDirectCommunicationAccess(familyId, req.device!.identityId, peerIdentityId, 'messages');
        const currentEpoch = await messageRepository.getDirectCurrentEpoch(familyId, chatId);
        if (!access.allowed || currentEpoch !== item.epoch) {
          return res.status(403).json({
            status: 'error',
            error: { code: 'FORBIDDEN' as ErrorCode, message: 'Cannot grant an unavailable direct chat epoch' }
          } as ApiResponse);
        }
      }
      grantKeys.add(key);
    }
    if (canCall && !normalizedChatAccess.some((item) => item.chatType === 'direct')) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Call capability requires at least one direct chat grant' }
      } as ApiResponse);
    }
    if (normalizedChatAccess.length > 0) {
      if (!approvalAttestation?.payload || !approvalAttestation.signature || !approvalAttestation.approvingDevicePublicKey) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'approvalAttestation is required for chat access' }
        } as ApiResponse);
      }
      try {
        const attested = JSON.parse(approvalAttestation.payload) as {
          action?: string;
          tempDeviceId?: string;
          encryptionPublicKeyValue?: string | null;
          expiresAt?: string;
          chatGrants?: TemporaryChatGrant[];
          canCall?: boolean;
        };
        const expected = canonicalChatGrants(normalizedChatAccess.map((item) => ({ chatId: item.chatId, chatType: item.chatType })));
        const actual = canonicalChatGrants(Array.isArray(attested.chatGrants) ? attested.chatGrants : []);
        if (
          attested.action !== 'temp-device-approval' ||
          approvalAttestation.approvingDevicePublicKey !== req.device!.publicKey.value ||
          attested.tempDeviceId !== String(temporaryDeviceId).trim() ||
          attested.encryptionPublicKeyValue !== (temporaryDeviceEncryptionPublicKey?.value ?? null) ||
          attested.expiresAt !== temporaryAccessExpiresAt ||
          (attested.canCall === true) !== (canCall === true) ||
          JSON.stringify(actual) !== JSON.stringify(expected)
        ) {
          throw new Error('Attestation scope mismatch');
        }
      } catch {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'approvalAttestation does not match chat access scope' }
        } as ApiResponse);
      }
    }

    completionStage = 'checking_device_keys';
    const existingTrustedDevice = await deviceRepository.findByPublicKey(familyId, temporaryDevicePublicKey.value);
    if (existingTrustedDevice && existingTrustedDevice.identity_id !== req.device?.identityId) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Temporary device key is already registered to another identity' }
      } as ApiResponse);
    }

    const existingTemporaryDevice = await temporaryDeviceRepository.findByPublicKey(familyId, temporaryDevicePublicKey.value);
    if (existingTemporaryDevice && existingTemporaryDevice.identity_id !== req.device?.identityId) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Temporary device key is already used by another temporary device' }
      } as ApiResponse);
    }

    const trimmedDeviceId = String(temporaryDeviceId).trim();
    const payloadTtlMs = deviceEnrollmentPolicies.payloadTtlMs;
    completionStage = 'opening_transaction';
    const updated = await approveDeviceEnrollment({
      familyId,
      enrollmentId: enrollment.enrollment_id,
      approvingIdentityId: req.device!.identityId,
      approvingDeviceId: trustedDeviceId,
      accessMode,
      temporaryDeviceId: trimmedDeviceId,
      temporaryDevicePublicKey,
      temporaryDeviceEncryptionPublicKey,
      encryptedTemporaryMembership,
      cipher,
      accessExpiresAt,
      payloadExpiresAt: new Date(Date.now() + payloadTtlMs),
      approvalSenderPublicKey: enrollment.enrollment_kind === 'platform_recovery'
        ? approvalSenderPublicKey
        : undefined,
      canCall: canCall === true,
      chatAccess: normalizedChatAccess,
      approvalAttestation: approvalAttestation?.payload
        && approvalAttestation.signature
        && approvalAttestation.approvingDevicePublicKey
        ? {
            payload: approvalAttestation.payload,
            signature: approvalAttestation.signature,
            approvingDevicePublicKey: approvalAttestation.approvingDevicePublicKey
          }
        : undefined
    });
    completionStage = 'committed_transaction';

    routeLogger.info('[DeviceEnrollment] completion approved', {
      traceId: res.locals.deviceEnrollmentTraceId,
      familyId,
      enrollmentId: enrollment.enrollment_id,
      approvingDeviceId: trustedDeviceId,
      newDeviceId: String(temporaryDeviceId).trim()
    });

    return res.json({
      status: 'ok',
      result: {
        enrollmentId: updated?.enrollment_id || enrollment.enrollment_id,
        state: 'approved'
      }
    } as ApiResponse);
  } catch (error) {
    if (error instanceof DeviceEnrollmentApprovalConflict) {
      return res.status(409).json({
        status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: error.message }
      } as ApiResponse);
    }
    const failure = error && typeof error === 'object'
      ? error as {
          name?: unknown;
          message?: unknown;
          code?: unknown;
          constraint?: unknown;
          table?: unknown;
          column?: unknown;
        }
      : null;
    const diagnostic = {
      traceId: res.locals.deviceEnrollmentTraceId,
      stage: completionStage,
      errorName: String(failure?.name || 'Error'),
      errorCode: failure?.code ? String(failure.code) : null,
      message: String(failure?.message || error || 'Unknown error'),
      constraint: failure?.constraint ? String(failure.constraint) : null,
      table: failure?.table ? String(failure.table) : null,
      column: failure?.column ? String(failure.column) : null
    };
    // Keep the complete error in stderr, and write a compact, secret-free
    // diagnostic to stdout as well. PM2 installations commonly inspect only
    // the out log, which previously hid the actual failure reason.
    routeLogger.error('Complete device enrollment error:', { ...diagnostic, error });
    routeLogger.info('[DeviceEnrollment] completion failed', diagnostic);
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Failed to complete device enrollment',
        details: {
          traceId: res.locals.deviceEnrollmentTraceId,
          stage: completionStage
        }
      }
    } as ApiResponse);
  }
});


export default router;
