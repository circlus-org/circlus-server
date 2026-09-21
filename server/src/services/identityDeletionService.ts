import { transaction } from '../db';

export class IdentityDeletionServiceError extends Error {
  constructor(
    public status: number,
    public code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE',
    message: string
  ) {
    super(message);
    this.name = 'IdentityDeletionServiceError';
  }
}

export type DeleteIdentityDataResult = {
  attachmentStorageKeys: string[];
  publicSiteAssetStorageKeys: string[];
};

/**
 * Remove one identity's server-side Circle data without publishing mutation
 * events. Already synchronized peer devices keep their local message history.
 */
export async function deleteIdentityDataFromCircle(params: {
  familyId: string;
  identityId: string;
  unverifiedMembershipGuard?: {
    expectedMembershipStateId: string;
    expectedOwnerIdentityId: string;
  };
}): Promise<DeleteIdentityDataResult> {
  return transaction(async (client) => {
    if (params.unverifiedMembershipGuard) {
      const stateResult = await client.query<{
        state_id: string;
        claim: { payload?: { ownerIdentityId?: string; members?: Array<{ identityId?: string }> } };
      }>(
        `SELECT state_id, claim
           FROM circle_membership_states
          WHERE family_id = $1
          ORDER BY sequence DESC
          LIMIT 1
          FOR SHARE`,
        [params.familyId]
      );
      const current = stateResult.rows[0];
      const currentOwnerIdentityId = String(current?.claim?.payload?.ownerIdentityId || '').trim();
      const currentMembers = Array.isArray(current?.claim?.payload?.members)
        ? current.claim.payload.members
        : [];
      if (
        !current
        || current.state_id !== params.unverifiedMembershipGuard.expectedMembershipStateId
        || currentOwnerIdentityId !== params.unverifiedMembershipGuard.expectedOwnerIdentityId
      ) {
        throw new IdentityDeletionServiceError(
          409,
          'INVALID_STATE',
          'Circle membership state changed; refresh the list before deleting this profile'
        );
      }
      if (currentMembers.some((member) => member.identityId === params.identityId)) {
        throw new IdentityDeletionServiceError(
          409,
          'INVALID_STATE',
          'A verified Circle member cannot be deleted as an unverified profile'
        );
      }
    }

    const identityResult = await client.query<{ role: string | null }>(
      `SELECT role
         FROM identities
        WHERE family_id = $1 AND identity_id = $2
        FOR UPDATE`,
      [params.familyId, params.identityId]
    );
    const identity = identityResult.rows[0];
    if (!identity) {
      throw new IdentityDeletionServiceError(404, 'NOT_FOUND', 'Identity not found');
    }

    const configResult = await client.query<{ owner_identity_id: string | null }>(
      `SELECT owner_identity_id
         FROM family_config
        WHERE family_id = $1
        FOR UPDATE`,
      [params.familyId]
    );
    if (identity.role === 'owner' || configResult.rows[0]?.owner_identity_id === params.identityId) {
      throw new IdentityDeletionServiceError(
        409,
        'INVALID_STATE',
        'The Circle owner cannot delete their data until ownership is transferred'
      );
    }

    const deviceRows = await client.query<{ device_id: string }>(
      `SELECT device_id FROM devices WHERE family_id = $1 AND identity_id = $2
       UNION
       SELECT device_id FROM temporary_devices WHERE family_id = $1 AND identity_id = $2`,
      [params.familyId, params.identityId]
    );
    const deviceIds = deviceRows.rows.map((row) => row.device_id);
    const attachmentRows = await client.query<{
      storage_key: string;
      status: string;
      plaintext_size_bytes: string | number;
    }>(
      `SELECT storage_key, status, plaintext_size_bytes
         FROM attachment_blobs
        WHERE family_id = $1 AND uploader_identity_id = $2`,
      [params.familyId, params.identityId]
    );
    const publicSiteAssetRows = await client.query<{
      storage_key: string;
      status: string;
      size_bytes: string | number;
    }>(
      `SELECT storage_key, status, size_bytes
         FROM circle_site_publication_assets
        WHERE family_id = $1 AND uploader_identity_id = $2`,
      [params.familyId, params.identityId]
    );
    const committedBytes = attachmentRows.rows
      .filter((row) => row.status === 'committed')
      .reduce((sum, row) => sum + Number(row.plaintext_size_bytes || 0), 0)
      + publicSiteAssetRows.rows
        .filter((row) => row.status === 'ready' || row.status === 'published')
        .reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);
    const reservedBytes = attachmentRows.rows
      .filter((row) => row.status === 'reserved' || row.status === 'uploaded')
      .reduce((sum, row) => sum + Number(row.plaintext_size_bytes || 0), 0)
      + publicSiteAssetRows.rows
        .filter((row) => row.status === 'reserved')
        .reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);

    // Keep continuing group chats functional: hand groups owned by the leaving
    // member to their earliest remaining active participant.
    await client.query(
      `UPDATE group_chats AS chat
          SET owner_identity_id = (
                SELECT participant.identity_id
                  FROM group_chat_participants AS participant
                 WHERE participant.family_id = chat.family_id
                   AND participant.chat_id = chat.chat_id
                   AND participant.is_active = TRUE
                   AND participant.identity_id <> $2
                 ORDER BY participant.join_order ASC, participant.joined_at ASC
                 LIMIT 1
              ),
              updated_at = $3
        WHERE chat.family_id = $1
          AND chat.owner_identity_id = $2
          AND EXISTS (
            SELECT 1
              FROM group_chat_participants AS participant
             WHERE participant.family_id = chat.family_id
               AND participant.chat_id = chat.chat_id
               AND participant.is_active = TRUE
               AND participant.identity_id <> $2
          )`,
      [params.familyId, params.identityId, Date.now()]
    );

    const orphanedChatRows = await client.query<{ chat_id: string }>(
      `SELECT chat.chat_id
         FROM group_chats AS chat
        WHERE chat.family_id = $1
          AND chat.owner_identity_id = $2
          AND NOT EXISTS (
            SELECT 1
              FROM group_chat_participants AS participant
             WHERE participant.family_id = chat.family_id
               AND participant.chat_id = chat.chat_id
               AND participant.is_active = TRUE
               AND participant.identity_id <> $2
          )`,
      [params.familyId, params.identityId]
    );
    const orphanedChatIds = orphanedChatRows.rows.map((row) => row.chat_id);

    await client.query(
      `DELETE FROM group_chat_messages
        WHERE family_id = $1
          AND (
            sender_identity_id = $2
            OR (kind = 'system' AND COALESCE(system_payload_json, '') LIKE $3)
          )`,
      [params.familyId, params.identityId, `%${params.identityId}%`]
    );

    if (orphanedChatIds.length > 0) {
      await client.query(`DELETE FROM temporary_device_group_chat_key_envelopes WHERE family_id = $1 AND chat_id = ANY($2::text[])`, [params.familyId, orphanedChatIds]);
      await client.query(`DELETE FROM temporary_device_chat_access WHERE family_id = $1 AND chat_type = 'group' AND chat_id = ANY($2::text[])`, [params.familyId, orphanedChatIds]);
      await client.query(`DELETE FROM group_chat_key_envelopes WHERE family_id = $1 AND chat_id = ANY($2::text[])`, [params.familyId, orphanedChatIds]);
      await client.query(`DELETE FROM group_chat_epoch_keys WHERE family_id = $1 AND chat_id = ANY($2::text[])`, [params.familyId, orphanedChatIds]);
      await client.query(`DELETE FROM group_chat_messages WHERE family_id = $1 AND chat_id = ANY($2::text[])`, [params.familyId, orphanedChatIds]);
      await client.query(`DELETE FROM group_chat_reads WHERE family_id = $1 AND chat_id = ANY($2::text[])`, [params.familyId, orphanedChatIds]);
      await client.query(`DELETE FROM group_chat_participants WHERE family_id = $1 AND chat_id = ANY($2::text[])`, [params.familyId, orphanedChatIds]);
      await client.query(`DELETE FROM group_chats WHERE family_id = $1 AND chat_id = ANY($2::text[])`, [params.familyId, orphanedChatIds]);
    }

    await client.query(
      `UPDATE group_chat_key_envelopes
          SET publisher_identity_id = ''
        WHERE family_id = $1 AND publisher_identity_id = $2 AND identity_id <> $2`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `UPDATE temporary_device_group_chat_key_envelopes
          SET publisher_identity_id = ''
        WHERE family_id = $1 AND publisher_identity_id = $2`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `UPDATE group_chat_epoch_keys
          SET proposer_identity_id = '',
              proposer_device_id = NULL,
              signed_epoch_transition = NULL
        WHERE family_id = $1 AND proposer_identity_id = $2`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `UPDATE group_chat_participants
          SET added_by_identity_id = identity_id
        WHERE family_id = $1 AND added_by_identity_id = $2 AND identity_id <> $2`,
      [params.familyId, params.identityId]
    );
    await client.query(`DELETE FROM group_chat_key_envelopes WHERE family_id = $1 AND identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM group_chat_reads WHERE family_id = $1 AND identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM group_chat_participants WHERE family_id = $1 AND identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM circle_encrypted_identity_profiles WHERE family_id = $1 AND owner_identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM circle_encrypted_identity_statuses WHERE family_id = $1 AND owner_identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM circle_encrypted_shared_metadata WHERE family_id = $1 AND owner_identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM circle_profile_epoch_envelopes WHERE family_id = $1 AND recipient_identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(
      `UPDATE group_chats AS chat
          SET last_message_at = (
                SELECT message.created_at
                  FROM group_chat_messages AS message
                 WHERE message.family_id = chat.family_id AND message.chat_id = chat.chat_id
                 ORDER BY message.created_at DESC
                 LIMIT 1
              ),
              last_message_preview = (
                SELECT CASE WHEN message.kind = 'system'
                       THEN '[' || COALESCE(message.system_type, 'system') || ']'
                       ELSE '[encrypted]'
                       END
                  FROM group_chat_messages AS message
                 WHERE message.family_id = chat.family_id AND message.chat_id = chat.chat_id
                 ORDER BY message.created_at DESC
                 LIMIT 1
              )
        WHERE chat.family_id = $1`,
      [params.familyId]
    );

    await client.query(
      `DELETE FROM messages
        WHERE family_id = $1 AND (sender_identity_id = $2 OR recipient_identity_id = $2)`,
      [params.familyId, params.identityId]
    );
    await client.query(`DELETE FROM direct_chat_key_envelopes WHERE family_id = $1 AND (split_part(direct_chat_id, '::', 1) = $2 OR split_part(direct_chat_id, '::', 2) = $2)`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM direct_chat_epoch_keys WHERE family_id = $1 AND (split_part(direct_chat_id, '::', 1) = $2 OR split_part(direct_chat_id, '::', 2) = $2)`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM direct_chat_epoch_state WHERE family_id = $1 AND (split_part(direct_chat_id, '::', 1) = $2 OR split_part(direct_chat_id, '::', 2) = $2)`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM temporary_device_direct_chat_key_envelopes WHERE family_id = $1 AND (split_part(direct_chat_id, '::', 1) = $2 OR split_part(direct_chat_id, '::', 2) = $2)`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM temporary_device_chat_access WHERE family_id = $1 AND chat_type = 'direct' AND (split_part(chat_id, '::', 1) = $2 OR split_part(chat_id, '::', 2) = $2)`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM identity_read_cursors WHERE family_id::text = $1::text AND (reader_identity_id = $2 OR peer_identity_id = $2)`, [params.familyId, params.identityId]);

    await client.query(`DELETE FROM call_logs WHERE family_id = $1 AND (initiator_identity_id = $2 OR target_identity_id = $2)`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM call_sessions WHERE family_id = $1 AND (initiator = $2 OR $2 = ANY(participants))`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM call_links WHERE family_id = $1 AND (target_identity_id = $2 OR created_by = $2)`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM call_whitelist_entries WHERE family_id = $1 AND (owner_identity_id = $2 OR external_identity_id = $2)`, [params.familyId, params.identityId]);

    await client.query(
      `DELETE FROM circle_site_publication_assets
        WHERE family_id = $1 AND uploader_identity_id = $2`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `DELETE FROM circle_site_publications
        WHERE family_id = $1 AND author_identity_id = $2`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `DELETE FROM announcement_channel_subscriptions
        WHERE family_id = $1
          AND (
            subscriber_identity_id = $2
            OR channel_id IN (
              SELECT channel_id
              FROM announcement_channels
              WHERE family_id = $1 AND owner_identity_id = $2
            )
          )`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `DELETE FROM announcement_channel_links
        WHERE family_id = $1
          AND channel_id IN (
            SELECT channel_id
            FROM announcement_channels
            WHERE family_id = $1 AND owner_identity_id = $2
          )`,
      [params.familyId, params.identityId]
    );
    await client.query(`DELETE FROM announcement_channels WHERE family_id = $1 AND owner_identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(
      `DELETE FROM direct_file_quick_receive_controls
        WHERE family_id = $1 AND (issuer_identity_id = $2 OR recipient_identity_id = $2)`,
      [params.familyId, params.identityId]
    );
    await client.query(`DELETE FROM direct_guest_registrations WHERE family_id = $1 AND (host_identity_id = $2 OR guest_identity_id = $2)`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM direct_guest_links WHERE family_id = $1 AND (host_identity_id = $2 OR created_by_identity_id = $2)`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM direct_guest_link_defaults WHERE family_id = $1 AND host_identity_id = $2`, [params.familyId, params.identityId]);

    await client.query(`DELETE FROM invite_acceptances WHERE family_id = $1 AND accepted_by_identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM invites WHERE family_id = $1 AND created_by = $2`, [params.familyId, params.identityId]);
    await client.query(`DELETE FROM system_events WHERE family_id = $1 AND (recipient_identity_id = $2 OR payload::text LIKE $3)`, [params.familyId, params.identityId, `%${params.identityId}%`]);

    if (deviceIds.length > 0) {
      await client.query(`DELETE FROM message_device_sync WHERE family_id = $1 AND device_id = ANY($2::text[])`, [params.familyId, deviceIds]);
      await client.query(`DELETE FROM system_device_sync WHERE family_id = $1 AND device_id = ANY($2::text[])`, [params.familyId, deviceIds]);
      await client.query(`DELETE FROM call_device_sync WHERE family_id = $1 AND device_id = ANY($2::text[])`, [params.familyId, deviceIds]);
      await client.query(`DELETE FROM device_enrollments WHERE family_id = $1 AND (new_device_id = ANY($2::text[]) OR approved_by_device_id = ANY($2::text[]))`, [params.familyId, deviceIds]);
      await client.query(`DELETE FROM temporary_device_group_chat_key_envelopes WHERE family_id = $1 AND temporary_device_id = ANY($2::text[])`, [params.familyId, deviceIds]);
      await client.query(`DELETE FROM temporary_device_direct_chat_key_envelopes WHERE family_id = $1 AND temporary_device_id = ANY($2::text[])`, [params.familyId, deviceIds]);
      await client.query(`DELETE FROM temporary_device_chat_access WHERE family_id = $1 AND temporary_device_id = ANY($2::text[])`, [params.familyId, deviceIds]);
      await client.query(`DELETE FROM device_notification_bindings WHERE family_id = $1 AND web_device_id = ANY($2::text[])`, [params.familyId, deviceIds]);
    }
    await client.query(`DELETE FROM attachment_upload_reservations WHERE family_id = $1 AND uploader_identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(
      `DELETE FROM circle_file_access
        WHERE family_id = $1
          AND blob_id IN (SELECT blob_id FROM attachment_blobs WHERE family_id = $1 AND uploader_identity_id = $2)`,
      [params.familyId, params.identityId]
    );
    await client.query(`DELETE FROM attachment_blobs WHERE family_id = $1 AND uploader_identity_id = $2`, [params.familyId, params.identityId]);
    if (committedBytes > 0 || reservedBytes > 0) {
      await client.query(
        `UPDATE family_config
            SET used_attachment_storage_bytes = GREATEST(0, used_attachment_storage_bytes - $2),
                reserved_attachment_storage_bytes = GREATEST(0, reserved_attachment_storage_bytes - $3),
                updated_at = NOW()
          WHERE family_id = $1`,
        [params.familyId, committedBytes, reservedBytes]
      );
    }

    // Profile backups belong to the Circle-scoped lookup-secret namespace,
    // not to the identity that most recently uploaded them. Keep them available
    // for recovery after this identity is removed or replaced.

    await client.query(`DELETE FROM tenant_owner_claims WHERE family_id = $1 AND used_by_identity_id = $2`, [params.familyId, params.identityId]);
    await client.query(
      `UPDATE server_admins SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
        WHERE principal_identity_id = $1 AND status = 'active'`,
      [params.identityId]
    );

    // Cascades remove devices, vaults, archive records and temporary access.
    await client.query(`DELETE FROM identities WHERE family_id = $1 AND identity_id = $2`, [params.familyId, params.identityId]);

    return {
      attachmentStorageKeys: attachmentRows.rows.map((row) => row.storage_key),
      publicSiteAssetStorageKeys: publicSiteAssetRows.rows.map((row) => row.storage_key),
    };
  });
}
