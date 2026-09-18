import { createNonceStore, validateSignedRequestEnvelope, consumeSignedRequestEnvelope } from '../middleware/auth';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { identityRepository, deviceRepository } from '../db/repositories';
import { verifySignedRequest } from '../utils/crypto';
import { normalizeTrustedOrigin } from '../utils/trustedOrigins';
import type { TenancyRequest } from '../middleware/tenancy';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { getRateLimitRuntimeConfig, getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';
import { DeviceRegistrationError, registerIdentityDevice } from '../services/deviceRegistrationService';
import {
  auditDeviceEncryptionPublicKey,
  hasDeviceRegistrationAttestationShape
} from '../utils/deviceEncryptionKeyAudit';
import type {
  RegisterDevicePayload,
  ApiResponse,
  ErrorCode,
  DeviceRecord,
  DeviceRegistrationAttestation,
  PublicKey,
  SignedRequest,
  IdentityId
} from '../../../shared/types';

const router = Router();
const authRateLimits = getRateLimitRuntimeConfig().auth;
const rlRegisterDevice = createRateLimiter({
  name: 'auth:register-device',
  windowMs: authRateLimits.windowMs,
  max: authRateLimits.registerDeviceMax,
  keyFn: ipFamilyKey
});
const usedRegistrationNonces = createNonceStore();
function parseRegistrationAttestation(value: unknown): DeviceRegistrationAttestation | null {
  if (!value) return null;
  if (typeof value === 'object') return value as DeviceRegistrationAttestation;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return null; } }
  return null;
}

router.post('/register-device', rlRegisterDevice, async (req, res) => {
  try {
    const { familyId, circleId } = req as TenancyRequest;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      } as ApiResponse);
    }

    const signedRequest = req.body as SignedRequest<RegisterDevicePayload, IdentityId>;

    if (!signedRequest?.vpsId || !signedRequest.circleId) {
      return res.status(426).json({
        status: 'error',
        error: { code: 'CLIENT_UPDATE_REQUIRED' as ErrorCode, message: 'This server requires a newer Circlus client' }
      } as ApiResponse);
    }
    if (signedRequest.vpsId !== getServerIdentityRuntimeConfig().vpsId || signedRequest.circleId !== circleId) {
      return res.status(401).json({
        status: 'error',
        error: { code: 'INVALID_SIGNATURE' as ErrorCode, message: 'Device registration targets another Circle' }
      } as ApiResponse);
    }

    if (!signedRequest?.signature) {
      return res.status(401).json({
        status: 'error',
        error: {
          code: 'UNAUTHORIZED' as ErrorCode,
          message: 'Missing signature'
        }
      } as ApiResponse);
    }

    const envelope = validateSignedRequestEnvelope(signedRequest, usedRegistrationNonces);
    if (!envelope.ok) return res.status(envelope.status).json({ status: 'error', error: { code: envelope.code, message: envelope.message } });

    if (signedRequest.type !== 'auth:register-device') {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Invalid request type'
        }
      } as ApiResponse);
    }

    const payload = signedRequest.payload;

    if (!payload.devicePublicKey) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Missing required fields'
        }
      } as ApiResponse);
    }

    if (!payload.deviceId || !/^device-[A-Za-z0-9_-]{8,80}$/.test(payload.deviceId)) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Invalid deviceId'
        }
      } as ApiResponse);
    }

    if (payload.devicePublicKey.algorithm !== 'ed25519') {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Unsupported device public key algorithm'
        }
      } as ApiResponse);
    }

    if (payload.deviceEncryptionPublicKey && payload.deviceEncryptionPublicKey.algorithm !== 'x25519') {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Unsupported device encryption public key algorithm'
        }
      } as ApiResponse);
    }

    if (payload.deviceEncryptionPublicKey) {
      const binding = payload.deviceKeyBinding;
      if (!binding || binding.type !== 'device:key-binding') {
        return res.status(400).json({
          status: 'error',
          error: {
            code: 'INVALID_STATE' as ErrorCode,
            message: 'deviceKeyBinding is required when deviceEncryptionPublicKey is present'
          }
        } as ApiResponse);
      }
      const bindingPayload = binding.payload;
      const bindingMatches =
        bindingPayload?.version === 1 &&
        bindingPayload?.purpose === 'device-key-binding-v1' &&
        bindingPayload?.identityId === signedRequest.signerId &&
        bindingPayload?.devicePublicKey?.algorithm === payload.devicePublicKey.algorithm &&
        bindingPayload?.devicePublicKey?.value === payload.devicePublicKey.value &&
        bindingPayload?.deviceEncryptionPublicKey?.algorithm === payload.deviceEncryptionPublicKey.algorithm &&
        bindingPayload?.deviceEncryptionPublicKey?.value === payload.deviceEncryptionPublicKey.value;
      if (!bindingMatches || !verifySignedRequest(binding, payload.devicePublicKey)) {
        return res.status(401).json({
          status: 'error',
          error: {
            code: 'INVALID_SIGNATURE' as ErrorCode,
            message: 'Invalid device key binding signature'
          }
        } as ApiResponse);
      }
    }

    const deviceLabel = typeof payload.deviceLabel === 'string'
      ? payload.deviceLabel.trim().slice(0, 80)
      : '';
    const webOrigin = normalizeTrustedOrigin(req.get('origin'));

    const signerIdentityId = signedRequest.signerId;
    if (!signerIdentityId) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Missing identityId'
        }
      } as ApiResponse);
    }

    // Defensive: `SignedRequest.signerId` is the signer identifier.
    // For this route we expect it to carry an identityId, not a deviceId like `device-...`.
    if (signerIdentityId.startsWith('device-')) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Expected identityId in signedRequest.signerId'
        }
      } as ApiResponse);
    }

    // Check identity exists
    const identity = await identityRepository.findByIdentityId(familyId, signerIdentityId);

    if (!identity) {
      return res.status(404).json({
        status: 'error',
        error: {
          code: 'NOT_FOUND' as ErrorCode,
          message: 'Identity not found'
        }
      } as ApiResponse);
    }

    if (identity.status !== 'active') {
      return res.status(403).json({
        status: 'error',
        error: {
          code: 'IDENTITY_DISABLED' as ErrorCode,
          message: 'Identity is disabled'
        }
      } as ApiResponse);
    }

    const identityPublicKey: PublicKey = {
      algorithm: identity.public_key_algorithm as 'ed25519' | 'x25519',
      value: identity.public_key_value
    };

    if (identityPublicKey.algorithm !== 'ed25519') {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Unsupported identity public key algorithm'
        }
      } as ApiResponse);
    }

    const isValid = verifySignedRequest(signedRequest, identityPublicKey);

    if (!isValid) {
      return res.status(401).json({
        status: 'error',
        error: {
          code: 'INVALID_SIGNATURE' as ErrorCode,
          message: 'Invalid signature'
        }
      } as ApiResponse);
    }

    const consumed = await consumeSignedRequestEnvelope(signedRequest, usedRegistrationNonces);
    if (!consumed.ok) return res.status(consumed.status).json({ status: 'error', error: { code: consumed.code, message: consumed.message } });

    const registrationAttestation: DeviceRegistrationAttestation | null =
      payload.deviceEncryptionPublicKey && payload.deviceKeyBinding
        ? {
            version: 1,
            identitySignedRequest: signedRequest,
            deviceKeyBinding: payload.deviceKeyBinding
          }
        : null;

    if (!payload.deviceEncryptionPublicKey || !registrationAttestation) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Device encryption public key and key binding are required'
        }
      } as ApiResponse);
    }
    const requestedEncryptionKeyAudit = auditDeviceEncryptionPublicKey(
      payload.devicePublicKey.value,
      payload.deviceEncryptionPublicKey.value
    );
    if (requestedEncryptionKeyAudit !== 'independent') {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Device must use an independent encryption public key'
        }
      } as ApiResponse);
    }

    // Idempotency / replay-safe: if this device public key is already registered, return it
    const existingByPublicKey = await deviceRepository.findByPublicKey(familyId, payload.devicePublicKey.value);
    if (existingByPublicKey) {
      if (existingByPublicKey.identity_id !== signerIdentityId) {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'INVALID_STATE' as ErrorCode,
            message: 'Device public key already registered to a different identity'
          }
        } as ApiResponse);
      }

      const existingEncryptionValue = (existingByPublicKey as any).encryption_public_key_value || null;
      const requestedEncryptionValue = payload.deviceEncryptionPublicKey.value;

      const existingEncryptionKeyAudit = existingEncryptionValue
        ? auditDeviceEncryptionPublicKey(payload.devicePublicKey.value, existingEncryptionValue)
        : null;
      if (
        existingByPublicKey.public_key_algorithm !== 'ed25519'
        || (existingByPublicKey as any).encryption_public_key_algorithm !== 'x25519'
        || existingEncryptionKeyAudit !== 'independent'
        || !hasDeviceRegistrationAttestationShape((existingByPublicKey as any).registration_attestation)
      ) {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'INVALID_STATE' as ErrorCode,
            message: 'Existing device does not satisfy current registration requirements; revoke and enroll it again'
          }
        } as ApiResponse);
      }
      if (existingEncryptionValue !== requestedEncryptionValue) {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'INVALID_STATE' as ErrorCode,
            message: 'Device encryption public key does not match existing device'
          }
        } as ApiResponse);
      }
      const existingDevice = payload.encryptedPhysicalDeviceId
        ? await deviceRepository.updateEncryptedPhysicalDeviceId(
            familyId,
            existingByPublicKey.device_id,
            payload.encryptedPhysicalDeviceId
          ) || existingByPublicKey
        : existingByPublicKey;

      const result: DeviceRecord = {
        deviceId: existingDevice.device_id,
        identityId: existingDevice.identity_id,
        publicKey: {
          algorithm: existingDevice.public_key_algorithm as 'ed25519' | 'x25519',
          value: existingDevice.public_key_value
        },
        encryptionPublicKey: (existingDevice as any).encryption_public_key_value
          ? {
              algorithm: (existingDevice as any).encryption_public_key_algorithm as 'x25519',
              value: (existingDevice as any).encryption_public_key_value
          }
          : null,
        registrationAttestation: parseRegistrationAttestation((existingDevice as any).registration_attestation),
        label: existingDevice.label,
        webOrigin: (existingDevice as any).web_origin || null,
        encryptedPhysicalDeviceId: (existingDevice as any).encrypted_physical_device_id || null,
        createdAt: existingDevice.created_at.toISOString(),
        status: existingDevice.status as 'active' | 'revoked'
      };

      return res.json({
        status: 'ok',
        result
      } as ApiResponse);
    }

    const existingById = await deviceRepository.findByDeviceId(familyId, payload.deviceId);
    if (existingById && existingById.public_key_value !== payload.devicePublicKey.value) {
      return res.status(409).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Device id already registered with a different public key'
        }
      } as ApiResponse);
    }

    const { device } = await registerIdentityDevice({
      familyId,
      identityId: signerIdentityId,
      deviceId: payload.deviceId,
      devicePublicKey: payload.devicePublicKey,
      deviceEncryptionPublicKey: payload.deviceEncryptionPublicKey,
      registrationAttestation,
      label: deviceLabel || null,
      webOrigin,
      encryptedPhysicalDeviceId: payload.encryptedPhysicalDeviceId || null
    });

    const result: DeviceRecord = {
      deviceId: device.device_id,
      identityId: device.identity_id,
      publicKey: {
        algorithm: device.public_key_algorithm as 'ed25519' | 'x25519',
        value: device.public_key_value
      },
      encryptionPublicKey: (device as any).encryption_public_key_value
        ? {
            algorithm: (device as any).encryption_public_key_algorithm as 'x25519',
            value: (device as any).encryption_public_key_value
        }
        : null,
      registrationAttestation: parseRegistrationAttestation((device as any).registration_attestation),
      label: device.label,
      webOrigin: (device as any).web_origin || null,
      encryptedPhysicalDeviceId: (device as any).encrypted_physical_device_id || null,
      createdAt: device.created_at.toISOString(),
      status: device.status as 'active' | 'revoked'
    };

    return res.json({
      status: 'ok',
      result
    } as ApiResponse);

  } catch (error) {
    if (error instanceof DeviceRegistrationError) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: error.message }
      } as ApiResponse);
    }
    routeLogger.error('Register device error:', error);
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
 * Get encrypted identity private key by public key (public endpoint for device recovery)
 * Safe because encrypted with user's master key
 */

export default router;
