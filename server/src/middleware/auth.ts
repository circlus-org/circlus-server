import { claimDurableNonce } from '../services/durableNonce';
import { Request, Response, NextFunction } from 'express';
import { deviceRepository, identityRepository, serverAdminRepository, temporaryDeviceRepository } from '../db/repositories';
import { verifySignedRequest } from '../utils/crypto';
import { normalizeTrustedOrigin } from '../utils/trustedOrigins';
import type { SignedRequest, ErrorCode, DeviceId } from '../../../shared/types';
import { bumpChatEpochsForTemporaryDevice } from '../services/chatEpochRotation';
import { getSecurityRuntimeConfig, getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';
import { communicationRequestBudget, createCommunicationIdentityRateLimiter } from './communicationIdentityRateLimit';
import { getRequestLogger } from './requestContext';
import { getHttpSignedRequestType } from './signedRequestTypes';
import { resolveIdentityAuthorization, type IdentityAuthorization } from '../services/authorizationResolver';
import { getServerIdentityRuntimeConfig } from '../config/serverRuntimeConfig';

type NonceStore = Map<string, number>;
let communicationIdentityLimiter: ReturnType<typeof createCommunicationIdentityRateLimiter> | undefined;

function cleanupNonceStore(store: NonceStore): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of store.entries()) {
    if (now > expiresAt) {
      store.delete(nonce);
    }
  }
}

export function createNonceStore(): NonceStore {
  const store = new Map<string, number>();
  const cleanupTimer = setInterval(() => cleanupNonceStore(store), 10 * 60 * 1000);
  cleanupTimer.unref?.();
  return store;
}

// Fast local mirror; PostgreSQL is authoritative across processes and restarts.
const usedNonces = createNonceStore();

export interface AuthRequest<T = unknown> extends Request {
  familyId?: string;
  circleId?: string;
  signedRequest?: SignedRequest<T, DeviceId>;
  device?: {
    deviceId: string;
    identityId: string;
    publicKey: { algorithm: string; value: string };
    status: string;
    accessLevel?: 'trusted' | 'temporary';
    expiresAt?: string | null;
  };
  identity?: {
    identityId: string;
    status: string;
    role?: string;
    canCreateInvites: boolean;
    canCreateGuestInvites: boolean;
  };
  authorization?: IdentityAuthorization;
  serverAdmin?: {
    serverAdminId: string;
  };
}

export function getSignedPayload<T = unknown>(req: AuthRequest<unknown>): T {
  return (req.signedRequest?.payload ?? {}) as T;
}

export function getRequestAuthorization(req: AuthRequest): IdentityAuthorization {
  return req.authorization || resolveIdentityAuthorization({
    status: req.identity?.status || 'active',
    role: req.identity?.role,
    canCreateCircleInvites: req.identity?.canCreateInvites,
    canCreateGuestInvites: req.identity?.canCreateGuestInvites
  });
}

export function validateSignedRequestEnvelope<T = unknown, TSigner extends string = DeviceId>(
  signedRequest: SignedRequest<T, TSigner> | null | undefined,
  nonceStore: NonceStore,
  now: number = Date.now()
): { ok: true } | { ok: false; status: number; code: ErrorCode; message: string } {
  if (!signedRequest?.signature) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED' as ErrorCode,
      message: 'Missing signature'
    };
  }

  const maxDrift = getSecurityRuntimeConfig().maxTimestampDriftMs;
  if (typeof signedRequest.timestamp !== 'number' || !Number.isFinite(signedRequest.timestamp)
      || Math.abs(now - signedRequest.timestamp) > maxDrift) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED' as ErrorCode,
      message: 'Timestamp drift too large'
    };
  }

  if (typeof signedRequest.nonce !== 'string' || !signedRequest.nonce || signedRequest.nonce.length > 256 || typeof signedRequest.signerId !== 'string' || !signedRequest.signerId || signedRequest.signerId.length > 256 || nonceStore.has(signedRequest.nonce)) {
    return {
      ok: false,
      status: 401,
      code: 'INVALID_NONCE' as ErrorCode,
      message: signedRequest.nonce ? 'Nonce already used' : 'Missing nonce'
    };
  }

  return { ok: true };
}

export function rememberSignedRequestNonce<T = unknown, TSigner extends string = DeviceId>(
  signedRequest: SignedRequest<T, TSigner>,
  nonceStore: NonceStore,
  now: number = Date.now()
): void {
  const config = getSecurityRuntimeConfig();
  nonceStore.set(signedRequest.nonce, Math.max(
    now + config.nonceWindowMs,
    signedRequest.timestamp + config.maxTimestampDriftMs
  ));
}

/** Atomically consume a verified envelope across processes and restarts. */
export async function consumeSignedRequestEnvelope<T, S extends string>(request: SignedRequest<T, S>, store: NonceStore, now = Date.now()) {
  const check = validateSignedRequestEnvelope(request, store, now);
  if (!check.ok) return check;
  const claimed = await claimDurableNonce(request.signerId, request.nonce,
    request.timestamp + getSecurityRuntimeConfig().maxTimestampDriftMs);
  if (!claimed) return { ok: false as const, status: 401, code: 'INVALID_NONCE' as ErrorCode, message: 'Nonce already used' };
  rememberSignedRequestNonce(request, store, now);
  return { ok: true as const };
}

/**
 * Middleware to verify signed requests
 */
export async function verifySignature<T = unknown>(
  req: AuthRequest<T>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // This middleware authenticates device-signed requests.
    const signedRequest = req.body as SignedRequest<T, DeviceId>;

    const expectedType = getHttpSignedRequestType(req.method, req.baseUrl, req.route?.path);
    if (!expectedType || signedRequest?.type !== expectedType) {
      res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Unexpected signed request type' }
      });
      return;
    }

    const familyId = req.familyId;
    if (!familyId) {
      res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      });
      return;
    }
    const expectedVpsId = getServerIdentityRuntimeConfig().vpsId;
    if (!signedRequest.vpsId || !signedRequest.circleId) {
      res.status(426).json({
        status: 'error',
        error: { code: 'CLIENT_UPDATE_REQUIRED' as ErrorCode, message: 'This server requires a newer Circlus client' }
      });
      return;
    }
    if (signedRequest.vpsId !== expectedVpsId) {
      res.status(401).json({
        status: 'error',
        error: { code: 'INVALID_SIGNATURE' as ErrorCode, message: 'Signed request targets a different VPS' }
      });
      return;
    }
    if (!req.circleId || signedRequest.circleId !== req.circleId) {
      res.status(401).json({
        status: 'error',
        error: { code: 'INVALID_SIGNATURE' as ErrorCode, message: 'Signed request targets a different Circle' }
      });
      return;
    }

    const now = Date.now();
    const envelopeCheck = validateSignedRequestEnvelope(signedRequest, usedNonces, now);
    if (!envelopeCheck.ok) {
      res.status(envelopeCheck.status).json({
        status: 'error',
        error: {
          code: envelopeCheck.code,
          message: envelopeCheck.message
        }
      });
      return;
    }

    // Get device
    const device = await deviceRepository.findByDeviceId(familyId, signedRequest.signerId);
    const temporaryDevice = device ? null : await temporaryDeviceRepository.findByDeviceId(familyId, signedRequest.signerId);

    if (!device && !temporaryDevice) {
      res.status(401).json({
        status: 'error',
        error: {
          code: 'UNAUTHORIZED' as ErrorCode,
          message: 'Device not found'
        }
      });
      return;
    }

    // Check device status
    if (device && device.status === 'revoked') {
      res.status(401).json({
        status: 'error',
        error: {
          code: 'DEVICE_REVOKED' as ErrorCode,
          message: 'Device has been revoked'
        }
      });
      return;
    }

    if (temporaryDevice) {
      if (temporaryDevice.status === 'revoked') {
        res.status(401).json({
          status: 'error',
          error: {
            code: 'DEVICE_REVOKED' as ErrorCode,
            message: 'Temporary device has been revoked'
          }
        });
        return;
      }

      if (temporaryDevice.status === 'expired' || temporaryDevice.expires_at.getTime() <= now) {
        await bumpChatEpochsForTemporaryDevice({
          familyId,
          temporaryDeviceId: temporaryDevice.device_id,
          reason: 'device_expired'
        });
        res.status(401).json({
          status: 'error',
          error: {
            code: 'UNAUTHORIZED' as ErrorCode,
            message: 'Temporary device has expired'
          }
        });
        return;
      }
    }

    // Verify signature
    const devicePublicKey = {
      algorithm: (device?.public_key_algorithm || temporaryDevice?.public_key_algorithm) as 'ed25519' | 'x25519',
      value: (device?.public_key_value || temporaryDevice?.public_key_value) as string
    };
    const isValid = verifySignedRequest(signedRequest, devicePublicKey);

    if (!isValid) {
      res.status(401).json({
        status: 'error',
        error: {
          code: 'INVALID_SIGNATURE' as ErrorCode,
          message: 'Invalid signature'
        }
      });
      return;
    }

    // Recheck after asynchronous lookups and claim the nonce atomically in PostgreSQL.
    const finalEnvelopeCheck = await consumeSignedRequestEnvelope(signedRequest, usedNonces);
    if (!finalEnvelopeCheck.ok) {
      res.status(finalEnvelopeCheck.status).json({
        status: 'error',
        error: { code: finalEnvelopeCheck.code, message: finalEnvelopeCheck.message }
      });
      return;
    }

    // Technical device activity only. User-visible presence is advanced solely
    // by the explicit foreground heartbeat in routes/status.ts.
    if (device) {
      await deviceRepository.updateLastSeen(familyId, device.device_id, normalizeTrustedOrigin(req.get('origin')));
    } else if (temporaryDevice) {
      await temporaryDeviceRepository.updateLastSeen(familyId, temporaryDevice.device_id);
    }

    // Attach to request
    req.signedRequest = signedRequest;
    req.device = {
      deviceId: device?.device_id || temporaryDevice!.device_id,
      identityId: device?.identity_id || temporaryDevice!.identity_id,
      publicKey: devicePublicKey,
      status: device?.status || temporaryDevice!.status,
      accessLevel: device ? 'trusted' : 'temporary',
      expiresAt: temporaryDevice?.expires_at?.toISOString() || null
    };

    next();
  } catch (error) {
    getRequestLogger({ subsystem: 'auth' }).error('signature_verification_failed', {
      familyId: req.familyId,
      signerId: req.signedRequest?.signerId,
      error
    });
    res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    });
  }
}

/**
 * Middleware to check if identity is active
 */
export async function requireActiveIdentity(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.device) {
      res.status(401).json({
        status: 'error',
        error: {
          code: 'UNAUTHORIZED' as ErrorCode,
          message: 'Authentication required'
        }
      });
      return;
    }

    const familyId = req.familyId;
    if (!familyId) {
      res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR' as ErrorCode,
          message: 'Family context is missing'
        }
      });
      return;
    }

    const identity = await identityRepository.findByIdentityId(familyId, req.device.identityId);

    if (!identity) {
      res.status(401).json({
        status: 'error',
        error: {
          code: 'UNAUTHORIZED' as ErrorCode,
          message: 'Identity not found'
        }
      });
      return;
    }

    if (identity.status !== 'active') {
      res.status(403).json({
        status: 'error',
        error: {
          code: 'IDENTITY_DISABLED' as ErrorCode,
          message: 'Identity is not active'
        }
      });
      return;
    }

    const canCreateInvites = identity.role === 'owner'
      || Boolean((identity as typeof identity & { can_create_invites?: boolean }).can_create_invites);
    const canCreateGuestInvites = identity.role === 'owner'
      || Boolean((identity as typeof identity & { can_create_guest_invites?: boolean }).can_create_guest_invites);
    req.identity = {
      identityId: identity.identity_id,
      status: identity.status,
      role: identity.role || undefined,
      canCreateInvites,
      canCreateGuestInvites
    };
    req.authorization = resolveIdentityAuthorization({
      status: identity.status,
      role: identity.role,
      canCreateCircleInvites: canCreateInvites,
      canCreateGuestInvites
    });

    if (communicationRequestBudget(req.signedRequest?.type || '')) {
      communicationIdentityLimiter ??= createCommunicationIdentityRateLimiter(getRateLimitRuntimeConfig().communicationIdentity);
      communicationIdentityLimiter(req, res, next);
      return;
    }
    next();
  } catch (error) {
    getRequestLogger({ subsystem: 'auth' }).error('active_identity_check_failed', {
      familyId: req.familyId,
      identityId: req.device?.identityId,
      error
    });
    res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    });
  }
}

/**
 * Middleware to require admin role
 */
export function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.identity || !req.identity.role) {
    res.status(403).json({
      status: 'error',
      error: {
        code: 'FORBIDDEN' as ErrorCode,
        message: 'Owner access required'
      }
    });
    return;
  }

  if (!getRequestAuthorization(req).manageCircle) {
    res.status(403).json({
      status: 'error',
      error: {
        code: 'FORBIDDEN' as ErrorCode,
        message: 'Owner access required'
      }
    });
    return;
  }

  next();
}

export function requireFullCircleIdentity(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (getRequestAuthorization(req).fullCircleMember) {
    next();
    return;
  }

  res.status(403).json({
    status: 'error',
    error: {
      code: 'FORBIDDEN' as ErrorCode,
      message: 'Member access required'
    }
  });
}

export async function requireServerAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const identityId = req.identity?.identityId || req.device?.identityId;
    if (!identityId) {
      res.status(401).json({
        status: 'error',
        error: {
          code: 'UNAUTHORIZED' as ErrorCode,
          message: 'Authentication required'
        }
      });
      return;
    }

    const serverAdmin = await serverAdminRepository.findActiveByIdentityId(identityId);
    if (!serverAdmin) {
      res.status(403).json({
        status: 'error',
        error: {
          code: 'FORBIDDEN' as ErrorCode,
          message: 'Server admin access required'
        }
      });
      return;
    }

    req.serverAdmin = {
      serverAdminId: serverAdmin.server_admin_id
    };

    next();
  } catch (error) {
    getRequestLogger({ subsystem: 'auth' }).error('server_admin_check_failed', {
      identityId: req.identity?.identityId || req.device?.identityId,
      error
    });
    res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'Internal server error'
      }
    });
  }
}
