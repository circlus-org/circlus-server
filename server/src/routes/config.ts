import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import serverPackage from '../../package.json';
import type {
  ApiResponse,
  GetIceServersResponse,
  GetTurnCredentialsPayload,
  GetTurnCredentialsResponse,
  PublicKey,
  SignedRequest,
  ServerCapabilitiesResponse
} from '../../../shared/types';
import type { LinkCapabilityProof } from '../../../shared/linkCapability';
import { deviceRepository, familyDomainRepository, identityRepository, circleSiteSettingsRepository } from '../db/repositories';
import { configService } from '../services/configService';
import { iceServersService } from '../services/iceServersService';
import { circleMediaRoutingService } from '../services/circleMediaRoutingService';
import { getRequestHost, type TenancyRequest } from '../middleware/tenancy';
import {
  createNonceStore,
  getSignedPayload,
  consumeSignedRequestEnvelope,
  validateSignedRequestEnvelope,
  verifySignature,
  requireActiveIdentity
} from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import { isBlockedManagedHost } from '../utils/publicSiteDomainPolicy';
import { normalizeMediaCallSessionId } from '../utils/mediaSessionIdentity';
import { verifyCallLinkActionGrant } from '../services/callAdmissionService';
import {
  getRateLimitRuntimeConfig,
  getServerIdentityRuntimeConfig
} from '../config/serverRuntimeConfig';
import { loadPlatformRecoveryRuntimeConfig } from '../config/platformRecoveryRuntimeConfig';
import { CAPABILITIES_DOCUMENT_VERSION, SIGNED_PROTOCOL_VERSIONS } from '../../../shared/protocolVersions';
import {
  verifySignature as verifyEd25519Signature,
  verifySignedRequest
} from '../utils/crypto';

const router = Router();
const directFileTurnNonces = createNonceStore();

// Public-ish endpoints (ice-servers) and per-call TURN credentials can be abused.
// Key by ip+family to avoid cross-tenant coupling.
const configRateLimits = getRateLimitRuntimeConfig().config;
const rlIceServers = createRateLimiter({
  name: 'config:ice-servers',
  windowMs: configRateLimits.windowMs,
  max: configRateLimits.iceServersMax,
  keyFn: ipFamilyKey
});
const rlTurnCredentials = createRateLimiter({
  name: 'config:turn-credentials',
  windowMs: configRateLimits.windowMs,
  max: configRateLimits.turnCredentialsMax,
  keyFn: ipFamilyKey
});
const rlServerName = createRateLimiter({
  name: 'config:server-name',
  windowMs: configRateLimits.windowMs,
  max: configRateLimits.serverNameMax,
  keyFn: ipFamilyKey
});
const rlCapabilities = createRateLimiter({
  name: 'config:capabilities',
  windowMs: configRateLimits.windowMs,
  max: configRateLimits.capabilitiesMax,
  keyFn: ipFamilyKey
});

const SERVER_VERSION = String((serverPackage as { version?: string }).version || '0.0.0');
const SERVER_API_LEVEL = 2;

/** Lightweight tenant/lifecycle probe used by foreground supervisors. */
router.get('/lifecycle', rlCapabilities, async (req: TenancyRequest, res) => {
  if (!req.familyId) {
    return res.status(500).json({
      status: 'error',
      error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
    } as ApiResponse);
  }
  const config = await configService.requireFamilyConfig(req.familyId);
  return res.json({
    status: 'ok',
    result: { circleId: config.circle_id }
  } as ApiResponse<{ circleId: string }>);
});

/**
 * Get compatibility and feature information for this family server.
 *
 * Public and tenant-scoped: useful before choosing whether the client can use
 * newer optional flows. Current clients require this endpoint.
 */
router.get('/capabilities', rlCapabilities, async (req: TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
      } as ApiResponse);
    }

    const resolvedConfig = await configService.getResolvedFamilyConfig(familyId);
    const requestHost = getRequestHost(req);
    const acceptedDomain = requestHost
      ? await familyDomainRepository.findActiveByHost(requestHost, resolvedConfig.config?.circle_id)
      : null;
    const publicSiteEligible = !isBlockedManagedHost(requestHost);
    const siteSettings = await circleSiteSettingsRepository.findByFamilyId(familyId);

    const result: ServerCapabilitiesResponse = {
      circleId: resolvedConfig.config!.circle_id,
      vpsId: getServerIdentityRuntimeConfig().vpsId,
      capabilitiesVersion: CAPABILITIES_DOCUMENT_VERSION,
      protocols: SIGNED_PROTOCOL_VERSIONS,
      apiLevel: SERVER_API_LEVEL,
      serverVersion: SERVER_VERSION,
      enabled: {
        platformRecoveryV1: loadPlatformRecoveryRuntimeConfig().enabled
      },
      limits: {
        messageTtlHours: resolvedConfig.messageTtlHours,
        attachmentsEnabled: resolvedConfig.attachmentsEnabled,
        maxAttachmentFileSizeBytes: resolvedConfig.maxAttachmentFileSizeBytes,
        attachmentStorageQuotaBytes: resolvedConfig.attachmentStorageQuotaBytes,
        attachmentRetentionSeconds: resolvedConfig.attachmentRetentionSeconds,
        membersCanUseGuestServerAttachments: resolvedConfig.membersCanUseGuestServerAttachments
      },
      canonical: {
        publicBaseUrl: resolvedConfig.config?.public_base_url || null,
        acceptedDomainRole: acceptedDomain?.role || null,
        acceptedDomainStatus: acceptedDomain?.status || null,
        publicSiteEligible,
        publicSiteEnabled: siteSettings?.enabled ?? false
      },
      migration: {
        status: 'primary',
        targetPublicBaseUrl: resolvedConfig.config?.public_base_url || null
      }
    };

    return res.json({
      status: 'ok',
      result,
      meta: {
        serverVersion: SERVER_VERSION
      }
    } as ApiResponse<ServerCapabilitiesResponse>);
  } catch (error) {
    routeLogger.error('Error getting server capabilities:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve server capabilities' }
    } as ApiResponse);
  }
});

/**
 * Get server name (device-signed; only available after device registration)
 */
router.post(
  '/server-name',
  rlServerName,
  verifySignature,
  requireActiveIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        });
      }

      const resolvedConfig = await configService.getResolvedFamilyConfig(familyId);
      const canSeeCircleMetadata = req.identity?.role === 'owner' || req.identity?.role === 'member';
      const ownerIdentity = canSeeCircleMetadata
        ? (await identityRepository.findByRole(familyId, 'owner'))[0] || null
        : null;
      return res.json({
        status: 'ok',
        result: {
          serverName: canSeeCircleMetadata ? resolvedConfig.serverName : null,
          noNamesOnServer: canSeeCircleMetadata ? resolvedConfig.noNamesOnServer : null,
          ownerIdentityId: ownerIdentity?.identity_id || null,
          ownerIdentityName: null,
          identityId: req.identity?.identityId || null,
          identityPublicKey: req.device
            ? (await identityRepository.findByIdentityId(familyId, req.device.identityId))?.public_key_value || null
            : null,
          canCreateGuestInvites: req.identity?.canCreateGuestInvites === true,
          circleId: resolvedConfig.config!.circle_id,
          vpsId: getServerIdentityRuntimeConfig().vpsId
        }
      } as ApiResponse<{
        serverName: string | null;
        noNamesOnServer: boolean | null;
        ownerIdentityId: string | null;
        ownerIdentityName: string | null;
        identityId: string | null;
        identityPublicKey: string | null;
        canCreateGuestInvites: boolean;
        circleId: string;
        vpsId: string;
      }>);
    } catch (error) {
      routeLogger.error('Error getting server name:', error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'Failed to retrieve server name' }
      });
    }
  }
);

/**
 * Get ICE servers configuration (public endpoint for initial connection)
 */
router.get('/ice-servers', rlIceServers, async (req: TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
      } as ApiResponse);
    }

    const requestedTurnClusterId = await circleMediaRoutingService.getRequestedTurnClusterId(familyId);
    const iceServers = await iceServersService.getIceServers({ familyId, requestedTurnClusterId });

    return res.json({
      status: 'ok',
      result: { iceServers }
    } as ApiResponse<GetIceServersResponse>);
  } catch (error) {
    routeLogger.error('Error getting ICE servers:', error);
    return res.status(503).json({
      status: 'error',
      error: { code: 'ICE_CONFIG_UNAVAILABLE', message: 'Failed to retrieve ICE configuration' }
    } as ApiResponse);
  }
});

/**
 * Get TURN credentials (device-signed; should be called for each new call)
 */
router.post(
  '/direct-file-turn-credentials',
  rlTurnCredentials,
  async (req: TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }
      const signedRequest = req.body as SignedRequest<any, string>;
      const envelope = validateSignedRequestEnvelope(signedRequest, directFileTurnNonces);
      if (!envelope.ok) {
        return res.status(envelope.status).json({
          status: 'error',
          error: { code: envelope.code, message: envelope.message }
        } as ApiResponse);
      }
      const payload = signedRequest.payload;
      const sessionId = normalizeMediaCallSessionId(payload?.sessionId);
      const identityId = String(payload?.identityId || '').trim();
      const deviceId = String(payload?.deviceId || '').trim();
      const remoteIdentityId = String(payload?.remoteIdentityId || '').trim();
      const role = payload?.role === 'sender' || payload?.role === 'receiver' ? payload.role : null;
      const delegation = payload?.fileTransferKeyDelegation;
      if (
        signedRequest.type !== 'file-transfer:turn-credentials'
        || !sessionId || !identityId || !deviceId || !remoteIdentityId || !role
        || !delegation?.payload || !delegation?.signature
      ) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'A valid direct-file TURN request is required' }
        } as ApiResponse);
      }

      let claims: any;
      try {
        claims = JSON.parse(String(delegation.payload));
      } catch {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN', message: 'Invalid direct-file signing delegation' }
        } as ApiResponse);
      }
      const transferPublicKey = String(claims.transferSigningPublicKey || '').trim();
      const requiredCapability = role === 'sender' ? 'file-transfer.send' : 'file-transfer.receive';
      const nowSeconds = Math.floor(Date.now() / 1000);
      const capabilities = Array.isArray(claims.capabilities)
        ? claims.capabilities.map((value: unknown) => String(value))
        : [];
      if (
        claims.type !== 'circlus.file-transfer-key.delegation.v1'
        || claims.identityId !== identityId
        || claims.deviceId !== deviceId
        || signedRequest.signerId !== transferPublicKey
        || !capabilities.includes(requiredCapability)
        || Number(claims.notBefore || 0) > nowSeconds
        || Number(claims.expiresAt || 0) <= nowSeconds
      ) {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN', message: 'Invalid direct-file signing delegation' }
        } as ApiResponse);
      }

      const device = await deviceRepository.findByDeviceId(familyId, deviceId);
      const identity = await identityRepository.findByIdentityId(familyId, identityId as any);
      const identityPublicKeyValue = String(claims.identityPublicKey || '').trim();
      if (
        !device || device.status !== 'active' || device.identity_id !== identityId
        || !identity || identity.status !== 'active'
        || identity.public_key_value !== identityPublicKeyValue
        || !verifyEd25519Signature(String(delegation.payload), String(delegation.signature), {
          algorithm: 'ed25519',
          value: identityPublicKeyValue
        })
        || !verifySignedRequest(signedRequest, {
          algorithm: 'ed25519',
          value: transferPublicKey
        })
      ) {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN', message: 'Direct-file TURN access denied' }
        } as ApiResponse);
      }

      const finalEnvelope = await consumeSignedRequestEnvelope(signedRequest, directFileTurnNonces);
      if (!finalEnvelope.ok) {
        return res.status(finalEnvelope.status).json({
          status: 'error', error: { code: finalEnvelope.code, message: finalEnvelope.message }
        } as ApiResponse);
      }

      const requestedTurnClusterId = await circleMediaRoutingService.getRequestedTurnClusterId(familyId);
      const turn = await iceServersService.getTurnServerConfig({
        familyId,
        callSessionId: sessionId,
        requestedTurnClusterId
      });
      return res.json({ status: 'ok', result: turn || { urls: [] } } as ApiResponse<GetTurnCredentialsResponse>);
    } catch (error) {
      routeLogger.error('Error getting direct-file TURN credentials:', error);
      return res.status(503).json({
        status: 'error',
        error: { code: 'ICE_CONFIG_UNAVAILABLE', message: 'Failed to retrieve TURN credentials' }
      } as ApiResponse);
    }
  }
);

router.post(
  '/turn-credentials/call-link',
  rlTurnCredentials,
  async (req: TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const body = (req.body || {}) as {
        callSessionId?: unknown;
        callLinkId?: unknown;
        targetIdentityId?: unknown;
        subjectIdentityId?: unknown;
        subjectPublicKey?: PublicKey;
        capabilityId?: unknown;
        capabilityProof?: LinkCapabilityProof;
      };
      const callSessionId = normalizeMediaCallSessionId(body.callSessionId);
      const callLinkId = String(body.callLinkId || '').trim();
      const targetIdentityId = String(body.targetIdentityId || '').trim();
      const subjectIdentityId = String(body.subjectIdentityId || '').trim();
      const capabilityId = String(body.capabilityId || '').trim();
      const subjectPublicKey = body.subjectPublicKey;
      const capabilityProof = body.capabilityProof;

      if (
        !callSessionId
        || !callLinkId
        || !targetIdentityId
        || !subjectIdentityId
        || !capabilityId
        || !subjectPublicKey?.value
        || !capabilityProof
      ) {
        return res.status(400).json({
          status: 'error',
          error: {
            code: 'INVALID_REQUEST',
            message: 'A valid call-link TURN request is required'
          }
        } as ApiResponse);
      }

      const proofFresh = Number.isFinite(capabilityProof.timestamp)
        && Math.abs(Date.now() - capabilityProof.timestamp) <= 120_000;
      if (
        !proofFresh
        || capabilityProof.payload?.context?.callSessionId !== callSessionId
      ) {
        return res.status(403).json({
          status: 'error',
          error: {
            code: 'FORBIDDEN',
            message: 'Call-link proof is not valid for this call'
          }
        } as ApiResponse);
      }

      const grant = await verifyCallLinkActionGrant({
        familyId,
        callLinkId,
        capabilityId,
        capabilityProof,
        externalIdentityId: subjectIdentityId,
        externalPublicKey: subjectPublicKey,
        targetIdentityId,
        expectedAction: 'call-link:call',
        touchUsage: false
      });
      if (!grant.ok) {
        return res.status(403).json({
          status: 'error',
          error: {
            code: 'FORBIDDEN',
            message: 'Call-link TURN access denied'
          }
        } as ApiResponse);
      }

      const requestedTurnClusterId = await circleMediaRoutingService.getRequestedTurnClusterId(familyId);
      const turn = await iceServersService.getTurnServerConfig({
        familyId,
        callSessionId,
        requestedTurnClusterId
      });
      return res.json({
        status: 'ok',
        result: turn || { urls: [] }
      } as ApiResponse<GetTurnCredentialsResponse>);
    } catch (error) {
      routeLogger.error('Error getting call-link TURN credentials:', error);
      return res.status(503).json({
        status: 'error',
        error: { code: 'ICE_CONFIG_UNAVAILABLE', message: 'Failed to retrieve TURN credentials' }
      } as ApiResponse);
    }
  }
);

router.post(
  '/turn-credentials',
  rlTurnCredentials,
  verifySignature,
  requireActiveIdentity,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;
      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        });
      }

      const payload = getSignedPayload<GetTurnCredentialsPayload>(req);
      const callSessionId = normalizeMediaCallSessionId(payload.callSessionId);
      if (!callSessionId) {
        return res.status(400).json({
          status: 'error',
          error: {
            code: 'INVALID_CALL_SESSION_ID',
            message: 'A valid callSessionId is required'
          }
        } as ApiResponse);
      }

      const requestedTurnClusterId = await circleMediaRoutingService.getRequestedTurnClusterId(familyId);
      const turn = await iceServersService.getTurnServerConfig({
        familyId,
        callSessionId,
        requestedTurnClusterId
      });
      if (!turn) {
        return res.json({
          status: 'ok',
          result: { urls: [] }
        } as ApiResponse<GetTurnCredentialsResponse>);
      }

      return res.json({
        status: 'ok',
        result: turn
      } as ApiResponse<GetTurnCredentialsResponse>);
    } catch (error) {
      routeLogger.error('Error getting TURN credentials:', error);
      return res.status(503).json({
        status: 'error',
        error: { code: 'ICE_CONFIG_UNAVAILABLE', message: 'Failed to retrieve TURN credentials' }
      } as ApiResponse);
    }
  }
);

export default router;
