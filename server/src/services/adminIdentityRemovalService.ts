import type { IdentityId } from '../../../shared/types';
import { transaction } from '../db';

type RemovableIdentityRow = {
  identity_id: string;
  role: string | null;
  status: string;
};

export class AdminIdentityRemovalError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_STATE',
    message: string
  ) {
    super(message);
  }
}

/**
 * Permanently end an identity's Circle membership without deleting historical
 * messages, calls, or audit references.
 *
 * The explicit disabled -> removed transition makes the owner revoke trusted
 * devices (and trigger their rekey jobs) before finalizing removal.
 */
export async function removeIdentityFromCircle(params: {
  familyId: string;
  identityId: IdentityId;
  removedByIdentityId: IdentityId;
}) {
  return transaction(async (client) => {
    const identityResult = await client.query<RemovableIdentityRow>(
      `SELECT identity_id, role, status
         FROM identities
        WHERE family_id = $1
          AND identity_id = $2
        FOR UPDATE`,
      [params.familyId, params.identityId]
    );
    const identity = identityResult.rows[0];
    if (!identity) {
      throw new AdminIdentityRemovalError(404, 'NOT_FOUND', 'User not found');
    }
    if (identity.role === 'owner') {
      throw new AdminIdentityRemovalError(403, 'FORBIDDEN', 'Cannot remove the Circle owner');
    }
    if (identity.status === 'removed') {
      throw new AdminIdentityRemovalError(409, 'INVALID_STATE', 'User is already removed');
    }
    if (identity.status !== 'disabled') {
      throw new AdminIdentityRemovalError(409, 'INVALID_STATE', 'Block the user before removing them');
    }

    const activeDevicesResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM devices
        WHERE family_id = $1
          AND identity_id = $2
          AND status = 'active'`,
      [params.familyId, params.identityId]
    );
    const activeDeviceCount = Number(activeDevicesResult.rows[0]?.count || 0);
    if (activeDeviceCount > 0) {
      throw new AdminIdentityRemovalError(
        409,
        'INVALID_STATE',
        'Revoke every active device before removing the user'
      );
    }

    // Keep shared groups manageable: transfer ownership to the earliest
    // remaining participant, then end the removed identity's memberships.
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
        WHERE chat.family_id = $1
          AND chat.owner_identity_id = $2
          AND EXISTS (
                SELECT 1
                  FROM group_chat_participants AS participant
                 WHERE participant.family_id = chat.family_id
                   AND participant.chat_id = chat.chat_id
                   AND participant.identity_id <> $2
                   AND participant.is_active = TRUE
              )`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `UPDATE group_chat_participants
          SET is_active = FALSE,
              left_at = COALESCE(left_at, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
        WHERE family_id = $1
          AND identity_id = $2
          AND is_active = TRUE`,
      [params.familyId, params.identityId]
    );

    // Active resources that require the former member to operate them are
    // retired but retained for audit/history.
    await client.query(
      `UPDATE call_links
          SET status = 'revoked'
        WHERE family_id = $1
          AND (target_identity_id = $2 OR created_by = $2)
          AND status = 'active'`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `UPDATE direct_guest_links
          SET status = 'revoked',
              revoked_at = COALESCE(revoked_at, NOW()),
              updated_at = NOW(),
              public_site_visible = FALSE
        WHERE family_id = $1
          AND (host_identity_id = $2 OR created_by_identity_id = $2)
          AND status = 'active'`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `UPDATE direct_guest_registrations
          SET status = 'revoked',
              revoked_at = COALESCE(revoked_at, NOW()),
              updated_at = NOW()
        WHERE family_id = $1
          AND (host_identity_id = $2 OR guest_identity_id = $2)
          AND status = 'active'`,
      [params.familyId, params.identityId]
    );
    await client.query(
      `UPDATE announcement_channels
          SET status = 'archived',
              archived_at = COALESCE(archived_at, NOW()),
              updated_at = NOW(),
              public_site_state = 'hidden',
              public_site_visible = FALSE
        WHERE family_id = $1
          AND owner_identity_id = $2
          AND status = 'active'`,
      [params.familyId, params.identityId]
    );

    const removedResult = await client.query<{
      identity_id: string;
      status: string;
      removed_at: Date;
      removed_by_identity_id: string;
    }>(
      `UPDATE identities
          SET status = 'removed',
              publish_identity = FALSE,
              presence_visible = FALSE,
              removed_at = NOW(),
              removed_by_identity_id = $3
        WHERE family_id = $1
          AND identity_id = $2
          AND status = 'disabled'
      RETURNING identity_id, status, removed_at, removed_by_identity_id`,
      [params.familyId, params.identityId, params.removedByIdentityId]
    );

    // Temporary access does not have a trusted-device rekey obligation. It is
    // ended atomically with membership removal.
    await client.query(
      `UPDATE temporary_devices
          SET status = 'revoked'
        WHERE family_id = $1
          AND identity_id = $2
          AND status = 'active'`,
      [params.familyId, params.identityId]
    );

    // Invitations from a former member must not remain usable even though the
    // identity row itself is retained for history.
    await client.query(
      `UPDATE invites
          SET status = 'revoked'
        WHERE family_id = $1
          AND created_by = $2
          AND status = 'active'`,
      [params.familyId, params.identityId]
    );

    return removedResult.rows[0];
  });
}
