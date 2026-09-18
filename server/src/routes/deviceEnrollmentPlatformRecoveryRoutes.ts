import { versionedAccessOperation } from '../services/versionedAccessOperation';
import crypto from 'crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import {
  PLATFORM_RECOVERY_REVOCATION_PURPOSE,
  PLATFORM_RECOVERY_REVOCATION_TYPE,
  PLATFORM_RECOVERY_VERSION,
  ANDROID_PLATFORM_RECOVERY_SLOT,
  IOS_PLATFORM_RECOVERY_SLOT,
  createPlatformRecoveryChallenge,
  type BeginPlatformRecoveryEnrollmentRequest,
  type BeginPlatformRecoveryEnrollmentResponse,
  type PlatformRecoveryBinding,
  type PlatformRecoveryProofBundle,
  type PlatformRecoveryRevocation
} from '../../../shared/platformRecovery';
import {
  getSignedPayload,
  requireActiveIdentity,
  requireFullCircleIdentity,
  verifySignature,
  type AuthRequest
} from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import { identityRepository } from '../db/repositories';
import { deviceEnrollmentRepository } from '../db/repositories/deviceEnrollmentRepository';
import { platformRecoveryRepository } from '../db/repositories/platformRecoveryRepository';
import { loadPlatformRecoveryRuntimeConfig } from '../config/platformRecoveryRuntimeConfig';
import { verifySignedRequest, verifySignature as verifyRawSignature } from '../utils/crypto';
import { normalizeTrustedOrigin } from '../utils/trustedOrigins';
import { sendToIdentityWs } from '../ws/wsGateway';
import {
  isValidPlatformRecoveryBindingShape,
  isValidSubmittedPlatformRecoveryProof
} from '../services/platformRecoveryEnrollmentValidation';
import {
  createEnrollmentRateLimiter,
  deviceEnrollmentPolicies,
  getRequestIp,
  isEnrollmentExpired
} from './deviceEnrollmentRouteSupport';

const router = Router();

function asyncHandler<TRequest extends Request>(
  handler: (req: TRequest, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void handler(req as TRequest, res, next).catch(next);
  };
}

router.use((req, res, next) => {
  if (!loadPlatformRecoveryRuntimeConfig().enabled) {
    return res.status(404).json({
      status: 'error',
      error: { code: 'NOT_FOUND' as ErrorCode, message: 'Platform recovery is disabled' }
    } as ApiResponse);
  }
  next();
});

router.post('/platform-recovery/bind', verifySignature, requireActiveIdentity, requireFullCircleIdentity, versionedAccessOperation(async (
  req: AuthRequest<{ binding?: PlatformRecoveryBinding }> & TenancyRequest,
  res
) => {
  const familyId = req.familyId;
  const identityId = req.device?.identityId || '';
  if (!familyId || !identityId) return res.status(500).json({ status: 'error' } as ApiResponse);
  const { binding } = getSignedPayload<{ binding?: PlatformRecoveryBinding }>(req);
  const identity = await identityRepository.findByIdentityId(familyId, identityId);
  const identityPublicKey = identity?.public_key_algorithm === 'ed25519' && {
    algorithm: 'ed25519' as const,
    value: identity.public_key_value
  } as const;
  if (!binding || !identityPublicKey || !isValidPlatformRecoveryBindingShape(binding, identityId)
    || !verifySignedRequest(binding, identityPublicKey)) {
    return res.status(400).json({
      status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Identity-signed recovery binding is invalid' }
    } as ApiResponse);
  }
  await platformRecoveryRepository.replaceActiveBinding({ familyId, identityId, binding });
  return res.json({ status: 'ok', result: { bindingId: binding.payload.bindingId, state: 'active' } } as ApiResponse);
}));

router.post('/platform-recovery/revoke', verifySignature, requireActiveIdentity, requireFullCircleIdentity, versionedAccessOperation(async (
  req: AuthRequest<{ revocation?: PlatformRecoveryRevocation }> & TenancyRequest,
  res
) => {
  const familyId = req.familyId;
  const identityId = req.device?.identityId || '';
  if (!familyId || !identityId) return res.status(500).json({ status: 'error' } as ApiResponse);
  const { revocation } = getSignedPayload<{ revocation?: PlatformRecoveryRevocation }>(req);
  const payload = revocation?.payload;
  const identity = await identityRepository.findByIdentityId(familyId, identityId);
  const identityPublicKey = identity?.public_key_algorithm === 'ed25519' && {
    algorithm: 'ed25519' as const,
    value: identity.public_key_value
  } as const;
  if (!revocation || !identityPublicKey
    || revocation.type !== PLATFORM_RECOVERY_REVOCATION_TYPE
    || revocation.signerId !== identityId
    || payload?.version !== PLATFORM_RECOVERY_VERSION
    || payload.purpose !== PLATFORM_RECOVERY_REVOCATION_PURPOSE
    || payload.identityId !== identityId
    || ![ANDROID_PLATFORM_RECOVERY_SLOT, IOS_PLATFORM_RECOVERY_SLOT].includes(payload.recoverySlot)
    || !payload.bindingId?.trim()
    || !Number.isFinite(Date.parse(payload.revokedAt))
    || !verifySignedRequest(revocation, identityPublicKey)) {
    return res.status(400).json({
      status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Identity-signed recovery revocation is invalid' }
    } as ApiResponse);
  }
  await platformRecoveryRepository.revokeActiveBinding(
    familyId,
    identityId,
    payload.bindingId,
    payload.recoverySlot
  );
  return res.json({ status: 'ok', result: { bindingId: payload.bindingId, state: 'revoked' } } as ApiResponse);
}));

router.post('/platform-recovery/enrollments', createEnrollmentRateLimiter, asyncHandler(async (req: TenancyRequest, res) => {
  const familyId = req.familyId;
  if (!familyId) return res.status(500).json({ status: 'error' } as ApiResponse);
  const body = req.body as Partial<BeginPlatformRecoveryEnrollmentRequest>;
  const locator = body.locator;
  if (!locator
    || locator.version !== PLATFORM_RECOVERY_VERSION
    || locator.purpose !== 'circlus-platform-recovery-locator-v1'
    || !body.newDeviceId?.trim()
    || body.newDeviceSigningPublicKey?.algorithm !== 'ed25519'
    || body.newDeviceEncryptionPublicKey?.algorithm !== 'x25519'
    || !body.clientNonce?.trim()) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Recovery enrollment request is malformed' } } as ApiResponse);
  }
  const active = await platformRecoveryRepository.findActiveBinding(
    familyId, locator.identityId, locator.bindingId
  );
  if (!active || active.binding.payload.circleOrigin !== locator.circleOrigin
    || active.binding.payload.identityId !== locator.identityId
    || active.binding.payload.bindingId !== locator.bindingId
    || active.binding.payload.recoverySlot !== locator.recoverySlot
    || active.binding.signerId !== locator.identityId) {
    return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Active recovery binding was not found' } } as ApiResponse);
  }
  const identity = await identityRepository.findByIdentityId(familyId, locator.identityId);
  if (!identity
    || identity.public_key_algorithm !== locator.identityPublicKey.algorithm
    || identity.public_key_value !== locator.identityPublicKey.value
    || !isValidPlatformRecoveryBindingShape(active.binding, locator.identityId)
    || !verifySignedRequest(active.binding, locator.identityPublicKey)) {
    return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Recovery identity anchor is invalid' } } as ApiResponse);
  }
  const enrollmentId = `pre_${crypto.randomUUID().replace(/-/g, '')}`;
  const expiresAtMs = Math.min(
    Date.now() + deviceEnrollmentPolicies.reservationTtlMs,
    Date.parse(active.binding.payload.expiresAt)
  );
  const transcript = {
    version: PLATFORM_RECOVERY_VERSION,
    purpose: 'circlus-platform-recovery-enrollment-v1' as const,
    bindingId: locator.bindingId,
    circleOrigin: locator.circleOrigin,
    identityId: locator.identityId,
    enrollmentId,
    newDeviceId: body.newDeviceId,
    newDeviceSigningPublicKey: body.newDeviceSigningPublicKey,
    newDeviceEncryptionPublicKey: body.newDeviceEncryptionPublicKey,
    clientNonce: body.clientNonce,
    serverNonce: crypto.randomBytes(32).toString('base64url'),
    expiresAt: new Date(expiresAtMs).toISOString()
  };
  const authenticator = active.binding.payload.authenticator;
  const requestJson = authenticator.kind === 'android_restore_webauthn'
    ? JSON.stringify({
        challenge: await createPlatformRecoveryChallenge(transcript),
        rpId: authenticator.rpId,
        allowCredentials: [{ type: 'public-key', id: authenticator.credentialId }],
        timeout: Math.max(1, expiresAtMs - Date.now()),
        userVerification: 'preferred'
      })
    : undefined;
  const result: BeginPlatformRecoveryEnrollmentResponse = {
    binding: active.binding,
    transcript,
    ...(requestJson ? { requestJson } : {})
  };
  const reserved = await platformRecoveryRepository.reserveEnrollment({
    familyId,
    identityId: locator.identityId,
    enrollmentId,
    bindingId: locator.bindingId,
    expiresAt: new Date(expiresAtMs),
    request: result
  });
  if (!reserved) return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Recovery enrollment collision' } } as ApiResponse);
  return res.json({ status: 'ok', result } as ApiResponse<BeginPlatformRecoveryEnrollmentResponse>);
}));

router.post('/platform-recovery/enrollments/:enrollmentId/proof', createEnrollmentRateLimiter, asyncHandler(async (req: TenancyRequest, res) => {
  const familyId = req.familyId;
  if (!familyId) return res.status(500).json({ status: 'error' } as ApiResponse);
  const enrollment = await deviceEnrollmentRepository.findByEnrollmentId(familyId, req.params.enrollmentId);
  const proof = (req.body as { proofBundle?: PlatformRecoveryProofBundle }).proofBundle;
  const stored = enrollment?.platform_recovery_request;
  if (!enrollment || enrollment.enrollment_kind !== 'platform_recovery' || !stored || !proof
    || !isValidSubmittedPlatformRecoveryProof({
      proof,
      stored,
      verifyNewDeviceSignature: (message, signature) => verifyRawSignature(
        message,
        signature,
        proof.transcript.newDeviceSigningPublicKey
      ),
      verifyPlatformSignature: (message, signature, binding) => {
        const authenticator = binding.payload.authenticator;
        return authenticator.kind === 'ios_synced_key'
          && verifyRawSignature(message, signature, authenticator.publicKey);
      }
    })) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Recovery proof bundle is invalid' } } as ApiResponse);
  }
  if (isEnrollmentExpired(enrollment.enrollment_expires_at || enrollment.expires_at)) {
    return res.status(410).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Recovery enrollment expired' } } as ApiResponse);
  }
  const submitted = await platformRecoveryRepository.submitProof({
    familyId,
    enrollmentId: enrollment.enrollment_id,
    proof,
    origin: normalizeTrustedOrigin(req.get('origin')),
    requestIp: getRequestIp(req),
    requestUserAgent: String(req.get('user-agent') || '').trim() || null
  });
  if (!submitted) return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Recovery proof was already submitted' } } as ApiResponse);
  sendToIdentityWs(familyId, proof.transcript.identityId, {
    type: 'enrollment:platform-recovery-request',
    data: { enrollmentId: enrollment.enrollment_id, bindingId: proof.transcript.bindingId },
    timestamp: Date.now()
  });
  return res.json({ status: 'ok', result: { enrollmentId: enrollment.enrollment_id, state: 'pending_trusted_read' } } as ApiResponse);
}));

router.post('/:enrollmentId/read-platform-recovery', verifySignature, requireActiveIdentity, requireFullCircleIdentity, asyncHandler(async (
  req: AuthRequest<{ trustedDeviceId?: string }> & TenancyRequest,
  res
) => {
  const familyId = req.familyId;
  const trustedDeviceId = req.device?.deviceId || '';
  const identityId = req.device?.identityId || '';
  if (!familyId) return res.status(500).json({ status: 'error' } as ApiResponse);
  const signed = getSignedPayload<{ trustedDeviceId?: string }>(req);
  const enrollment = await deviceEnrollmentRepository.findByEnrollmentId(familyId, req.params.enrollmentId);
  if (!enrollment || enrollment.enrollment_kind !== 'platform_recovery'
    || enrollment.requested_identity_id !== identityId
    || signed.trustedDeviceId !== trustedDeviceId) {
    return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Recovery enrollment was not found' } } as ApiResponse);
  }
  if (!enrollment.platform_recovery_proof || !['pending_trusted_read', 'pending_trusted_approval'].includes(enrollment.state)) {
    return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Recovery proof is not ready' } } as ApiResponse);
  }
  return res.json({ status: 'ok', result: {
    proofBundle: enrollment.platform_recovery_proof,
    requestIp: enrollment.request_ip,
    requestUserAgent: enrollment.request_user_agent,
    requestedAt: enrollment.created_at.toISOString(),
    expiresAt: (enrollment.enrollment_expires_at || enrollment.expires_at).toISOString()
  } } as ApiResponse);
}));

router.post('/:enrollmentId/accept-platform-recovery', verifySignature, requireActiveIdentity, requireFullCircleIdentity, asyncHandler(async (
  req: AuthRequest<{ trustedDeviceId?: string; bindingId?: string }> & TenancyRequest,
  res
) => {
  const familyId = req.familyId;
  const trustedDeviceId = req.device?.deviceId || '';
  const identityId = req.device?.identityId || '';
  if (!familyId) return res.status(500).json({ status: 'error' } as ApiResponse);
  const payload = getSignedPayload<{ trustedDeviceId?: string; bindingId?: string }>(req);
  if (payload.trustedDeviceId !== trustedDeviceId || !payload.bindingId) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Verified recovery acceptance is malformed' } } as ApiResponse);
  }
  const accepted = await platformRecoveryRepository.acceptVerifiedEnrollment({
    familyId,
    enrollmentId: req.params.enrollmentId,
    identityId,
    trustedDeviceId,
    bindingId: payload.bindingId
  });
  if (!accepted) return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Recovery enrollment cannot be accepted' } } as ApiResponse);
  return res.json({ status: 'ok', result: { enrollmentId: req.params.enrollmentId, state: 'pending_trusted_approval' } } as ApiResponse);
}));

export default router;
