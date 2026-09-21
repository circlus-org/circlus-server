import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import { familyConfigRepository, familyDomainRepository, inviteRepository, managedPushConfigurationRepository, serverAdminRepository, tenantOwnerClaimsRepository } from '../db/repositories';
import { createRateLimiter, ipKey } from '../middleware/rateLimit';
import { getRequestHost, normalizeHost } from '../middleware/tenancy';
import { createOpaqueClaimToken, hashClaimToken } from '../utils/claimTokens';
import { normalizePublicServerUrl } from '../utils/serverIdentity';
import { validateConfiguredAttachmentMaxFileSize } from '../utils/attachmentConfigValidation';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';
import { disableManagedPushConfiguration, installManagedPushConfiguration, preflightManagedPushInstallation, verifyEffectivePushConfiguration } from '../services/managedPushConfigurationService';

const router = Router();
const hostProvisioningRateLimits = getRateLimitRuntimeConfig().hostProvisioning;

const rlHostProvisioning = createRateLimiter({
  name: 'host-provisioning:create-circle',
  windowMs: hostProvisioningRateLimits.windowMs,
  max: hostProvisioningRateLimits.max,
  keyFn: ipKey
});
const rlPushInstallation = createRateLimiter({
  name: 'host-provisioning:push-installation',
  windowMs: 60_000,
  max: 30,
  keyFn: ipKey
});

function pushInstallError(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  const status = code === 'INSTALL_CLAIM_INVALID' || code === 'INSTALL_CLAIM_EXPIRED' || code === 'INSTALL_AUTH_INVALID' ? 403
    : code === 'INSTALL_CLAIM_ALREADY_USED' || code === 'INSTALLED_CONFIGURATION_CHANGED' ? 409
      : code.startsWith('INVALID_') ? 400 : 500;
  return res.status(status).json({ status: 'error', error: { code, message: code === 'INTERNAL_ERROR' ? 'Push configuration operation failed' : code } });
}

router.post('/push-configuration/preflight', rlPushInstallation, async (req, res) => {
  try {
    const result = await preflightManagedPushInstallation(String(req.body?.claimToken || '').trim());
    return res.json({ status: 'ok', result });
  } catch (error) {
    return pushInstallError(res, error);
  }
});

router.post('/push-configuration/install', rlPushInstallation, async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await installManagedPushConfiguration({
      claimToken: String(payload.claimToken || '').trim(),
      provisionRequestId: String(payload.provisionRequestId || '').trim(),
      serviceUrl: payload.push?.serviceUrl,
      clientId: payload.push?.clientId,
      keyId: payload.push?.keyId,
      sharedSecret: payload.push?.sharedSecret
    });
    let verified = false;
    try {
      await verifyEffectivePushConfiguration();
      verified = true;
    } catch (error) {
      routeLogger.warn('Managed push configuration installed but verification failed', error);
    }
    return res.json({ status: 'ok', result: { ...result, verified } });
  } catch (error) {
    routeLogger.warn('Managed push configuration installation failed', error);
    return pushInstallError(res, error);
  }
});

router.post('/push-configuration/verify', rlPushInstallation, async (req, res) => {
  try {
    const claimToken = String(req.body?.claimToken || '').trim();
    const claim = await managedPushConfigurationRepository.findClaimByTokenHash(hashClaimToken(claimToken));
    if (!claim || claim.status !== 'consumed') throw new Error('INSTALL_CLAIM_INVALID');
    await verifyEffectivePushConfiguration();
    return res.json({ status: 'ok', result: { verified: true } });
  } catch (error) {
    return pushInstallError(res, error);
  }
});

router.post('/push-configuration/disable', rlPushInstallation, async (req, res) => {
  try {
    const payload = req.body || {};
    const configuration = await disableManagedPushConfiguration({
      claimToken: String(payload.claimToken || '').trim(),
      provisionRequestId: String(payload.provisionRequestId || '').trim(),
      serviceUrl: payload.push?.serviceUrl,
      clientId: payload.push?.clientId,
      keyId: payload.push?.keyId,
      sharedSecret: payload.push?.sharedSecret
    });
    return res.json({ status: 'ok', result: { configuration } });
  } catch (error) {
    return pushInstallError(res, error);
  }
});

function isLocalHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' && (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]'
  );
}

// Express derives req.secure and req.protocol from X-Forwarded-Proto only when
// TRUST_PROXY is configured. Reading the header directly would let any client
// claim HTTPS on a server that trusts no proxy.
function isSecureProvisioningRequest(req: Parameters<typeof getRequestHost>[0] & { secure?: boolean; protocol?: string }): boolean {
  return req.secure === true || req.protocol === 'https';
}

router.post('/circles', rlHostProvisioning, async (req, res) => {
  try {
    const payload = req.body as {
      claimToken?: string;
      publicBaseUrl?: string;
      noNamesOnServer?: boolean;
      messageTtlHours?: number;
      attachmentsEnabled?: boolean;
      maxAttachmentFileSizeBytes?: number | null;
      attachmentStorageQuotaBytes?: number | null;
      attachmentRetentionSeconds?: number | null;
    };

    const claimToken = String(payload.claimToken || '').trim();
    const noNamesOnServer = true;
    const normalizedUrl = normalizePublicServerUrl(payload.publicBaseUrl);

    if (!claimToken || !normalizedUrl) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST', message: 'claimToken and publicBaseUrl are required' }
      });
    }

    const adminClaimTokenHash = hashClaimToken(claimToken);
    const adminClaim = await serverAdminRepository.findClaimByTokenHash(adminClaimTokenHash);
    if (!adminClaim || adminClaim.status !== 'pending' || adminClaim.expires_at.getTime() < Date.now()) {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN', message: 'Invalid or expired server admin claim token' }
      });
    }

    const publicBaseUrl = normalizedUrl;
    const url = new URL(publicBaseUrl);
    const serverName = url.hostname;
    if (url.protocol !== 'https:' && !isLocalHttpUrl(url)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST', message: 'publicBaseUrl must use HTTPS' }
      });
    }
    if (!isLocalHttpUrl(url) && !isSecureProvisioningRequest(req)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST', message: 'Provisioning requests must use HTTPS' }
      });
    }

    const requestHost = getRequestHost(req);
    const publicHost = normalizeHost(url.host);
    if (!requestHost || requestHost !== publicHost) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST', message: 'publicBaseUrl must match the request host' }
      });
    }

    const messageTtlHours = payload.messageTtlHours !== undefined ? Math.max(1, Number(payload.messageTtlHours)) : undefined;
    const attachmentsEnabled = typeof payload.attachmentsEnabled === 'boolean' ? payload.attachmentsEnabled : undefined;
    const maxAttachmentFileSizeBytes = payload.maxAttachmentFileSizeBytes !== undefined ? (payload.maxAttachmentFileSizeBytes === null ? null : Math.max(1, Number(payload.maxAttachmentFileSizeBytes))) : undefined;
    const attachmentStorageQuotaBytes = payload.attachmentStorageQuotaBytes !== undefined ? (payload.attachmentStorageQuotaBytes === null ? null : Math.max(1, Number(payload.attachmentStorageQuotaBytes))) : undefined;
    const attachmentRetentionSeconds = payload.attachmentRetentionSeconds !== undefined ? (payload.attachmentRetentionSeconds === null ? null : Math.max(60, Number(payload.attachmentRetentionSeconds))) : undefined;
    const attachmentFileSizeValidationError = validateConfiguredAttachmentMaxFileSize(maxAttachmentFileSizeBytes);
    if (attachmentFileSizeValidationError) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: attachmentFileSizeValidationError } });
    }

    const existingDomain = await familyDomainRepository.findByHost(publicHost);
    if (existingDomain) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'ALREADY_EXISTS', message: 'A circle already exists for this host' }
      });
    }
    const existingCircleCount = await familyConfigRepository.countAll();
    if (existingCircleCount > 0) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'SERVER_ALREADY_BOOTSTRAPPED', message: 'This server already has circles. Use server management to create additional circles.' }
      });
    }

    const familyId = randomUUID();
    const joinInviteToken = `join_${nanoid(24)}`;
    const ownerClaimToken = createOpaqueClaimToken('toc');
    const ownerClaimExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const joinInviteExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const inviteId = `invite_${nanoid(18)}`;

    const familyConfig = await familyConfigRepository.create({
      familyId,
      serverName,
      publicBaseUrl,
      firstOwnerInviteToken: joinInviteToken,
      noNamesOnServer,
      messageTtlHours,
      attachmentsEnabled,
      maxAttachmentFileSizeBytes,
      attachmentStorageQuotaBytes,
      attachmentRetentionSeconds,
      provisionStatus: 'pending_owner',
      createdByServerAdminId: null,
      joinInviteId: inviteId
    });

    await familyDomainRepository.createPrimaryDomain({
      familyId,
      host: publicHost,
      publicBaseUrl,
      source: 'server-admin-claim'
    });

    await inviteRepository.create({
      familyId,
      inviteId,
      token: joinInviteToken,
      createdBy: 'system',
      expiresAt: joinInviteExpiresAt,
      maxUses: 1
    });

    await tenantOwnerClaimsRepository.create({
      familyId,
      tokenHash: hashClaimToken(ownerClaimToken),
      expiresAt: ownerClaimExpiresAt
    });
    await serverAdminRepository.markClaimUsed(adminClaimTokenHash, null);

    return res.json({
      status: 'ok',
      result: {
        familyId,
        host: publicHost,
        publicBaseUrl,
        serverName: familyConfig.server_name,
        tenantStatus: 'pending_owner',
        joinInviteToken,
        joinInviteExpiresAt: joinInviteExpiresAt.toISOString(),
        ownerClaimToken,
        ownerClaimExpiresAt: ownerClaimExpiresAt.toISOString()
      }
    });
  } catch (error) {
    routeLogger.error('Host provisioning create circle error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create circle' }
    });
  }
});

export default router;
