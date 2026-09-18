import { familyConfigRepository } from '../db/repositories';
import { DBFamilyConfig } from '../db/types';
import { getEffectiveTrustedClientOrigins } from '../utils/trustedOrigins';
import type { MessageArchivePolicyMode } from '../utils/messageArchivePolicy';

/**
 * Config Service
 * Manages family-specific configuration retrieved from the database
 */
export class ConfigService {
  async getResolvedFamilyConfig(
    familyId: string,
    defaults: {
      serverName?: string;
      noNamesOnServer?: boolean;
      messageTtlHours?: number;
      chatEpochRotationIntervalHours?: number;
      chatEpochKeyRetentionHours?: number;
      attachmentsEnabled?: boolean;
      membersCanUseGuestServerAttachments?: boolean;
    } = {}
  ): Promise<{
    config: DBFamilyConfig | null;
    serverName: string;
    noNamesOnServer: boolean;
    messageTtlHours: number;
    chatEpochRotationIntervalHours: number;
    chatEpochKeyRetentionHours: number;
    extraTrustedClientOrigins: string[];
    effectiveTrustedClientOrigins: string[];
    attachmentsEnabled: boolean;
    maxAttachmentFileSizeBytes: number | null;
    attachmentStorageQuotaBytes: number | null;
    attachmentRetentionSeconds: number | null;
    membersCanUseGuestServerAttachments: boolean;
    maxMemberIdentities: number | null;
    maxTotalIdentities: number | null;
  }> {
    const config = await this.getFamilyConfig(familyId);
    const fallbackTtl = defaults.messageTtlHours ?? 24;
    const ttlValue = Number(config?.message_ttl_hours ?? fallbackTtl);
    const rotationValue = Number(config?.chat_epoch_rotation_interval_hours ?? defaults.chatEpochRotationIntervalHours ?? 168);
    const retentionValue = Number(config?.chat_epoch_key_retention_hours ?? defaults.chatEpochKeyRetentionHours ?? 720);
    return {
      config,
      serverName: config?.server_name || defaults.serverName || 'Family Server',
      noNamesOnServer: config?.no_names_on_server ?? defaults.noNamesOnServer ?? false,
      messageTtlHours: Number.isFinite(ttlValue) && ttlValue >= 1 ? Math.floor(ttlValue) : fallbackTtl,
      chatEpochRotationIntervalHours: Number.isFinite(rotationValue) && rotationValue >= 1 ? Math.floor(rotationValue) : 168,
      chatEpochKeyRetentionHours: Number.isFinite(retentionValue) && retentionValue >= 1 ? Math.floor(retentionValue) : 720,
      extraTrustedClientOrigins: config?.extra_trusted_client_origins || [],
      effectiveTrustedClientOrigins: getEffectiveTrustedClientOrigins(config),
      attachmentsEnabled: config?.attachments_enabled ?? defaults.attachmentsEnabled ?? false,
      maxAttachmentFileSizeBytes: config?.max_attachment_file_size_bytes ?? null,
      attachmentStorageQuotaBytes: config?.attachment_storage_quota_bytes ?? null,
      attachmentRetentionSeconds: config?.attachment_retention_seconds ?? null,
      membersCanUseGuestServerAttachments: config?.members_can_use_guest_server_attachments ?? defaults.membersCanUseGuestServerAttachments ?? true,
      maxMemberIdentities: config?.max_member_identities ?? null,
      maxTotalIdentities: config?.max_total_identities ?? null
    };
  }

  /**
   * Get family configuration by family_id
   */
  async getFamilyConfig(familyId: string): Promise<DBFamilyConfig | null> {
    return await familyConfigRepository.findByFamilyId(familyId);
  }

  /**
   * Get family configuration by family_id, throwing if not found
   */
  async requireFamilyConfig(familyId: string): Promise<DBFamilyConfig> {
    const config = await familyConfigRepository.findByFamilyId(familyId);
    if (!config) throw new Error(`Family config not found for familyId: ${familyId}`);
    return config;
  }

  /**
   * Get server name for a family
   */
  async getServerName(familyId: string): Promise<string | null> {
    const resolved = await this.getResolvedFamilyConfig(familyId);
    return resolved.config ? resolved.serverName : null;
  }

  /**
   * Check if this family forbids names stored on server
   */
  async getNoNamesOnServer(familyId: string): Promise<boolean> {
    const resolved = await this.getResolvedFamilyConfig(familyId);
    return resolved.noNamesOnServer;
  }

  async getMessageTtlHours(familyId: string, fallbackHours: number = 24): Promise<number> {
    const resolved = await this.getResolvedFamilyConfig(familyId, { messageTtlHours: fallbackHours });
    return resolved.messageTtlHours;
  }

  /**
   * Create or update family configuration
   */
  async upsertFamilyConfig(data: {
    familyId: string;
    serverName: string;
    publicBaseUrl?: string | null;
      firstOwnerInviteToken?: string | null;
      noNamesOnServer?: boolean;
      messageTtlHours?: number;
      chatEpochRotationIntervalHours?: number;
      chatEpochKeyRetentionHours?: number;
      extraTrustedClientOrigins?: string[];
      attachmentsEnabled?: boolean;
      maxAttachmentFileSizeBytes?: number | null;
      attachmentStorageQuotaBytes?: number | null;
      attachmentRetentionSeconds?: number | null;
      membersCanUseGuestServerAttachments?: boolean;
      maxMemberIdentities?: number | null;
      maxTotalIdentities?: number | null;
      messageArchiveServerPolicy?: MessageArchivePolicyMode;
      messageArchiveServerMaxBytes?: number | null;
      messageArchiveCirclePolicy?: MessageArchivePolicyMode;
      messageArchiveCircleMaxBytes?: number | null;
  }): Promise<DBFamilyConfig> {
    return await familyConfigRepository.upsert(data);
  }

  /**
   * Update family configuration
   */
  async updateFamilyConfig(
    familyId: string,
    data: {
      serverName?: string;
      publicBaseUrl?: string | null;
      firstOwnerInviteToken?: string | null;
      messageTtlHours?: number;
      chatEpochRotationIntervalHours?: number;
      chatEpochKeyRetentionHours?: number;
      extraTrustedClientOrigins?: string[];
      attachmentsEnabled?: boolean;
      maxAttachmentFileSizeBytes?: number | null;
      attachmentStorageQuotaBytes?: number | null;
      attachmentRetentionSeconds?: number | null;
      membersCanUseGuestServerAttachments?: boolean;
      maxMemberIdentities?: number | null;
      maxTotalIdentities?: number | null;
      messageArchiveServerPolicy?: MessageArchivePolicyMode;
      messageArchiveServerMaxBytes?: number | null;
      messageArchiveCirclePolicy?: MessageArchivePolicyMode;
      messageArchiveCircleMaxBytes?: number | null;
    }
  ): Promise<DBFamilyConfig | null> {
    return await familyConfigRepository.update(familyId, data);
  }
}

export const configService = new ConfigService();
