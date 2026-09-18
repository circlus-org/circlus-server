import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import { familyConfigRepository, familyDomainRepository, inviteRepository, serverAdminRepository, tenantOwnerClaimsRepository } from '../db/repositories';
import { createRateLimiter, ipKey } from '../middleware/rateLimit';
import { getRequestHost, normalizeHost } from '../middleware/tenancy';
import { createOpaqueClaimToken, hashClaimToken } from '../utils/claimTokens';
import { normalizePublicServerUrl } from '../utils/serverIdentity';
import { validateConfiguredAttachmentMaxFileSize } from '../utils/attachmentConfigValidation';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';

const router = Router();
const hostProvisioningRateLimits = getRateLimitRuntimeConfig().hostProvisioning;

const rlHostProvisioning = createRateLimiter({
  name: 'host-provisioning:create-circle',
  windowMs: hostProvisioningRateLimits.windowMs,
  max: hostProvisioningRateLimits.max,
  keyFn: ipKey
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
      serverName?: string;
      publicBaseUrl?: string;
      noNamesOnServer?: boolean;
      messageTtlHours?: number;
      attachmentsEnabled?: boolean;
      maxAttachmentFileSizeBytes?: number | null;
      attachmentStorageQuotaBytes?: number | null;
      attachmentRetentionSeconds?: number | null;
    };

    const claimToken = String(payload.claimToken || '').trim();
    const serverName = String(payload.serverName || '').trim();
    const noNamesOnServer = true;
    const normalizedUrl = normalizePublicServerUrl(payload.publicBaseUrl);

    if (!claimToken || !serverName || !normalizedUrl) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST', message: 'claimToken, serverName, and publicBaseUrl are required' }
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
