import type { CircleMembershipStateRecord, IdentityId } from '../../../shared/types';
import { transaction } from '../db';
import { trustedDeviceRekeyRepository } from '../db/repositories';
import { requestTrustedDeviceRekeyProcessing } from './trustedDeviceRekeyService';
import { appendCircleMembershipState } from './circleMembershipStateService';
import { getRequestLogger } from '../middleware/requestContext';

export type IdentitySelfDisableResult = 'updated' | 'not_found' | 'forbidden' | 'invalid_state';

/** Retire live access and short-lived state, preserving recoverable and shared history. */
export async function disableOwnCircleIdentity(params: {
  familyId: string;
  identityId: IdentityId;
  membershipState: CircleMembershipStateRecord;
}): Promise<IdentitySelfDisableResult> {
  const { familyId, identityId, membershipState } = params;
  if (
    membershipState?.claim?.payload?.action !== 'remove'
    || membershipState.claim.signerId !== identityId
    || membershipState.claim.payload.subjectIdentityId !== identityId
    || membershipState.admission !== null
  ) return 'invalid_state';

  const outcome = await transaction(async (client) => {
    const result = await client.query<{ role: string; status: string }>(
      `SELECT role, status FROM identities
        WHERE family_id = $1 AND identity_id = $2 FOR UPDATE`,
      [familyId, identityId]
    );
    const identity = result.rows[0];
    if (!identity) return 'not_found';
    if (identity.role !== 'member') return 'forbidden';
    if (identity.status !== 'active') return 'invalid_state';

    // The append verifies the identity signature, membership head and exact
    // self-removal. A single rekey job snapshots all chats before the old
    // participant is marked inactive; all trusted devices are then revoked.
    await appendCircleMembershipState({ familyId, record: membershipState, client });
    const activeDevices = await client.query<{ device_id: string }>(
      `SELECT device_id FROM devices
        WHERE family_id = $1 AND identity_id = $2 AND status = 'active'
        FOR UPDATE`, [familyId, identityId]
    );
    const rekeyDeviceId = activeDevices.rows[0]?.device_id ?? null;
    if (!rekeyDeviceId) {
      getRequestLogger({ subsystem: 'identity' }).warn('identity_self_disable_device_context_missing', {
        operation: 'disableOwnCircleIdentity', reason: 'no_active_devices',
        familyId, identityId, missingFields: ['deviceId']
      });
    }
    const rekey = await trustedDeviceRekeyRepository.enqueue(client, {
      familyId, identityId,
      deviceId: rekeyDeviceId,
      reason: 'device_revoked'
    });
    // Block group writes at the cutoff, before the asynchronous rekey worker
    // publishes its notifications. Existing send routes reject this marker.
    await client.query(
      `UPDATE group_chats AS chat
          SET rekey_required_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
              rekey_required_reason = 'device_revoked',
              rekey_required_identity_id = $2,
              updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
        WHERE chat.family_id = $1 AND chat.protocol_version = 2
          AND EXISTS (
            SELECT 1 FROM group_chat_participants AS participant
             WHERE participant.family_id = chat.family_id
               AND participant.chat_id = chat.chat_id
               AND participant.identity_id = $2 AND participant.is_active = TRUE
          )`,
      [familyId, identityId]
    );
    await client.query(
      `UPDATE devices
          SET status = 'revoked', revoked_at = NOW(), revoked_reason = 'manual',
              inactivity_warning_sent_at = NULL
        WHERE family_id = $1 AND identity_id = $2 AND status = 'active'`,
      [familyId, identityId]
    );
    await client.query(
      `UPDATE group_chats AS chat
          SET owner_identity_id = (
                SELECT participant.identity_id
                  FROM group_chat_participants AS participant
                 WHERE participant.family_id = chat.family_id
                   AND participant.chat_id = chat.chat_id
                   AND participant.identity_id <> $2
                   AND participant.is_active = TRUE
                 ORDER BY participant.join_order ASC, participant.joined_at ASC
                 LIMIT 1
              ),
              updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
        WHERE chat.family_id = $1 AND chat.owner_identity_id = $2
          AND EXISTS (
            SELECT 1 FROM group_chat_participants AS participant
             WHERE participant.family_id = chat.family_id
               AND participant.chat_id = chat.chat_id
               AND participant.identity_id <> $2 AND participant.is_active = TRUE
          )`,
      [familyId, identityId]
    );
    await client.query(
      `UPDATE group_chat_participants
          SET is_active = FALSE,
              left_at = COALESCE(left_at, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
        WHERE family_id = $1 AND identity_id = $2 AND is_active = TRUE`,
      [familyId, identityId]
    );
    const scope = [familyId, identityId];
    await client.query(
      `UPDATE identities
          SET status = 'disabled', publish_identity = FALSE,
              presence_visible = FALSE, presence_last_seen_at = NULL
        WHERE family_id = $1 AND identity_id = $2 AND status = 'active'`,
      scope
    );

    // Presence and short-lived encrypted status are not historical evidence.
    await client.query(
      `DELETE FROM circle_encrypted_identity_statuses
        WHERE family_id = $1 AND owner_identity_id = $2`, scope
    );
    await client.query(
      `DELETE FROM direct_file_quick_receive_controls
        WHERE family_id = $1 AND (issuer_identity_id = $2 OR recipient_identity_id = $2)`, scope
    );

    // Retire live capabilities in the same transaction as membership removal.
    // Keep their rows when they form a journal or may be referenced by others.
    await client.query(
      `UPDATE invites SET status = 'revoked'
        WHERE family_id = $1 AND created_by = $2 AND status = 'active'`, scope
    );
    await client.query(
      `UPDATE call_links SET status = 'revoked'
        WHERE family_id = $1 AND (target_identity_id = $2 OR created_by = $2)
          AND status = 'active'`, scope
    );
    await client.query(
      `UPDATE direct_guest_links
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW()),
              updated_at = NOW(), public_site_visible = FALSE
        WHERE family_id = $1
          AND (host_identity_id = $2 OR created_by_identity_id = $2)
          AND status = 'active'`, scope
    );
    await client.query(
      `UPDATE direct_guest_registrations
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW()),
              updated_at = NOW()
        WHERE family_id = $1
          AND (host_identity_id = $2 OR guest_identity_id = $2)
          AND status = 'active'`, scope
    );
    await client.query(
      `UPDATE temporary_devices SET status = 'revoked'
        WHERE family_id = $1 AND identity_id = $2 AND status = 'active'`, scope
    );
    await client.query(
      `UPDATE device_enrollments
          SET state = 'rejected', encrypted_temporary_membership = NULL,
              new_device_ciphertext = NULL, new_device_cipher = NULL
        WHERE family_id = $1
          AND approved_by_device_id IN (
            SELECT device_id FROM devices WHERE family_id = $1 AND identity_id = $2
          )
          AND state IN ('pending_trusted_read', 'pending_trusted_approval', 'approved')`, scope
    );
    await client.query(
      `DELETE FROM device_notification_bindings
        WHERE family_id = $1
          AND web_device_id IN (
            SELECT device_id FROM devices WHERE family_id = $1 AND identity_id = $2
            UNION
            SELECT device_id FROM temporary_devices WHERE family_id = $1 AND identity_id = $2
          )`, scope
    );
    await client.query(
      `UPDATE announcement_channel_subscriptions
          SET status = 'unsubscribed', notifications_enabled = FALSE,
              updated_at = NOW(), unsubscribed_at = COALESCE(unsubscribed_at, NOW())
        WHERE family_id = $1 AND subscriber_identity_id = $2
          AND status IN ('active', 'paused')`, scope
    );
    await client.query(
      `UPDATE announcement_channels
          SET status = 'archived', archived_at = COALESCE(archived_at, NOW()),
              updated_at = NOW(), public_site_state = 'hidden', public_site_visible = FALSE
        WHERE family_id = $1 AND owner_identity_id = $2 AND status = 'active'`, scope
    );

    // Messages, attachments, Vault, archives, backups and signed history remain.
    return { status: 'updated' as const, rekeyPending: rekey.status === 'pending' };
  });
  if (typeof outcome === 'string') return outcome;
  if (outcome.rekeyPending) requestTrustedDeviceRekeyProcessing();
  return outcome.status;
}
