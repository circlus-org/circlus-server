import { versionedAccessOperation } from '../services/versionedAccessOperation';
import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import { verifySignature, requireActiveIdentity, requireServerAdmin, getSignedPayload, type AuthRequest } from '../middleware/auth';
import { circleOwnerRecoveryRepository, deviceLifecyclePolicyRepository, deviceRepository, familyConfigRepository, familyDomainRepository, identityRepository, inviteRepository, tenantOwnerClaimsRepository, TenantSuspensionError } from '../db/repositories';
import { configService } from '../services/configService';
import { attachmentStorageService } from '../services/attachmentStorageService';
import { publicSiteAssetStorageService } from '../services/publicSiteAssetStorageService';
import { getRequestHost, normalizeHost } from '../middleware/tenancy';
import { hashClaimToken, createOpaqueClaimToken } from '../utils/claimTokens';
import { normalizePublicServerUrl } from '../utils/serverIdentity';
import { validateConfiguredAttachmentMaxFileSize } from '../utils/attachmentConfigValidation';
import { validateTenantDomainDns, validateTenantTlsCertificate } from '../utils/tenantDomainValidation';
import {
  isMessageArchiveModeAllowed,
  normalizeMessageArchivePolicyMode,
  type MessageArchivePolicyMode
} from '../utils/messageArchivePolicy';
import type { CircleOwnerRecoveryAcceptance } from '@shared/types';
import {
  changeCircleOwnerToExistingIdentity,
  CircleOwnershipError,
  deliverCircleOwnerChangedPush,
  recoverCircleOwnerWithNewIdentity
} from '../services/circleOwnershipService';
import serverAdminAccessRoutes from './serverAdminAccessRoutes';
import { suspendCircleWsAccess } from '../ws/wsGateway';
import { getCircleAddressRuntimeConfig } from '../config/serverRuntimeConfig';

const router = Router();
const REVOKED_DELETE_DAYS = 30;
function normalizeOptionalArchivePolicy(value: unknown): MessageArchivePolicyMode | undefined {
  if (value === undefined) return undefined;
  if (value !== 'disabled' && value !== 'text' && value !== 'text_with_attachments') return undefined;
  return normalizeMessageArchivePolicyMode(value);
}

function normalizeOptionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : NaN;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

router.use(serverAdminAccessRoutes);

router.post(
  '/device-lifecycle-policy',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (_req: AuthRequest, res) => {
    try {
      return res.json({ status: 'ok', result: await deviceLifecyclePolicyRepository.get() });
    } catch (error) {
      routeLogger.error('Get device lifecycle policy error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to get device lifecycle policy' } });
    }
  }
);

router.post(
  '/device-lifecycle-policy/update',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest<{
    reviewAfterDays?: number;
    autoRevokeEnabled?: boolean;
    autoRevokeAfterDays?: number;
  }>, res) => {
    try {
      const current = await deviceLifecyclePolicyRepository.get();
      const payload = getSignedPayload<{
        reviewAfterDays?: number;
        autoRevokeEnabled?: boolean;
        autoRevokeAfterDays?: number;
      }>(req);
      const reviewAfterDays = payload.reviewAfterDays === undefined
        ? current.reviewAfterDays
        : Math.floor(Number(payload.reviewAfterDays));
      const autoRevokeAfterDays = payload.autoRevokeAfterDays === undefined
        ? current.autoRevokeAfterDays
        : Math.floor(Number(payload.autoRevokeAfterDays));
      const autoRevokeEnabled = payload.autoRevokeEnabled === undefined
        ? current.autoRevokeEnabled
        : payload.autoRevokeEnabled === true;
      if (!Number.isFinite(reviewAfterDays) || reviewAfterDays < 7 || reviewAfterDays > 3650) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Review threshold must be between 7 and 3650 days' } });
      }
      if (!Number.isFinite(autoRevokeAfterDays) || autoRevokeAfterDays < 30 || autoRevokeAfterDays > 3650) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Automatic revoke threshold must be between 30 and 3650 days' } });
      }
      if (reviewAfterDays >= autoRevokeAfterDays) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Review threshold must be earlier than automatic revoke threshold' } });
      }
      const updated = await deviceLifecyclePolicyRepository.update({
        reviewAfterDays,
        autoRevokeEnabled,
        autoRevokeAfterDays,
        updatedByServerAdminId: req.serverAdmin!.serverAdminId
      });
      return res.json({ status: 'ok', result: updated });
    } catch (error) {
      routeLogger.error('Update device lifecycle policy error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to update device lifecycle policy' } });
    }
  }
);


router.post(
  '/tenants/list',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (_req: AuthRequest, res) => {
    try {
      const tenants = await familyConfigRepository.listWithStats();
      return res.json({
        status: 'ok',
        result: {
          tenants: tenants.map((tenant) => ({
            familyId: tenant.family_id,
            circleId: tenant.circle_id,
            host: new URL(tenant.public_base_url).host,
            publicBaseUrl: tenant.public_base_url,
            serverName: tenant.server_name,
            status: tenant.status,
            ownerIdentityId: tenant.owner_identity_id,
            createdAt: tenant.created_at,
            claimedAt: tenant.claimed_at,
            revokedAt: tenant.revoked_at,
            suspendedAt: tenant.suspended_at,
            lastActivityAt: tenant.last_activity_at,
            noNamesOnServer: tenant.no_names_on_server,
            ownerClaimExpiresAt: tenant.owner_claim_expires_at,
            joinInviteExpiresAt: tenant.join_invite_expires_at,
            pendingOwnerClaimCount: tenant.pending_owner_claim_count,
            identityCount: tenant.identity_count,
            activeDeviceCount: tenant.active_device_count,
            ownerActiveDeviceCount: tenant.owner_active_device_count,
            activeChannelCount: tenant.active_channel_count,
            ownerName: null,
            domainHost: tenant.current_domain_host,
            domainStatus: tenant.current_domain_status,
            joinInviteToken: tenant.status === 'pending_owner' ? tenant.join_invite_token : null
          }))
        }
      });
    } catch (error) {
      routeLogger.error('List tenants error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to list tenants' } });
    }
  }
);


router.post(
  '/tenants/:familyId/owner-recovery/options',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const config = await familyConfigRepository.findByFamilyId(familyId);
      if (!config) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Circle not found' } });
      }
      if (config.status !== 'active' || !config.owner_identity_id) {
        return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Circle does not have an active ownership state' } });
      }
      const identities = await identityRepository.findAll(familyId);
      const activeDevices = await deviceRepository.findActiveByIdentityIds(
        familyId,
        identities.map((identity) => identity.identity_id as any)
      );
      const deviceCounts = new Map<string, number>();
      for (const device of activeDevices) {
        deviceCounts.set(device.identity_id, (deviceCounts.get(device.identity_id) || 0) + 1);
      }
      const owner = identities.find((identity) => identity.identity_id === config.owner_identity_id) || null;
      return res.json({
        status: 'ok',
        result: {
          circle: {
            familyId,
            circleId: config.circle_id,
            name: config.server_name,
            publicBaseUrl: config.public_base_url,
            noNamesOnServer: config.no_names_on_server
          },
          currentOwner: owner ? {
            identityId: owner.identity_id,
            identityName: null,
            status: owner.status,
            activeDeviceCount: deviceCounts.get(owner.identity_id) || 0
          } : null,
          candidates: identities
            .filter((identity) => identity.status === 'active' && identity.role === 'member')
            .map((identity) => ({
              identityId: identity.identity_id,
              identityName: null,
              activeDeviceCount: deviceCounts.get(identity.identity_id) || 0
            }))
        }
      });
    } catch (error) {
      routeLogger.error('Get Circle owner recovery options error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to load owner recovery options' } });
    }
  }
);

router.post(
  '/tenants/:familyId/owner-recovery/assign',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest<{ expectedOwnerIdentityId?: string; newOwnerIdentityId?: string }>, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const payload = getSignedPayload<{ expectedOwnerIdentityId?: string; newOwnerIdentityId?: string }>(req);
      const result = await changeCircleOwnerToExistingIdentity({
        familyId,
        expectedOwnerIdentityId: String(payload.expectedOwnerIdentityId || '').trim(),
        newOwnerIdentityId: String(payload.newOwnerIdentityId || '').trim(),
        method: 'server_admin_recovery',
        initiatedByIdentityId: req.identity!.identityId,
        initiatedByDeviceId: req.device!.deviceId,
        initiatedByServerAdminId: req.serverAdmin!.serverAdminId,
        signedAuthorization: req.signedRequest
      });
      void deliverCircleOwnerChangedPush(result);
      return res.json({ status: 'ok', result });
    } catch (error) {
      if (error instanceof CircleOwnershipError) {
        return res.status(error.status).json({ status: 'error', error: { code: error.code, message: error.message } });
      }
      routeLogger.error('Assign recovered Circle owner error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to recover Circle owner' } });
    }
  }
);

router.post(
  '/tenants/:familyId/owner-recovery/claims',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  reliableOperation(async (req: AuthRequest<{ expectedOwnerIdentityId?: string; ttlHours?: number }>, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const payload = getSignedPayload<{ expectedOwnerIdentityId?: string; ttlHours?: number }>(req);
      const expectedOwnerIdentityId = String(payload.expectedOwnerIdentityId || '').trim();
      const config = await familyConfigRepository.findByFamilyId(familyId);
      if (!config) return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Circle not found' } });
      if (config.status !== 'active' || !expectedOwnerIdentityId || config.owner_identity_id !== expectedOwnerIdentityId) {
        return res.status(409).json({ status: 'error', error: { code: 'OWNER_CHANGED', message: 'Circle owner changed after recovery was started' } });
      }
      const ttlHours = Math.max(1, Math.min(168, Math.floor(Number(payload.ttlHours || 24))));
      const claimToken = createOpaqueClaimToken('cor');
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
      await circleOwnerRecoveryRepository.revokePending(familyId);
      const claim = await circleOwnerRecoveryRepository.createClaim({
        familyId,
        tokenHash: hashClaimToken(claimToken),
        expectedOwnerIdentityId,
        createdByServerAdminId: req.serverAdmin!.serverAdminId,
        createdAuthorization: req.signedRequest,
        expiresAt
      });
      return res.json({
        status: 'ok',
        result: {
          claimId: claim.claim_id,
          familyId,
          circleId: config.circle_id,
          publicBaseUrl: config.public_base_url,
          expectedOwnerIdentityId,
          claimToken,
          expiresAt: expiresAt.toISOString()
        }
      });
    } catch (error) {
      routeLogger.error('Create Circle owner recovery claim error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to create owner recovery claim' } });
    }
  })
);

router.post(
  '/tenants/:familyId/owner-recovery/create-profile',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest<{ expectedOwnerIdentityId?: string; acceptance?: CircleOwnerRecoveryAcceptance }>, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const payload = getSignedPayload<{ expectedOwnerIdentityId?: string; acceptance?: CircleOwnerRecoveryAcceptance }>(req);
      if (!payload.acceptance) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'New owner acceptance is required' } });
      }
      const result = await recoverCircleOwnerWithNewIdentity({
        familyId,
        expectedOwnerIdentityId: String(payload.expectedOwnerIdentityId || '').trim(),
        acceptance: payload.acceptance,
        initiatedByIdentityId: req.identity!.identityId,
        initiatedByDeviceId: req.device!.deviceId,
        initiatedByServerAdminId: req.serverAdmin!.serverAdminId,
        signedAuthorization: { administrator: req.signedRequest, newIdentityAcceptance: payload.acceptance }
      });
      void deliverCircleOwnerChangedPush(result);
      return res.json({ status: 'ok', result });
    } catch (error) {
      if (error instanceof CircleOwnershipError) {
        return res.status(error.status).json({ status: 'error', error: { code: error.code, message: error.message } });
      }
      routeLogger.error('Create recovered Circle owner profile error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to create recovered owner profile' } });
    }
  }
);

router.post(
  '/tenants/:familyId/suspend',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  versionedAccessOperation(async (req: AuthRequest, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const config = await familyConfigRepository.findByFamilyId(familyId);
      if (!config) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Tenant not found' } });
      }
      if (config.status !== 'active') {
        return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: `Tenant is ${config.status}` } });
      }

      await familyConfigRepository.suspendWithDomain({
        familyId,
        requestFamilyId: req.familyId!
      });

      try {
        await suspendCircleWsAccess(familyId);
      } catch (notificationError) {
        routeLogger.warn('Circle suspended but live connections could not be drained', {
          familyId,
          notificationError
        });
      }

      return res.json({
        status: 'ok',
        result: {
          familyId,
          circleId: config.circle_id,
          tenantStatus: 'suspended'
        }
      });
    } catch (error) {
      if (error instanceof TenantSuspensionError) {
        return res.status(409).json({ status: 'error', error: { code: error.code, message: error.message } });
      }
      routeLogger.error('Suspend tenant error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to suspend tenant' } });
    }
  })
);

router.post(
  '/tenants/:familyId/resume',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  versionedAccessOperation(async (req: AuthRequest, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const config = await familyConfigRepository.findByFamilyId(familyId);
      if (!config) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Tenant not found' } });
      }
      if (config.status !== 'suspended') {
        return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: `Tenant is ${config.status}` } });
      }

      await familyConfigRepository.resumeWithDomain(familyId);
      return res.json({
        status: 'ok',
        result: { familyId, tenantStatus: 'active' }
      });
    } catch (error) {
      if (error instanceof TenantSuspensionError) {
        return res.status(409).json({ status: 'error', error: { code: error.code, message: error.message } });
      }
      routeLogger.error('Resume tenant error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to resume tenant' } });
    }
  })
);

router.post(
  '/tenants/:familyId/delete',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest<{ immediate?: boolean; expectedFamilyId?: string }>, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const payload = getSignedPayload<{ immediate?: boolean; expectedFamilyId?: string }>(req);
      const immediate = payload.immediate === true;
      if (immediate && String(payload.expectedFamilyId || '').trim() !== familyId) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'Immediate deletion confirmation does not match the tenant' }
        });
      }
      const config = await familyConfigRepository.findByFamilyId(familyId);
      if (!config) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Tenant not found' } });
      }
      if (!immediate && config.status === 'active') {
        return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Active tenants cannot be deleted' } });
      }
      if (!immediate && (config.status === 'revoked' || config.status === 'suspended')) {
        const unavailableAt = config.suspended_at || config.revoked_at || config.updated_at;
        if (unavailableAt.getTime() > daysAgo(REVOKED_DELETE_DAYS).getTime()) {
          return res.status(409).json({
            status: 'error',
            error: {
              code: 'INVALID_STATE',
              message: `Unavailable tenants can be deleted ${REVOKED_DELETE_DAYS} days after suspension or cancellation`
            }
          });
        }
      }

      if (!immediate) {
        const identityCount = await identityRepository.count(familyId);
        if (config.status !== 'revoked' && config.status !== 'suspended' && identityCount > 0) {
          return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Tenant still has registered identities' } });
        }
      } else {
        routeLogger.warn('Immediate tenant deletion requested', {
          familyId,
          tenantStatus: config.status,
          serverAdminId: req.serverAdmin!.serverAdminId,
          identityId: req.identity!.identityId
        });
      }

      const deletedStorageKeys = await familyConfigRepository.deleteWithData(familyId);
      for (const storageKey of deletedStorageKeys.attachmentStorageKeys) {
        try {
          await attachmentStorageService.deleteBlob(storageKey);
        } catch (error) {
          routeLogger.error('Delete tenant attachment payload failed', error);
        }
      }
      for (const storageKey of deletedStorageKeys.publicSiteAssetStorageKeys) {
        await publicSiteAssetStorageService.deleteAsset(storageKey).catch((error) => {
          routeLogger.error('Delete tenant public site asset failed', error);
        });
      }

      return res.json({
        status: 'ok',
        result: {
          familyId,
          deleted: true
        }
      });
    } catch (error) {
      routeLogger.error('Delete tenant error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to delete tenant' } });
    }
  }
);

router.post(
  '/tenants',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest<{
    serverName?: string;
    ownerMode?: 'self' | 'other';
    addressMode?: 'shared' | 'managed' | 'custom';
    noNamesOnServer?: boolean;
    publicBaseUrl?: string | null;
    joinInviteToken?: string | null;
    ownerClaimTtlHours?: number;
    joinInviteTtlHours?: number;
    messageTtlHours?: number;
    attachmentsEnabled?: boolean;
    maxAttachmentFileSizeBytes?: number | null;
    attachmentStorageQuotaBytes?: number | null;
    attachmentRetentionSeconds?: number | null;
    maxMemberIdentities?: number | null;
    maxTotalIdentities?: number | null;
    messageArchiveServerPolicy?: MessageArchivePolicyMode;
    messageArchiveServerMaxBytes?: number | null;
    messageArchiveCirclePolicy?: MessageArchivePolicyMode;
    messageArchiveCircleMaxBytes?: number | null;
  }>, res) => {
    try {
      const payload = getSignedPayload<{
        serverName?: string;
        ownerMode?: 'self' | 'other';
        addressMode?: 'shared' | 'managed' | 'custom';
        noNamesOnServer?: boolean;
        publicBaseUrl?: string | null;
        joinInviteToken?: string | null;
        ownerClaimTtlHours?: number;
        joinInviteTtlHours?: number;
        messageTtlHours?: number;
        attachmentsEnabled?: boolean;
        maxAttachmentFileSizeBytes?: number | null;
        attachmentStorageQuotaBytes?: number | null;
        attachmentRetentionSeconds?: number | null;
        maxMemberIdentities?: number | null;
        maxTotalIdentities?: number | null;
        messageArchiveServerPolicy?: MessageArchivePolicyMode;
        messageArchiveServerMaxBytes?: number | null;
        messageArchiveCirclePolicy?: MessageArchivePolicyMode;
        messageArchiveCircleMaxBytes?: number | null;
      }>(req);
      const serverName = String(payload.serverName || '').trim();
      const noNamesOnServer = true;
      const requestedJoinInviteToken = payload.joinInviteToken;
      const joinInviteToken = String(requestedJoinInviteToken || '').trim() || `join_${nanoid(24)}`;
      const ownerClaimTtlHours = Math.max(1, Math.min(24 * 30, Number(payload.ownerClaimTtlHours || 72)));
      const joinInviteTtlHours = Math.max(1, Math.min(24 * 30, Number(payload.joinInviteTtlHours || 72)));
      const messageTtlHours = payload.messageTtlHours !== undefined ? Math.max(1, Number(payload.messageTtlHours)) : undefined;
      const attachmentsEnabled = typeof payload.attachmentsEnabled === 'boolean' ? payload.attachmentsEnabled : undefined;
      const maxAttachmentFileSizeBytes = payload.maxAttachmentFileSizeBytes !== undefined ? (payload.maxAttachmentFileSizeBytes === null ? null : Math.max(1, Number(payload.maxAttachmentFileSizeBytes))) : undefined;
      const attachmentStorageQuotaBytes = payload.attachmentStorageQuotaBytes !== undefined ? (payload.attachmentStorageQuotaBytes === null ? null : Math.max(1, Number(payload.attachmentStorageQuotaBytes))) : undefined;
      const attachmentRetentionSeconds = payload.attachmentRetentionSeconds !== undefined ? (payload.attachmentRetentionSeconds === null ? null : Math.max(60, Number(payload.attachmentRetentionSeconds))) : undefined;
      const maxMemberIdentities = payload.maxMemberIdentities !== undefined ? (payload.maxMemberIdentities === null ? null : Math.max(1, Math.floor(Number(payload.maxMemberIdentities)))) : undefined;
      const maxTotalIdentities = payload.maxTotalIdentities !== undefined ? (payload.maxTotalIdentities === null ? null : Math.max(1, Math.floor(Number(payload.maxTotalIdentities)))) : undefined;
      const messageArchiveServerPolicy = normalizeOptionalArchivePolicy(payload.messageArchiveServerPolicy) ?? 'text';
      const messageArchiveCirclePolicy = normalizeOptionalArchivePolicy(payload.messageArchiveCirclePolicy) ?? messageArchiveServerPolicy;
      const messageArchiveServerMaxBytes = normalizeOptionalPositiveInteger(payload.messageArchiveServerMaxBytes);
      const messageArchiveCircleMaxBytes = normalizeOptionalPositiveInteger(payload.messageArchiveCircleMaxBytes);
      const attachmentFileSizeValidationError = validateConfiguredAttachmentMaxFileSize(maxAttachmentFileSizeBytes);
      if (attachmentFileSizeValidationError) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: attachmentFileSizeValidationError } });
      }
      if (
        (payload.messageArchiveServerPolicy !== undefined && normalizeOptionalArchivePolicy(payload.messageArchiveServerPolicy) === undefined)
        || (payload.messageArchiveCirclePolicy !== undefined && normalizeOptionalArchivePolicy(payload.messageArchiveCirclePolicy) === undefined)
      ) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Message archive policy is invalid' } });
      }
      if (
        (messageArchiveServerMaxBytes !== undefined && messageArchiveServerMaxBytes !== null && !Number.isFinite(messageArchiveServerMaxBytes))
        || (messageArchiveCircleMaxBytes !== undefined && messageArchiveCircleMaxBytes !== null && !Number.isFinite(messageArchiveCircleMaxBytes))
      ) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Archive limits must be positive numbers or null' } });
      }
      if (!isMessageArchiveModeAllowed({ requested: messageArchiveCirclePolicy, allowed: messageArchiveServerPolicy })) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle archive policy cannot exceed server archive policy' } });
      }
      if (messageArchiveServerMaxBytes !== null && messageArchiveServerMaxBytes !== undefined && messageArchiveCircleMaxBytes !== null && messageArchiveCircleMaxBytes !== undefined && messageArchiveCircleMaxBytes > messageArchiveServerMaxBytes) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle archive size limit cannot exceed server archive size limit' } });
      }
      if (maxMemberIdentities !== null && maxMemberIdentities !== undefined && !Number.isFinite(maxMemberIdentities)) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Member limit must be a positive number or null' } });
      }
      if (maxTotalIdentities !== null && maxTotalIdentities !== undefined && !Number.isFinite(maxTotalIdentities)) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Total user limit must be a positive number or null' } });
      }
      if (maxMemberIdentities !== null && maxMemberIdentities !== undefined && maxTotalIdentities !== null && maxTotalIdentities !== undefined && maxTotalIdentities < maxMemberIdentities) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Total user limit cannot be lower than member limit' } });
      }

      const familyId = randomUUID();
      const addressMode = String(payload.addressMode || '').trim();
      if (addressMode !== 'shared' && addressMode !== 'managed' && addressMode !== 'custom') {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'addressMode must be shared, managed, or custom' }
        });
      }
      const wildcardBaseDomain = getCircleAddressRuntimeConfig().managedWildcardBaseDomain || '';
      if (addressMode === 'managed' && !wildcardBaseDomain) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'Managed wildcard addresses are not configured on this server' }
        });
      }
      const requestedPublicBaseUrl = addressMode === 'managed'
        ? `https://${familyId}.${wildcardBaseDomain}`
        : payload.publicBaseUrl;
      const normalizedUrl = normalizePublicServerUrl(requestedPublicBaseUrl);
      if (!normalizedUrl) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'publicBaseUrl is required for shared and custom addresses' }
        });
      }
      const publicBaseUrl = normalizedUrl;
      const publicUrl = new URL(normalizedUrl);
      const host = normalizeHost(publicUrl.host);
      if (!serverName) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'serverName is required' } });
      }

      if (addressMode === 'shared' && host !== normalizeHost(getRequestHost(req) || '')) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'A shared address must use the server origin handling this request' }
        });
      }
      const skipsExternalAddressValidation = addressMode === 'managed' || addressMode === 'shared';
      const dnsValidation = skipsExternalAddressValidation
        ? { ok: true as const, expectedIps: [], actualIps: [], reason: 'managed_wildcard' }
        : await validateTenantDomainDns(getRequestHost(req), host);
      if (!dnsValidation.ok) {
        const expected = dnsValidation.expectedIps.join(', ');
        const actual = dnsValidation.actualIps.length > 0 ? dnsValidation.actualIps.join(', ') : 'none';
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'TENANT_DOMAIN_DNS_MISMATCH',
            message: `Domain DNS is missing or does not point to this server. Set ${host} to ${expected} and wait for DNS propagation after changing records.`,
            details: {
              host,
              expectedIps: dnsValidation.expectedIps,
              actualIps: dnsValidation.actualIps,
              actual,
              reason: dnsValidation.reason
            }
          }
        });
      }

      const tlsValidation = skipsExternalAddressValidation
        ? { ok: true as const, reason: 'managed_wildcard' }
        : await validateTenantTlsCertificate(publicUrl);
      if (!tlsValidation.ok) {
        return res.status(409).json({
          status: 'error',
          error: {
            code: 'TENANT_DOMAIN_TLS_UNAVAILABLE',
            message: `HTTPS certificate for ${host} is missing or invalid. Issue a valid certificate and try again.`,
            details: {
              host,
              publicBaseUrl,
              reason: tlsValidation.reason
            }
          }
        });
      }
      const ownerClaimToken = createOpaqueClaimToken('toc');
      const ownerClaimHash = hashClaimToken(ownerClaimToken);
      const ownerClaimExpiresAt = new Date(Date.now() + ownerClaimTtlHours * 60 * 60 * 1000);
      const joinInviteExpiresAt = new Date(Date.now() + joinInviteTtlHours * 60 * 60 * 1000);
      const inviteId = `invite_${nanoid(18)}`;

      const familyConfig = await familyConfigRepository.create({
        familyId,
        serverName,
        publicBaseUrl,
        // Legacy DB column name: stores the initial join invite token.
        firstOwnerInviteToken: joinInviteToken,
        noNamesOnServer,
        messageTtlHours,
        attachmentsEnabled,
        maxAttachmentFileSizeBytes,
        attachmentStorageQuotaBytes,
        attachmentRetentionSeconds,
        maxMemberIdentities: maxMemberIdentities === undefined ? null : maxMemberIdentities,
        maxTotalIdentities: maxTotalIdentities === undefined ? null : maxTotalIdentities,
        messageArchiveServerPolicy,
        messageArchiveServerMaxBytes: messageArchiveServerMaxBytes === undefined ? null : messageArchiveServerMaxBytes,
        messageArchiveCirclePolicy,
        messageArchiveCircleMaxBytes: messageArchiveCircleMaxBytes === undefined
          ? (messageArchiveServerMaxBytes === undefined ? null : messageArchiveServerMaxBytes)
          : messageArchiveCircleMaxBytes,
        provisionStatus: 'pending_owner',
        createdByServerAdminId: req.serverAdmin?.serverAdminId || null,
        joinInviteId: inviteId,
      });

      await familyDomainRepository.createPrimaryDomain({
        familyId,
        host,
        publicBaseUrl,
        source: 'server-admin'
      });

      await inviteRepository.create({
        familyId,
        inviteId,
        token: joinInviteToken,
        // The server administrator belongs to the management Circle, not to the
        // newly provisioned tenant. System-created owner invites must therefore
        // not be validated against identities inside the new Circle.
        createdBy: 'system',
        expiresAt: joinInviteExpiresAt,
        maxUses: 1
      });

      await tenantOwnerClaimsRepository.create({
        familyId,
        tokenHash: ownerClaimHash,
        expiresAt: ownerClaimExpiresAt
      });

      return res.json({
        status: 'ok',
        result: {
          familyId,
          circleId: familyConfig.circle_id,
          host,
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
      routeLogger.error('Create tenant error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to create tenant' } });
    }
  }
);

router.post(
  '/tenants/:familyId/config',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const config = await configService.getFamilyConfig(familyId);
      if (!config) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Tenant not found' } });
      }
      return res.json({
        status: 'ok',
        result: {
          familyId,
          serverName: config.server_name,
          messageTtlHours: config.message_ttl_hours,
          attachmentsEnabled: config.attachments_enabled,
          maxAttachmentFileSizeBytes: config.max_attachment_file_size_bytes,
          attachmentStorageQuotaBytes: config.attachment_storage_quota_bytes,
          attachmentRetentionSeconds: config.attachment_retention_seconds,
          maxMemberIdentities: config.max_member_identities,
          maxTotalIdentities: config.max_total_identities,
          messageArchiveServerPolicy: config.message_archive_server_policy,
          messageArchiveServerMaxBytes: config.message_archive_server_max_bytes,
          messageArchiveCirclePolicy: config.message_archive_circle_policy,
          messageArchiveCircleMaxBytes: config.message_archive_circle_max_bytes
        }
      });
    } catch (error) {
      routeLogger.error('Get tenant config error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to get tenant config' } });
    }
  }
);

router.post(
  '/tenants/:familyId/update',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  async (req: AuthRequest<{
    serverName?: string;
    messageTtlHours?: number;
    attachmentsEnabled?: boolean;
    maxAttachmentFileSizeBytes?: number | null;
    attachmentStorageQuotaBytes?: number | null;
    attachmentRetentionSeconds?: number | null;
    maxMemberIdentities?: number | null;
    maxTotalIdentities?: number | null;
    messageArchiveServerPolicy?: MessageArchivePolicyMode;
    messageArchiveServerMaxBytes?: number | null;
    messageArchiveCirclePolicy?: MessageArchivePolicyMode;
    messageArchiveCircleMaxBytes?: number | null;
  }>, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const config = await familyConfigRepository.findByFamilyId(familyId);
      if (!config) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Tenant not found' } });
      }

      const payload = getSignedPayload<{
        serverName?: string;
        messageTtlHours?: number;
        attachmentsEnabled?: boolean;
        maxAttachmentFileSizeBytes?: number | null;
        attachmentStorageQuotaBytes?: number | null;
        attachmentRetentionSeconds?: number | null;
        maxMemberIdentities?: number | null;
        maxTotalIdentities?: number | null;
        messageArchiveServerPolicy?: MessageArchivePolicyMode;
        messageArchiveServerMaxBytes?: number | null;
        messageArchiveCirclePolicy?: MessageArchivePolicyMode;
        messageArchiveCircleMaxBytes?: number | null;
      }>(req);

      const updates: Parameters<typeof configService.updateFamilyConfig>[1] = {};

      if (payload.serverName !== undefined) {
        const serverName = String(payload.serverName).trim();
        if (!serverName) {
          return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'serverName cannot be empty' } });
        }
        updates.serverName = serverName;
      }
      if (payload.messageTtlHours !== undefined) {
        updates.messageTtlHours = Math.max(1, Math.floor(Number(payload.messageTtlHours)));
      }
      if (payload.attachmentsEnabled !== undefined) {
        updates.attachmentsEnabled = payload.attachmentsEnabled === true;
      }
      if (payload.maxAttachmentFileSizeBytes !== undefined) {
        updates.maxAttachmentFileSizeBytes = payload.maxAttachmentFileSizeBytes === null ? null : Math.max(1, Number(payload.maxAttachmentFileSizeBytes));
      }
      const attachmentFileSizeValidationError = validateConfiguredAttachmentMaxFileSize(updates.maxAttachmentFileSizeBytes);
      if (attachmentFileSizeValidationError) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: attachmentFileSizeValidationError } });
      }
      if (payload.attachmentStorageQuotaBytes !== undefined) {
        updates.attachmentStorageQuotaBytes = payload.attachmentStorageQuotaBytes === null ? null : Math.max(1, Number(payload.attachmentStorageQuotaBytes));
      }
      if (payload.attachmentRetentionSeconds !== undefined) {
        updates.attachmentRetentionSeconds = payload.attachmentRetentionSeconds === null ? null : Math.max(60, Number(payload.attachmentRetentionSeconds));
      }
      if (payload.maxMemberIdentities !== undefined) {
        updates.maxMemberIdentities = payload.maxMemberIdentities === null ? null : Math.max(1, Math.floor(Number(payload.maxMemberIdentities)));
      }
      if (payload.maxTotalIdentities !== undefined) {
        updates.maxTotalIdentities = payload.maxTotalIdentities === null ? null : Math.max(1, Math.floor(Number(payload.maxTotalIdentities)));
      }
      const messageArchiveServerPolicy = normalizeOptionalArchivePolicy(payload.messageArchiveServerPolicy);
      const messageArchiveCirclePolicy = normalizeOptionalArchivePolicy(payload.messageArchiveCirclePolicy);
      const messageArchiveServerMaxBytes = normalizeOptionalPositiveInteger(payload.messageArchiveServerMaxBytes);
      const messageArchiveCircleMaxBytes = normalizeOptionalPositiveInteger(payload.messageArchiveCircleMaxBytes);
      if (
        (payload.messageArchiveServerPolicy !== undefined && messageArchiveServerPolicy === undefined)
        || (payload.messageArchiveCirclePolicy !== undefined && messageArchiveCirclePolicy === undefined)
      ) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Message archive policy is invalid' } });
      }
      if (
        (messageArchiveServerMaxBytes !== undefined && messageArchiveServerMaxBytes !== null && !Number.isFinite(messageArchiveServerMaxBytes))
        || (messageArchiveCircleMaxBytes !== undefined && messageArchiveCircleMaxBytes !== null && !Number.isFinite(messageArchiveCircleMaxBytes))
      ) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Archive limits must be positive numbers or null' } });
      }
      const nextArchiveServerPolicy = messageArchiveServerPolicy ?? config.message_archive_server_policy;
      const nextArchiveCirclePolicy = messageArchiveCirclePolicy ?? config.message_archive_circle_policy;
      const nextArchiveServerMaxBytes = messageArchiveServerMaxBytes === undefined ? config.message_archive_server_max_bytes : messageArchiveServerMaxBytes;
      const nextArchiveCircleMaxBytes = messageArchiveCircleMaxBytes === undefined ? config.message_archive_circle_max_bytes : messageArchiveCircleMaxBytes;
      if (!isMessageArchiveModeAllowed({ requested: nextArchiveCirclePolicy, allowed: nextArchiveServerPolicy })) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle archive policy cannot exceed server archive policy' } });
      }
      if (nextArchiveServerMaxBytes !== null && nextArchiveCircleMaxBytes !== null && nextArchiveCircleMaxBytes > nextArchiveServerMaxBytes) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Circle archive size limit cannot exceed server archive size limit' } });
      }
      const nextMaxMemberIdentities = updates.maxMemberIdentities === undefined ? config.max_member_identities : updates.maxMemberIdentities;
      const nextMaxTotalIdentities = updates.maxTotalIdentities === undefined ? config.max_total_identities : updates.maxTotalIdentities;
      if (nextMaxMemberIdentities !== null && nextMaxTotalIdentities !== null && nextMaxTotalIdentities < nextMaxMemberIdentities) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'Total user limit cannot be lower than member limit' } });
      }
      updates.messageArchiveServerPolicy = messageArchiveServerPolicy;
      updates.messageArchiveServerMaxBytes = messageArchiveServerMaxBytes;
      updates.messageArchiveCirclePolicy = messageArchiveCirclePolicy;
      updates.messageArchiveCircleMaxBytes = messageArchiveCircleMaxBytes;

      const updated = await configService.updateFamilyConfig(familyId, updates);
      if (!updated) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Tenant config not found' } });
      }

      return res.json({
        status: 'ok',
        result: {
          familyId,
          serverName: updated.server_name,
          messageTtlHours: updated.message_ttl_hours,
          attachmentsEnabled: updated.attachments_enabled,
          maxAttachmentFileSizeBytes: updated.max_attachment_file_size_bytes,
          attachmentStorageQuotaBytes: updated.attachment_storage_quota_bytes,
          attachmentRetentionSeconds: updated.attachment_retention_seconds,
          maxMemberIdentities: updated.max_member_identities,
          maxTotalIdentities: updated.max_total_identities,
          messageArchiveServerPolicy: updated.message_archive_server_policy,
          messageArchiveServerMaxBytes: updated.message_archive_server_max_bytes,
          messageArchiveCirclePolicy: updated.message_archive_circle_policy,
          messageArchiveCircleMaxBytes: updated.message_archive_circle_max_bytes
        }
      });
    } catch (error) {
      routeLogger.error('Update tenant config error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to update tenant config' } });
    }
  }
);

router.post(
  '/tenants/:familyId/reissue-owner-claim',
  verifySignature,
  requireActiveIdentity,
  requireServerAdmin,
  reliableOperation(async (req: AuthRequest<{ ownerClaimTtlHours?: number }>, res) => {
    try {
      const familyId = String(req.params.familyId || '').trim();
      const config = await familyConfigRepository.findByFamilyId(familyId);
      if (!config) {
        return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Tenant not found' } });
      }
      if (config.status !== 'pending_owner') {
        return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: `Tenant is ${config.status}` } });
      }

      const { ownerClaimTtlHours } = getSignedPayload<{ ownerClaimTtlHours?: number }>(req);
      const ttlHours = Math.max(1, Math.min(24 * 30, Number(ownerClaimTtlHours || 72)));
      const ownerClaimToken = createOpaqueClaimToken('toc');
      const ownerClaimHash = hashClaimToken(ownerClaimToken);
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
      const joinInviteId = `invite_${nanoid(18)}`;
      const joinInviteToken = `join_${nanoid(24)}`;

      await tenantOwnerClaimsRepository.revokePending(familyId);
      if (config.join_invite_id) {
        await inviteRepository.updateStatus(familyId, config.join_invite_id, 'revoked');
      }
      await inviteRepository.create({
        familyId,
        inviteId: joinInviteId,
        token: joinInviteToken,
        createdBy: 'system',
        expiresAt,
        maxUses: 1
      });
      await familyConfigRepository.replaceJoinInvite(familyId, joinInviteId, joinInviteToken);
      await tenantOwnerClaimsRepository.create({
        familyId,
        tokenHash: ownerClaimHash,
        expiresAt
      });

      return res.json({
        status: 'ok',
        result: {
          familyId,
          circleId: config.circle_id,
          joinInviteToken,
          joinInviteExpiresAt: expiresAt.toISOString(),
          ownerClaimToken,
          ownerClaimExpiresAt: expiresAt.toISOString()
        }
      });
    } catch (error) {
      routeLogger.error('Reissue owner claim error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to reissue owner claim' } });
    }
  })
);

export default router;
