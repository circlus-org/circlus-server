import { transaction } from '../db';
import { announcementChannelRepository } from '../db/repositories';

export class DirectGuestBulkAccessError extends Error {
  constructor(readonly status: 404, message: string) {
    super(message);
  }
}

export async function endDirectGuestAccessByLink(params: {
  familyId: string;
  linkId: string;
  hostIdentityId: string;
}) {
  const outcome = await transaction(async (client) => {
    const linkResult = await client.query<{ link_id: string }>(
      `SELECT link_id
         FROM direct_guest_links
        WHERE family_id = $1 AND link_id = $2 AND host_identity_id = $3
        FOR UPDATE`,
      [params.familyId, params.linkId, params.hostIdentityId]
    );
    if (!linkResult.rows[0]) return null;

    const registrations = await client.query<{
      registration_id: string;
      guest_identity_id: string;
    }>(
      `SELECT registration_id, guest_identity_id
         FROM direct_guest_registrations
        WHERE family_id = $1 AND link_id = $2 AND host_identity_id = $3 AND status = 'active'
        FOR UPDATE`,
      [params.familyId, params.linkId, params.hostIdentityId]
    );

    const removedChannels = new Map<string, { channelId: string; title: string; keyEpoch: number }>();
    for (const registration of registrations.rows) {
      const impacts = await announcementChannelRepository.listOwnedActiveSubscriptionsForGuest({
        familyId: params.familyId,
        ownerIdentityId: params.hostIdentityId,
        guestIdentityId: registration.guest_identity_id
      }, client);
      for (const impact of impacts) {
        const removed = await announcementChannelRepository.removeSubscriberByAuthor({
          familyId: params.familyId,
          channelId: impact.channel_id,
          ownerIdentityId: params.hostIdentityId,
          subscriberIdentityId: registration.guest_identity_id
        }, client);
        if (removed) {
          removedChannels.set(impact.channel_id, {
            channelId: impact.channel_id,
            title: impact.title,
            keyEpoch: Number(impact.key_epoch || 1)
          });
        }
      }
    }

    await client.query(
      `UPDATE direct_guest_registrations
          SET status = 'deleted_by_host', revoked_at = NOW(), updated_at = NOW()
        WHERE family_id = $1 AND link_id = $2 AND host_identity_id = $3 AND status = 'active'`,
      [params.familyId, params.linkId, params.hostIdentityId]
    );

    return {
      removedCount: registrations.rows.length,
      removedChannels: [...removedChannels.values()]
    };
  });
  if (!outcome) throw new DirectGuestBulkAccessError(404, 'Direct guest link not found');
  return outcome;
}
