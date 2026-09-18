import { query, transaction } from '../index';
import type { DBFamilyConfig } from '../types';
import type { FamilyDomainStatus } from './familyDomainRepository';

type FamilyConfigMutationParams = {
  familyId: string;
  serverName: string;
  publicBaseUrl: string | null;
  firstOwnerInviteToken: string | null;
  noNamesOnServer: boolean;
  messageTtlHours: number;
  chatEpochRotationIntervalHours: number;
  chatEpochKeyRetentionHours: number;
  extraTrustedClientOrigins: string[];
  attachmentsEnabled: boolean;
  maxAttachmentFileSizeBytes: number | null;
  attachmentStorageQuotaBytes: number | null;
  attachmentRetentionSeconds: number | null;
  membersCanUseGuestServerAttachments: boolean;
  maxMemberIdentities: number | null;
  maxTotalIdentities: number | null;
  messageArchiveServerPolicy: 'disabled' | 'text' | 'text_with_attachments';
  messageArchiveServerMaxBytes: number | null;
  messageArchiveCirclePolicy: 'disabled' | 'text' | 'text_with_attachments';
  messageArchiveCircleMaxBytes: number | null;
};

export type FamilyConfigListItem = DBFamilyConfig & {
  join_invite_token: string | null;
  join_invite_expires_at: Date | null;
  owner_claim_expires_at: Date | null;
  pending_owner_claim_count: number;
  identity_count: number;
  active_device_count: number;
  owner_active_device_count: number;
  active_channel_count: number;
  owner_identity_name: string | null;
  last_activity_at: Date | null;
  current_domain_host: string | null;
  current_domain_status: FamilyDomainStatus | null;
};

export class CircleDeleteGuardError extends Error {
  constructor(
    public readonly code: 'NOT_OWNER' | 'HAS_OTHER_IDENTITIES',
    message: string
  ) {
    super(message);
    this.name = 'CircleDeleteGuardError';
  }
}

export class TenantSuspensionError extends Error {
  constructor(
    public readonly code: 'INVALID_STATE' | 'LAST_REACHABLE_SERVER_ADMIN' | 'DOMAIN_UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'TenantSuspensionError';
  }
}

export class FamilyConfigRepository {
  /**
   * Find family config by family_id
   */
  async findByFamilyId(familyId: string): Promise<DBFamilyConfig | null> {
    const results = await query<DBFamilyConfig>(
      `SELECT * FROM family_config WHERE family_id = $1 LIMIT 1`,
      [familyId]
    );
    return results.rows[0] || null;
  }

  /**
   * Get all family configs (for multi-tenancy admin)
   */
  async findAll(): Promise<DBFamilyConfig[]> {
    const results = await query<DBFamilyConfig>(
      `SELECT * FROM family_config ORDER BY created_at DESC`
    );
    return results.rows;
  }

  async countAll(): Promise<number> {
    const results = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM family_config`);
    return Number(results.rows[0]?.count || 0);
  }

  async replaceJoinInvite(familyId: string, joinInviteId: string, joinInviteToken: string): Promise<DBFamilyConfig | null> {
    const results = await query<DBFamilyConfig>(
      `UPDATE family_config
       SET join_invite_id = $2,
           first_owner_invite_token = $3,
           updated_at = NOW()
       WHERE family_id = $1
       RETURNING *`,
      [familyId, joinInviteId, joinInviteToken]
    );
    return results.rows[0] || null;
  }

  /**
   * List all circles with provisioning stats (for server admin panel)
   */
  async listWithStats(): Promise<FamilyConfigListItem[]> {
    const result = await query<FamilyConfigListItem>(
      `SELECT
         fc.*,
         inv.token AS join_invite_token,
         inv.expires_at AS join_invite_expires_at,
         claims.owner_claim_expires_at,
         COALESCE(claims.pending_owner_claim_count, 0)::int AS pending_owner_claim_count,
         COALESCE(ids.identity_count, 0)::int AS identity_count,
         COALESCE(device_stats.active_device_count, 0)::int AS active_device_count,
         COALESCE(device_stats.owner_active_device_count, 0)::int AS owner_active_device_count,
         COALESCE(channel_stats.active_channel_count, 0)::int AS active_channel_count,
         owner_identity.identity_name AS owner_identity_name,
         activity.last_activity_at,
         current_domain.host AS current_domain_host,
         current_domain.status AS current_domain_status
       FROM family_config fc
       LEFT JOIN invites inv
         ON inv.invite_id = fc.join_invite_id
       LEFT JOIN (
         SELECT
           family_id,
           MAX(expires_at) FILTER (WHERE status = 'pending') AS owner_claim_expires_at,
           COUNT(DISTINCT claim_id) FILTER (WHERE status = 'pending') AS pending_owner_claim_count
         FROM tenant_owner_claims
         GROUP BY family_id
       ) claims
         ON claims.family_id = fc.family_id
       LEFT JOIN (
         SELECT
           family_id,
           COUNT(DISTINCT identity_id) AS identity_count
         FROM identities
         GROUP BY family_id
       ) ids
         ON ids.family_id = fc.family_id
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (
             WHERE d.status = 'active'
               AND i.status = 'active'
               AND i.role IN ('owner', 'member')
           ) AS active_device_count,
           COUNT(*) FILTER (
             WHERE d.status = 'active'
               AND i.status = 'active'
               AND i.role = 'owner'
               AND d.identity_id::text = fc.owner_identity_id::text
           ) AS owner_active_device_count
         FROM devices d
         JOIN identities i
           ON i.family_id::text = d.family_id::text
          AND i.identity_id::text = d.identity_id::text
         WHERE d.family_id::text = fc.family_id::text
       ) device_stats ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS active_channel_count
         FROM announcement_channels channel
         WHERE channel.family_id::text = fc.family_id::text
           AND channel.status = 'active'
       ) channel_stats ON TRUE
       LEFT JOIN identities owner_identity
         ON owner_identity.family_id::text = fc.family_id::text
        AND owner_identity.identity_id::text = fc.owner_identity_id::text
       LEFT JOIN LATERAL (
         SELECT MAX(value) AS last_activity_at
         FROM (
           SELECT MAX(d.last_seen_at) AS value
           FROM devices d
           WHERE d.family_id::text = fc.family_id::text
           UNION ALL
           SELECT MAX(to_timestamp(m.created_at / 1000.0)) AS value
           FROM messages m
           WHERE m.family_id::text = fc.family_id::text
           UNION ALL
           SELECT MAX(to_timestamp(greatest(COALESCE(gc.last_message_at, 0), COALESCE(gc.updated_at, 0)) / 1000.0)) AS value
           FROM group_chats gc
           WHERE gc.family_id::text = fc.family_id::text
         ) activity_values
       ) activity ON TRUE
       LEFT JOIN LATERAL (
         SELECT fd.host, fd.status
         FROM family_domains fd
         WHERE fd.family_id::text = fc.family_id::text
         ORDER BY fd.is_current DESC, fd.created_at DESC
         LIMIT 1
       ) current_domain ON TRUE
       ORDER BY fc.created_at DESC`
    );
    return result.rows;
  }

  /**
   * Create new family config
   */
  async create(data: {
    familyId: string;
    serverName: string;
    publicBaseUrl: string;
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
    messageArchiveServerPolicy?: 'disabled' | 'text' | 'text_with_attachments';
    messageArchiveServerMaxBytes?: number | null;
    messageArchiveCirclePolicy?: 'disabled' | 'text' | 'text_with_attachments';
    messageArchiveCircleMaxBytes?: number | null;
    // Provisioning fields
    provisionStatus?: 'pending_owner' | 'active' | 'suspended' | 'revoked';
    ownerIdentityId?: string | null;
    createdByServerAdminId?: string | null;
    joinInviteId?: string | null;
  }): Promise<DBFamilyConfig> {
    const params: FamilyConfigMutationParams = {
      familyId: data.familyId,
      serverName: data.serverName,
      publicBaseUrl: data.publicBaseUrl,
      firstOwnerInviteToken: data.firstOwnerInviteToken || null,
      noNamesOnServer: data.noNamesOnServer ?? false,
      messageTtlHours: data.messageTtlHours ?? 24,
      chatEpochRotationIntervalHours: data.chatEpochRotationIntervalHours ?? 168,
      chatEpochKeyRetentionHours: data.chatEpochKeyRetentionHours ?? 720,
      extraTrustedClientOrigins: data.extraTrustedClientOrigins || [],
      attachmentsEnabled: data.attachmentsEnabled ?? false,
      maxAttachmentFileSizeBytes: data.maxAttachmentFileSizeBytes ?? null,
      attachmentStorageQuotaBytes: data.attachmentStorageQuotaBytes ?? null,
      attachmentRetentionSeconds: data.attachmentRetentionSeconds ?? null,
      membersCanUseGuestServerAttachments: data.membersCanUseGuestServerAttachments ?? true,
      maxMemberIdentities: data.maxMemberIdentities ?? null,
      maxTotalIdentities: data.maxTotalIdentities ?? null,
      messageArchiveServerPolicy: data.messageArchiveServerPolicy ?? 'text',
      messageArchiveServerMaxBytes: data.messageArchiveServerMaxBytes ?? null,
      messageArchiveCirclePolicy: data.messageArchiveCirclePolicy ?? data.messageArchiveServerPolicy ?? 'text',
      messageArchiveCircleMaxBytes: data.messageArchiveCircleMaxBytes ?? data.messageArchiveServerMaxBytes ?? null,
    };
    const results = await query<DBFamilyConfig>(
      `INSERT INTO family_config (
         family_id,
         server_name,
         public_base_url,
         first_owner_invite_token,
         no_names_on_server,
         message_ttl_hours,
         chat_epoch_rotation_interval_hours,
         chat_epoch_key_retention_hours,
         extra_trusted_client_origins,
         attachments_enabled,
         max_attachment_file_size_bytes,
         attachment_storage_quota_bytes,
         attachment_retention_seconds,
         members_can_use_guest_server_attachments,
         max_member_identities,
         max_total_identities,
         message_archive_server_policy,
         message_archive_server_max_bytes,
         message_archive_circle_policy,
         message_archive_circle_max_bytes,
         status,
         owner_identity_id,
         created_by_server_admin_id,
         join_invite_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
       RETURNING *`,
      [
        params.familyId,
        params.serverName,
        params.publicBaseUrl,
        params.firstOwnerInviteToken,
        params.noNamesOnServer,
        params.messageTtlHours,
        params.chatEpochRotationIntervalHours,
        params.chatEpochKeyRetentionHours,
        params.extraTrustedClientOrigins,
        params.attachmentsEnabled,
        params.maxAttachmentFileSizeBytes,
        params.attachmentStorageQuotaBytes,
        params.attachmentRetentionSeconds,
        params.membersCanUseGuestServerAttachments,
        params.maxMemberIdentities,
        params.maxTotalIdentities,
        params.messageArchiveServerPolicy,
        params.messageArchiveServerMaxBytes,
        params.messageArchiveCirclePolicy,
        params.messageArchiveCircleMaxBytes,
        data.provisionStatus ?? 'active',
        data.ownerIdentityId ?? null,
        data.createdByServerAdminId ?? null,
        data.joinInviteId ?? null,
      ]
    );
    return results.rows[0];
  }

  /**
   * Update family config
   */
  async update(
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
      messageArchiveServerPolicy?: 'disabled' | 'text' | 'text_with_attachments';
      messageArchiveServerMaxBytes?: number | null;
      messageArchiveCirclePolicy?: 'disabled' | 'text' | 'text_with_attachments';
      messageArchiveCircleMaxBytes?: number | null;
    }
  ): Promise<DBFamilyConfig | null> {
    let result: DBFamilyConfig | null = null;

    if (data.serverName !== undefined) {
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET server_name = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, data.serverName]
      );
      result = results.rows[0] || null;
    }

    if (data.publicBaseUrl !== undefined) {
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET public_base_url = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, data.publicBaseUrl]
      );
      result = results.rows[0] || null;
    }

    if (data.firstOwnerInviteToken !== undefined) {
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET first_owner_invite_token = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, data.firstOwnerInviteToken]
      );
      result = results.rows[0] || null;
    }

    if (data.messageTtlHours !== undefined) {
      const ttlHours = Math.max(1, Math.floor(data.messageTtlHours));
      const ttlResult = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET message_ttl_hours = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, ttlHours]
      );
      result = ttlResult.rows[0] || null;
    }

    if (data.chatEpochRotationIntervalHours !== undefined) {
      const hours = Math.max(1, Math.floor(data.chatEpochRotationIntervalHours));
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET chat_epoch_rotation_interval_hours = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, hours]
      );
      result = results.rows[0] || null;
    }

    if (data.chatEpochKeyRetentionHours !== undefined) {
      const hours = Math.max(1, Math.floor(data.chatEpochKeyRetentionHours));
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET chat_epoch_key_retention_hours = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, hours]
      );
      result = results.rows[0] || null;
    }

    if (data.extraTrustedClientOrigins !== undefined) {
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET extra_trusted_client_origins = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, data.extraTrustedClientOrigins]
      );
      result = results.rows[0] || null;
    }

    if (data.attachmentsEnabled !== undefined) {
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET attachments_enabled = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, data.attachmentsEnabled]
      );
      result = results.rows[0] || null;
    }

    if (data.maxAttachmentFileSizeBytes !== undefined) {
      const value = data.maxAttachmentFileSizeBytes === null ? null : Math.max(1, Math.floor(data.maxAttachmentFileSizeBytes));
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET max_attachment_file_size_bytes = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, value]
      );
      result = results.rows[0] || null;
    }

    if (data.attachmentStorageQuotaBytes !== undefined) {
      const value = data.attachmentStorageQuotaBytes === null ? null : Math.max(1, Math.floor(data.attachmentStorageQuotaBytes));
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET attachment_storage_quota_bytes = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, value]
      );
      result = results.rows[0] || null;
    }

    if (data.attachmentRetentionSeconds !== undefined) {
      const value = data.attachmentRetentionSeconds === null ? null : Math.max(60, Math.floor(data.attachmentRetentionSeconds));
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET attachment_retention_seconds = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, value]
      );
      result = results.rows[0] || null;
    }

    if (data.membersCanUseGuestServerAttachments !== undefined) {
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET members_can_use_guest_server_attachments = $2, updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, data.membersCanUseGuestServerAttachments]
      );
      result = results.rows[0] || null;
    }

    if (data.maxMemberIdentities !== undefined || data.maxTotalIdentities !== undefined) {
      const current = await this.findByFamilyId(familyId);
      if (!current) return null;
      const maxMemberIdentities = data.maxMemberIdentities === undefined
        ? current.max_member_identities
        : (data.maxMemberIdentities === null ? null : Math.max(1, Math.floor(data.maxMemberIdentities)));
      const maxTotalIdentities = data.maxTotalIdentities === undefined
        ? current.max_total_identities
        : (data.maxTotalIdentities === null ? null : Math.max(1, Math.floor(data.maxTotalIdentities)));
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET max_member_identities = $2,
             max_total_identities = $3,
             updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, maxMemberIdentities, maxTotalIdentities]
      );
      result = results.rows[0] || null;
    }

    if (
      data.messageArchiveServerPolicy !== undefined
      || data.messageArchiveServerMaxBytes !== undefined
      || data.messageArchiveCirclePolicy !== undefined
      || data.messageArchiveCircleMaxBytes !== undefined
    ) {
      const current = await this.findByFamilyId(familyId);
      if (!current) return null;
      const serverPolicy = data.messageArchiveServerPolicy ?? current.message_archive_server_policy;
      const serverMaxBytes = data.messageArchiveServerMaxBytes === undefined
        ? current.message_archive_server_max_bytes
        : data.messageArchiveServerMaxBytes;
      const circlePolicy = data.messageArchiveCirclePolicy ?? current.message_archive_circle_policy;
      const circleMaxBytes = data.messageArchiveCircleMaxBytes === undefined
        ? current.message_archive_circle_max_bytes
        : data.messageArchiveCircleMaxBytes;
      const results = await query<DBFamilyConfig>(
        `UPDATE family_config
         SET message_archive_server_policy = $2,
             message_archive_server_max_bytes = $3,
             message_archive_circle_policy = $4,
             message_archive_circle_max_bytes = $5,
             updated_at = NOW()
         WHERE family_id = $1
         RETURNING *`,
        [familyId, serverPolicy, serverMaxBytes, circlePolicy, circleMaxBytes]
      );
      result = results.rows[0] || null;
    }

    if (result === null && (data.serverName === undefined && data.publicBaseUrl === undefined && data.firstOwnerInviteToken === undefined && data.messageTtlHours === undefined && data.chatEpochRotationIntervalHours === undefined && data.chatEpochKeyRetentionHours === undefined && data.extraTrustedClientOrigins === undefined && data.attachmentsEnabled === undefined && data.maxAttachmentFileSizeBytes === undefined && data.attachmentStorageQuotaBytes === undefined && data.attachmentRetentionSeconds === undefined && data.membersCanUseGuestServerAttachments === undefined && data.maxMemberIdentities === undefined && data.maxTotalIdentities === undefined && data.messageArchiveServerPolicy === undefined && data.messageArchiveServerMaxBytes === undefined && data.messageArchiveCirclePolicy === undefined && data.messageArchiveCircleMaxBytes === undefined)) {
      return this.findByFamilyId(familyId);
    }

    return result;
  }

  /**
   * Upsert family config (insert or update).
   * Does not overwrite provisioning fields on conflict.
   */
  async upsert(data: {
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
    messageArchiveServerPolicy?: 'disabled' | 'text' | 'text_with_attachments';
    messageArchiveServerMaxBytes?: number | null;
    messageArchiveCirclePolicy?: 'disabled' | 'text' | 'text_with_attachments';
    messageArchiveCircleMaxBytes?: number | null;
  }): Promise<DBFamilyConfig> {
    const params: FamilyConfigMutationParams = {
      familyId: data.familyId,
      serverName: data.serverName,
      publicBaseUrl: data.publicBaseUrl || null,
      firstOwnerInviteToken: data.firstOwnerInviteToken || null,
      noNamesOnServer: data.noNamesOnServer ?? false,
      messageTtlHours: data.messageTtlHours ?? 24,
      chatEpochRotationIntervalHours: data.chatEpochRotationIntervalHours ?? 168,
      chatEpochKeyRetentionHours: data.chatEpochKeyRetentionHours ?? 720,
      extraTrustedClientOrigins: data.extraTrustedClientOrigins || [],
      attachmentsEnabled: data.attachmentsEnabled ?? false,
      maxAttachmentFileSizeBytes: data.maxAttachmentFileSizeBytes ?? null,
      attachmentStorageQuotaBytes: data.attachmentStorageQuotaBytes ?? null,
      attachmentRetentionSeconds: data.attachmentRetentionSeconds ?? null,
      membersCanUseGuestServerAttachments: data.membersCanUseGuestServerAttachments ?? true,
      maxMemberIdentities: data.maxMemberIdentities ?? null,
      maxTotalIdentities: data.maxTotalIdentities ?? null,
      messageArchiveServerPolicy: data.messageArchiveServerPolicy ?? 'text',
      messageArchiveServerMaxBytes: data.messageArchiveServerMaxBytes ?? null,
      messageArchiveCirclePolicy: data.messageArchiveCirclePolicy ?? data.messageArchiveServerPolicy ?? 'text',
      messageArchiveCircleMaxBytes: data.messageArchiveCircleMaxBytes ?? data.messageArchiveServerMaxBytes ?? null,
    };
    const results = await query<DBFamilyConfig>(
      `INSERT INTO family_config (
         family_id,
         server_name,
         public_base_url,
         first_owner_invite_token,
         no_names_on_server,
         message_ttl_hours,
         chat_epoch_rotation_interval_hours,
         chat_epoch_key_retention_hours,
         extra_trusted_client_origins,
         attachments_enabled,
         max_attachment_file_size_bytes,
         attachment_storage_quota_bytes,
         attachment_retention_seconds,
         members_can_use_guest_server_attachments,
         max_member_identities,
         max_total_identities,
         message_archive_server_policy,
         message_archive_server_max_bytes,
         message_archive_circle_policy,
         message_archive_circle_max_bytes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (family_id)
       DO UPDATE SET
         server_name = EXCLUDED.server_name,
         public_base_url = COALESCE(EXCLUDED.public_base_url, family_config.public_base_url),
         first_owner_invite_token = EXCLUDED.first_owner_invite_token,
         no_names_on_server = EXCLUDED.no_names_on_server,
         message_ttl_hours = EXCLUDED.message_ttl_hours,
         chat_epoch_rotation_interval_hours = EXCLUDED.chat_epoch_rotation_interval_hours,
         chat_epoch_key_retention_hours = EXCLUDED.chat_epoch_key_retention_hours,
         extra_trusted_client_origins = EXCLUDED.extra_trusted_client_origins,
         attachments_enabled = EXCLUDED.attachments_enabled,
         max_attachment_file_size_bytes = EXCLUDED.max_attachment_file_size_bytes,
         attachment_storage_quota_bytes = EXCLUDED.attachment_storage_quota_bytes,
         attachment_retention_seconds = EXCLUDED.attachment_retention_seconds,
         members_can_use_guest_server_attachments = EXCLUDED.members_can_use_guest_server_attachments,
         max_member_identities = EXCLUDED.max_member_identities,
         max_total_identities = EXCLUDED.max_total_identities,
         message_archive_server_policy = EXCLUDED.message_archive_server_policy,
         message_archive_server_max_bytes = EXCLUDED.message_archive_server_max_bytes,
         message_archive_circle_policy = EXCLUDED.message_archive_circle_policy,
         message_archive_circle_max_bytes = EXCLUDED.message_archive_circle_max_bytes,
         updated_at = NOW()
       RETURNING *`,
      [
        params.familyId,
        params.serverName,
        params.publicBaseUrl,
        params.firstOwnerInviteToken,
        params.noNamesOnServer,
        params.messageTtlHours,
        params.chatEpochRotationIntervalHours,
        params.chatEpochKeyRetentionHours,
        params.extraTrustedClientOrigins,
        params.attachmentsEnabled,
        params.maxAttachmentFileSizeBytes,
        params.attachmentStorageQuotaBytes,
        params.attachmentRetentionSeconds,
        params.membersCanUseGuestServerAttachments,
        params.maxMemberIdentities,
        params.maxTotalIdentities,
        params.messageArchiveServerPolicy,
        params.messageArchiveServerMaxBytes,
        params.messageArchiveCirclePolicy,
        params.messageArchiveCircleMaxBytes
      ]
    );
    return results.rows[0];
  }

  /**
   * Activate a pending circle after owner claims it.
   */
  async activate(familyId: string, ownerIdentityId: string): Promise<void> {
    await query(
      `UPDATE family_config
       SET status = 'active', owner_identity_id = $2, claimed_at = NOW(), updated_at = NOW()
       WHERE family_id = $1`,
      [familyId, ownerIdentityId]
    );
  }

  async suspendWithDomain(params: {
    familyId: string;
    requestFamilyId: string;
  }): Promise<void> {
    await transaction(async (client) => {
      const config = await client.query<{ status: string }>(
        `SELECT status FROM family_config WHERE family_id = $1 FOR UPDATE`,
        [params.familyId]
      );
      if (config.rows[0]?.status !== 'active') {
        throw new TenantSuspensionError('INVALID_STATE', `Circle is ${config.rows[0]?.status || 'missing'}`);
      }

      if (params.requestFamilyId === params.familyId) {
        const alternateAdmin = await client.query<{ available: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM server_admins sa
             JOIN identities i ON i.identity_id = sa.principal_identity_id
             JOIN family_config carrier ON carrier.family_id = i.family_id
             JOIN devices d ON d.family_id = i.family_id AND d.identity_id = i.identity_id
             WHERE sa.status = 'active'
               AND i.status = 'active'
               AND d.status = 'active'
               AND carrier.status = 'active'
               AND carrier.family_id <> $1
           ) AS available`,
          [params.familyId]
        );
        if (alternateAdmin.rows[0]?.available !== true) {
          throw new TenantSuspensionError(
            'LAST_REACHABLE_SERVER_ADMIN',
            'Grant server administrator access through another active Circle before suspending this Circle'
          );
        }
      }

      const domain = await client.query<{ id: string }>(
        `SELECT id
         FROM family_domains
         WHERE family_id = $1 AND is_current = TRUE AND status = 'active'
         FOR UPDATE`,
        [params.familyId]
      );
      if (!domain.rows[0]) {
        throw new TenantSuspensionError('DOMAIN_UNAVAILABLE', 'Circle has no active current domain');
      }

      await client.query(
        `UPDATE family_config
         SET status = 'suspended', suspended_at = NOW(), updated_at = NOW()
         WHERE family_id = $1`,
        [params.familyId]
      );
      await client.query(
        `UPDATE family_domains
         SET status = 'suspended', disabled_at = COALESCE(disabled_at, NOW())
         WHERE family_id = $1 AND status = 'active'`,
        [params.familyId]
      );
    });
  }

  async resumeWithDomain(familyId: string): Promise<void> {
    await transaction(async (client) => {
      const config = await client.query<{ status: string }>(
        `SELECT status FROM family_config WHERE family_id = $1 FOR UPDATE`,
        [familyId]
      );
      if (config.rows[0]?.status !== 'suspended') {
        throw new TenantSuspensionError('INVALID_STATE', `Circle is ${config.rows[0]?.status || 'missing'}`);
      }

      const domain = await client.query<{ id: string }>(
        `SELECT id
         FROM family_domains
         WHERE family_id = $1 AND is_current = TRUE AND status = 'suspended'
         FOR UPDATE`,
        [familyId]
      );
      if (!domain.rows[0]) {
        throw new TenantSuspensionError('DOMAIN_UNAVAILABLE', 'Circle has no suspended current domain');
      }

      await client.query(
        `UPDATE family_domains
         SET status = 'active', disabled_at = NULL
         WHERE family_id = $1 AND status = 'suspended'`,
        [familyId]
      );
      await client.query(
        `UPDATE family_config
         SET status = 'active', suspended_at = NULL, updated_at = NOW()
         WHERE family_id = $1`,
        [familyId]
      );
    });
  }

  /**
   * Delete a circle and all server-side tenant data that may reference it.
   * File payloads are removed by the caller after this transaction commits.
   */
  async deleteWithData(
    familyId: string,
    options?: { requireSoleOwnerIdentityId?: string }
  ): Promise<{ attachmentStorageKeys: string[]; publicSiteAssetStorageKeys: string[] }> {
    return transaction(async (client) => {
      if (options?.requireSoleOwnerIdentityId) {
        const ownerIdentityId = options.requireSoleOwnerIdentityId;
        const config = await client.query<{ owner_identity_id: string | null }>(
          `SELECT owner_identity_id
           FROM family_config
           WHERE family_id = $1
           FOR UPDATE`,
          [familyId]
        );
        const owner = await client.query<{ identity_id: string }>(
          `SELECT identity_id
           FROM identities
           WHERE family_id = $1
             AND identity_id = $2
             AND role = 'owner'
           FOR UPDATE`,
          [familyId, ownerIdentityId]
        );

        if (config.rows[0]?.owner_identity_id !== ownerIdentityId || !owner.rows[0]) {
          throw new CircleDeleteGuardError('NOT_OWNER', 'Only the Circle owner can delete the Circle');
        }

        const activeIdentityCount = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM identities
           WHERE family_id = $1
             AND identity_id <> $2
             AND status = 'active'`,
          [familyId, ownerIdentityId]
        );
        if (Number(activeIdentityCount.rows[0]?.count || 0) !== 0) {
          throw new CircleDeleteGuardError(
            'HAS_OTHER_IDENTITIES',
            'Transfer Circle ownership before deleting your data'
          );
        }
      }

      const blobs = await client.query<{ storage_key: string }>(
        `SELECT storage_key FROM attachment_blobs WHERE family_id = $1`,
        [familyId]
      );
      const publicSiteAssets = await client.query<{ storage_key: string }>(
        `SELECT storage_key FROM circle_site_publication_assets WHERE family_id = $1`,
        [familyId]
      );

      await client.query(
        `UPDATE server_admins
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
         WHERE status = 'active'
           AND principal_identity_id IN (
             SELECT identity_id FROM identities WHERE family_id = $1
           )`,
        [familyId]
      );

      const tenantTablesInDeleteOrder = [
        'message_archive_segments',
        'message_archive_jobs',
        'announcement_channel_push_outbox',
        'circle_site_publication_assets',
        'circle_site_publications',
        'attachment_upload_reservations',
        'circle_file_access',
        'attachment_blobs',
        'temporary_device_group_chat_key_envelopes',
        'temporary_device_direct_chat_key_envelopes',
        'temporary_device_chat_access',
        'temporary_access_requests',
        'device_enrollments',
        'call_logs',
        'call_device_sync',
        'announcement_channel_key_envelopes',
        'announcement_channel_posts',
        'announcement_channel_epoch_keys',
        'announcement_channel_subscriptions',
        'announcement_channel_links',
        'announcement_channels',
        'direct_guest_registrations',
        'direct_guest_link_defaults',
        'direct_guest_links',
        'circle_encrypted_identity_profiles',
        'circle_profile_epoch_envelopes',
        'circle_profile_epochs',
        'circle_membership_states',
        'invite_acceptances',
        'group_chat_key_envelopes',
        'group_chat_epoch_keys',
        'group_chat_messages',
        'group_chat_reads',
        'group_chat_participants',
        'group_chats',
        'direct_chat_key_envelopes',
        'direct_chat_epoch_keys',
        'direct_chat_epoch_state',
        'identity_read_cursors',
        'messages',
        'message_device_sync',
        'system_events',
        'system_device_sync',
        'call_sessions',
        'call_links',
        'call_whitelist_entries',
        'device_notification_bindings',
        'push_subscriptions',
        'identity_backups',
        'temporary_devices',
        'vaults',
        'devices',
        'invites',
        'identities'
      ];

      for (const table of tenantTablesInDeleteOrder) {
        await client.query(`DELETE FROM ${table} WHERE family_id = $1`, [familyId]);
      }

      // Preserve an explicit, non-sensitive host tombstone before
      // family_config deletion cascades into family_domains. Old clients can
      // then distinguish a permanently deleted Circle from a network outage.
      await client.query(
        `INSERT INTO deleted_circle_domains (
           host,
           family_id,
           public_base_url,
           extra_trusted_client_origins,
           deleted_at
         )
         SELECT
           fd.host,
           fd.family_id,
           fd.public_base_url,
           fc.extra_trusted_client_origins,
           NOW()
         FROM family_domains fd
         JOIN family_config fc ON fc.family_id = fd.family_id
         WHERE fd.family_id = $1
         ON CONFLICT (host) DO UPDATE
         SET family_id = EXCLUDED.family_id,
             public_base_url = EXCLUDED.public_base_url,
             extra_trusted_client_origins = EXCLUDED.extra_trusted_client_origins,
             deleted_at = EXCLUDED.deleted_at`,
        [familyId]
      );

      await client.query(`DELETE FROM family_config WHERE family_id = $1`, [familyId]);
      return {
        attachmentStorageKeys: blobs.rows.map((blob) => blob.storage_key),
        publicSiteAssetStorageKeys: publicSiteAssets.rows.map((asset) => asset.storage_key),
      };
    });
  }

  /**
   * Check if family exists
   */
  async exists(familyId: string): Promise<boolean> {
    const results = await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM family_config WHERE family_id = $1) as exists`,
      [familyId]
    );
    return results.rows[0]?.exists || false;
  }
}

export const familyConfigRepository = new FamilyConfigRepository();
