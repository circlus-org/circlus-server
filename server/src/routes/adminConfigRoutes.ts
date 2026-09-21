import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { verifySignature, requireActiveIdentity, requireAdmin, type AuthRequest, getSignedPayload } from '../middleware/auth';
import { collectServerHealthMetrics } from '../utils/monitoring';
import type { ApiResponse, GetServerHealthResponse } from '../../../shared/types';
import { configService } from '../services/configService';
import type { TenancyRequest } from '../middleware/tenancy';
import { validateConfiguredAttachmentMaxFileSize } from '../utils/attachmentConfigValidation';
import {
  isMessageArchiveModeAllowed,
  normalizeMessageArchivePolicyMode,
  type MessageArchivePolicyMode
} from '../utils/messageArchivePolicy';

const router = Router();

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

function familyConfigResult(familyConfig: NonNullable<Awaited<ReturnType<typeof configService.getFamilyConfig>>>) {
  return {
    familyId: familyConfig.family_id,
    serverName: familyConfig.server_name,
    publicBaseUrl: familyConfig.public_base_url,
    joinInviteToken: familyConfig.first_owner_invite_token,
    messageTtlHours: familyConfig.message_ttl_hours,
    chatEpochRotationIntervalHours: familyConfig.chat_epoch_rotation_interval_hours,
    chatEpochKeyRetentionHours: familyConfig.chat_epoch_key_retention_hours,
    extraTrustedClientOrigins: familyConfig.extra_trusted_client_origins || [],
    attachmentsEnabled: familyConfig.attachments_enabled,
    maxAttachmentFileSizeBytes: familyConfig.max_attachment_file_size_bytes,
    attachmentStorageQuotaBytes: familyConfig.attachment_storage_quota_bytes,
    attachmentRetentionSeconds: familyConfig.attachment_retention_seconds,
    membersCanUseGuestServerAttachments: familyConfig.members_can_use_guest_server_attachments,
    maxMemberIdentities: familyConfig.max_member_identities,
    maxTotalIdentities: familyConfig.max_total_identities,
    usedAttachmentStorageBytes: familyConfig.used_attachment_storage_bytes,
    reservedAttachmentStorageBytes: familyConfig.reserved_attachment_storage_bytes,
    messageArchiveServerPolicy: familyConfig.message_archive_server_policy,
    messageArchiveServerMaxBytes: familyConfig.message_archive_server_max_bytes,
    messageArchiveCirclePolicy: familyConfig.message_archive_circle_policy,
    messageArchiveCircleMaxBytes: familyConfig.message_archive_circle_max_bytes,
    createdAt: familyConfig.created_at,
    updatedAt: familyConfig.updated_at
  };
}
router.post(
  '/health',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const health = await collectServerHealthMetrics(familyId);

      return res.json({
        status: 'ok',
        result: { health }
      } as ApiResponse<GetServerHealthResponse>);

    } catch (error) {
      routeLogger.error('Get server health error:', error);
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to collect server health metrics'
        }
      } as ApiResponse);
    }
  }
);

/**
 * Get family configuration (admin only)
 */
router.post(
  '/family-config',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest<{
    serverName?: string;
    publicBaseUrl?: string | null;
    joinInviteToken?: string | null;
    messageTtlHours?: number;
    extraTrustedClientOrigins?: string[];
    attachmentsEnabled?: boolean;
    maxAttachmentFileSizeBytes?: number | null;
    attachmentStorageQuotaBytes?: number | null;
    attachmentRetentionSeconds?: number | null;
  }> & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const familyConfig = await configService.getFamilyConfig(familyId);

      if (!familyConfig) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'NOT_FOUND', message: 'Family configuration not found' }
        } as ApiResponse);
      }

      return res.json({
        status: 'ok',
        result: familyConfigResult(familyConfig)
      } as ApiResponse);

    } catch (error) {
      routeLogger.error('Get family config error:', error);
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to get family configuration'
        }
      } as ApiResponse);
    }
  }
);

/**
 * Update family configuration (admin only)
 */
router.put(
  '/family-config',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest & TenancyRequest, res) => {
    try {
      const familyId = req.familyId;

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const { serverName, publicBaseUrl, joinInviteToken, messageTtlHours, chatEpochRotationIntervalHours, chatEpochKeyRetentionHours, extraTrustedClientOrigins, attachmentsEnabled, maxAttachmentFileSizeBytes, attachmentStorageQuotaBytes, attachmentRetentionSeconds, membersCanUseGuestServerAttachments, messageArchiveServerPolicy, messageArchiveServerMaxBytes, messageArchiveCirclePolicy, messageArchiveCircleMaxBytes } = getSignedPayload<{
        serverName?: string;
        publicBaseUrl?: string | null;
        joinInviteToken?: string | null;
        messageTtlHours?: number;
        chatEpochRotationIntervalHours?: number;
        chatEpochKeyRetentionHours?: number;
        extraTrustedClientOrigins?: string[];
        attachmentsEnabled?: boolean;
        maxAttachmentFileSizeBytes?: number | null;
        attachmentStorageQuotaBytes?: number | null;
        attachmentRetentionSeconds?: number | null;
        membersCanUseGuestServerAttachments?: boolean;
        messageArchiveServerPolicy?: MessageArchivePolicyMode;
        messageArchiveServerMaxBytes?: number | null;
        messageArchiveCirclePolicy?: MessageArchivePolicyMode;
        messageArchiveCircleMaxBytes?: number | null;
      }>(req);

      if (serverName !== undefined) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'Circle names must use encrypted shared metadata' }
        } as ApiResponse);
      }

      // Validate at least one field is provided
      const initialJoinInviteToken = joinInviteToken;

      if (publicBaseUrl === undefined && joinInviteToken === undefined && messageTtlHours === undefined && chatEpochRotationIntervalHours === undefined && chatEpochKeyRetentionHours === undefined && extraTrustedClientOrigins === undefined && attachmentsEnabled === undefined && maxAttachmentFileSizeBytes === undefined && attachmentStorageQuotaBytes === undefined && attachmentRetentionSeconds === undefined && membersCanUseGuestServerAttachments === undefined && messageArchiveServerPolicy === undefined && messageArchiveServerMaxBytes === undefined && messageArchiveCirclePolicy === undefined && messageArchiveCircleMaxBytes === undefined) {
        return res.status(400).json({
          status: 'error',
          error: {
            code: 'INVALID_REQUEST',
            message: 'At least one config field must be provided'
          }
        } as ApiResponse);
      }

      if (publicBaseUrl !== undefined && publicBaseUrl !== null && typeof publicBaseUrl !== 'string') {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'publicBaseUrl must be a string or null' }
        } as ApiResponse);
      }

      if (messageTtlHours !== undefined && (!Number.isFinite(Number(messageTtlHours)) || Number(messageTtlHours) < 1)) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'messageTtlHours must be a positive number' }
        } as ApiResponse);
      }
      if (chatEpochRotationIntervalHours !== undefined && (!Number.isFinite(Number(chatEpochRotationIntervalHours)) || Number(chatEpochRotationIntervalHours) < 1)) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'chatEpochRotationIntervalHours must be a positive number' }
        } as ApiResponse);
      }
      if (chatEpochKeyRetentionHours !== undefined && (!Number.isFinite(Number(chatEpochKeyRetentionHours)) || Number(chatEpochKeyRetentionHours) < 1)) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'chatEpochKeyRetentionHours must be a positive number' }
        } as ApiResponse);
      }

      if (extraTrustedClientOrigins !== undefined && !Array.isArray(extraTrustedClientOrigins)) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'extraTrustedClientOrigins must be an array of strings' }
        } as ApiResponse);
      }

      if (attachmentsEnabled !== undefined || attachmentStorageQuotaBytes !== undefined || attachmentRetentionSeconds !== undefined) {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN', message: 'Attachment availability, storage quota, and retention are managed by the server owner' }
        } as ApiResponse);
      }

      if (attachmentsEnabled !== undefined && typeof attachmentsEnabled !== 'boolean') {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'attachmentsEnabled must be a boolean' }
        } as ApiResponse);
      }
      if (membersCanUseGuestServerAttachments !== undefined && typeof membersCanUseGuestServerAttachments !== 'boolean') {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'membersCanUseGuestServerAttachments must be a boolean' }
        } as ApiResponse);
      }

      const attachmentFileSizeValidationError = validateConfiguredAttachmentMaxFileSize(
        maxAttachmentFileSizeBytes !== undefined && maxAttachmentFileSizeBytes !== null ? Number(maxAttachmentFileSizeBytes) : maxAttachmentFileSizeBytes
      );
      if (attachmentFileSizeValidationError) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: attachmentFileSizeValidationError }
        } as ApiResponse);
      }

      if (attachmentStorageQuotaBytes !== undefined && attachmentStorageQuotaBytes !== null && (!Number.isFinite(Number(attachmentStorageQuotaBytes)) || Number(attachmentStorageQuotaBytes) < 1)) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'attachmentStorageQuotaBytes must be a positive number or null' }
        } as ApiResponse);
      }

      if (attachmentRetentionSeconds !== undefined && attachmentRetentionSeconds !== null && (!Number.isFinite(Number(attachmentRetentionSeconds)) || Number(attachmentRetentionSeconds) < 60)) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'attachmentRetentionSeconds must be >= 60 or null' }
        } as ApiResponse);
      }

      const normalizedArchiveServerPolicy = normalizeOptionalArchivePolicy(messageArchiveServerPolicy);
      const normalizedArchiveCirclePolicy = normalizeOptionalArchivePolicy(messageArchiveCirclePolicy);
      const normalizedArchiveServerMaxBytes = normalizeOptionalPositiveInteger(messageArchiveServerMaxBytes);
      const normalizedArchiveCircleMaxBytes = normalizeOptionalPositiveInteger(messageArchiveCircleMaxBytes);
      if ((messageArchiveServerPolicy !== undefined && normalizedArchiveServerPolicy === undefined) || (messageArchiveCirclePolicy !== undefined && normalizedArchiveCirclePolicy === undefined)) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'Message archive policy is invalid' }
        } as ApiResponse);
      }
      if (
        normalizedArchiveServerMaxBytes !== undefined
        && normalizedArchiveServerMaxBytes !== null
        && !Number.isFinite(normalizedArchiveServerMaxBytes)
      ) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'messageArchiveServerMaxBytes must be a positive number or null' }
        } as ApiResponse);
      }
      if (
        normalizedArchiveCircleMaxBytes !== undefined
        && normalizedArchiveCircleMaxBytes !== null
        && !Number.isFinite(normalizedArchiveCircleMaxBytes)
      ) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'messageArchiveCircleMaxBytes must be a positive number or null' }
        } as ApiResponse);
      }

      const currentConfig = await configService.getFamilyConfig(familyId);
      if (!currentConfig) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'NOT_FOUND', message: 'Family configuration not found' }
        } as ApiResponse);
      }
      const nextArchiveServerPolicy = normalizedArchiveServerPolicy ?? currentConfig.message_archive_server_policy;
      const nextArchiveCirclePolicy = normalizedArchiveCirclePolicy ?? currentConfig.message_archive_circle_policy;
      const nextArchiveServerMaxBytes = normalizedArchiveServerMaxBytes === undefined
        ? currentConfig.message_archive_server_max_bytes
        : normalizedArchiveServerMaxBytes;
      const nextArchiveCircleMaxBytes = normalizedArchiveCircleMaxBytes === undefined
        ? currentConfig.message_archive_circle_max_bytes
        : normalizedArchiveCircleMaxBytes;
      if (!isMessageArchiveModeAllowed({ requested: nextArchiveCirclePolicy, allowed: nextArchiveServerPolicy })) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'Circle archive policy cannot exceed server archive policy' }
        } as ApiResponse);
      }
      if (nextArchiveServerMaxBytes !== null && nextArchiveCircleMaxBytes !== null && nextArchiveCircleMaxBytes > nextArchiveServerMaxBytes) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'Circle archive size limit cannot exceed server archive size limit' }
        } as ApiResponse);
      }

      // Update family config
      const updatedConfig = await configService.updateFamilyConfig(familyId, {
        publicBaseUrl: publicBaseUrl ?? undefined,
        firstOwnerInviteToken: initialJoinInviteToken,
        messageTtlHours: messageTtlHours !== undefined ? Number(messageTtlHours) : undefined,
        chatEpochRotationIntervalHours: chatEpochRotationIntervalHours !== undefined ? Number(chatEpochRotationIntervalHours) : undefined,
        chatEpochKeyRetentionHours: chatEpochKeyRetentionHours !== undefined ? Number(chatEpochKeyRetentionHours) : undefined,
        extraTrustedClientOrigins: Array.isArray(extraTrustedClientOrigins)
          ? extraTrustedClientOrigins.map((value) => String(value).trim()).filter(Boolean)
          : undefined,
        maxAttachmentFileSizeBytes: maxAttachmentFileSizeBytes !== undefined && maxAttachmentFileSizeBytes !== null ? Number(maxAttachmentFileSizeBytes) : maxAttachmentFileSizeBytes,
        membersCanUseGuestServerAttachments,
        messageArchiveServerPolicy: normalizedArchiveServerPolicy,
        messageArchiveServerMaxBytes: normalizedArchiveServerMaxBytes,
        messageArchiveCirclePolicy: normalizedArchiveCirclePolicy,
        messageArchiveCircleMaxBytes: normalizedArchiveCircleMaxBytes
      });

      if (!updatedConfig) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'NOT_FOUND', message: 'Family configuration not found' }
        } as ApiResponse);
      }

      return res.json({
        status: 'ok',
        result: familyConfigResult(updatedConfig)
      } as ApiResponse);

    } catch (error) {
      routeLogger.error('Update family config error:', error);
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to update family configuration'
        }
      } as ApiResponse);
    }
  }
);


export default router;
