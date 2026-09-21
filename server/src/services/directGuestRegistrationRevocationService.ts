import { matchesDirectGuestRevocation, type DirectGuestRevocation } from '../../../shared/directGuestRevocation';
import { verifySignedRequest } from '../utils/crypto';
import type { PublicKey } from '@shared/types';
import { pool } from '../db';
import type { IdentityId, SystemEventRecord } from '@shared/types';
import { configService } from './configService';
import { transaction, inTransactionContext } from '../db';
import {
  identityRepository,
  systemEventRepository,
  announcementChannelRepository,
  directGuestRegistrationRepository
} from '../db/repositories';

export class DirectGuestRegistrationRevocationError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'INVALID_REQUEST' | 'NOT_FOUND',
    message: string
  ) {
    super(message);
  }
}

export async function revokeDirectGuestRegistration(params: {
  familyId: string;
  registrationId: string;
  hostIdentityId: string;
  removeFromChannelIds: string[];
  revocation?: DirectGuestRevocation;
}) {
  const outcome = await transaction(async (client) => inTransactionContext(client, async () => {
    const existing = await directGuestRegistrationRepository.findActiveByHostForUpdate(
      params.familyId,
      params.registrationId,
      params.hostIdentityId,
      client
    );
    if (!existing) return { kind: 'not_found' as const };

    const config = await configService.getFamilyConfig(params.familyId);
    if (!config?.public_base_url) throw new Error('Circle origin is not configured');
    const circleOrigin = new URL(config.public_base_url).origin;
    const host = await identityRepository.findByIdentityId(params.familyId, params.hostIdentityId as IdentityId);
    const hostIdentityPublicKey = host ? { algorithm: host.public_key_algorithm, value: host.public_key_value } as PublicKey : null;
    const revocation = params.revocation;
    if (!hostIdentityPublicKey || !revocation || !matchesDirectGuestRevocation(revocation, {
      circleOrigin, registrationId: params.registrationId, linkId: existing.link_id,
      hostIdentityId: params.hostIdentityId, guestIdentityId: existing.guest_identity_id,
    }) || !verifySignedRequest(revocation, hostIdentityPublicKey)) {
      throw new DirectGuestRegistrationRevocationError(400, 'INVALID_REQUEST', 'A valid host identity signature is required to revoke guest access');
    }

    const impacts = await announcementChannelRepository.listOwnedActiveSubscriptionsForGuest({
      familyId: params.familyId,
      ownerIdentityId: params.hostIdentityId,
      guestIdentityId: existing.guest_identity_id
    }, client);
    const impactsByChannelId = new Map(impacts.map((impact) => [impact.channel_id, impact]));
    if (params.removeFromChannelIds.some((channelId) => !impactsByChannelId.has(channelId))) {
      return { kind: 'invalid_channels' as const };
    }

    const revoked = await directGuestRegistrationRepository.revokeByHost(
      params.familyId,
      params.registrationId,
      params.hostIdentityId,
      client
    );
    if (!revoked) return { kind: 'not_found' as const };

    await pool.query('UPDATE direct_guest_registrations SET revocation_proof = $3::jsonb WHERE family_id = $1 AND registration_id = $2',
      [params.familyId, params.registrationId, JSON.stringify(revocation)]);

    const removedChannels: Array<{ channelId: string; keyEpoch: number }> = [];
    for (const channelId of params.removeFromChannelIds) {
      const removed = await announcementChannelRepository.removeSubscriberByAuthor({
        familyId: params.familyId,
        channelId,
        ownerIdentityId: params.hostIdentityId,
        subscriberIdentityId: existing.guest_identity_id
      }, client);
      const impact = impactsByChannelId.get(channelId);
      if (removed && impact) {
        removedChannels.push({
          channelId,
          keyEpoch: Number(impact.key_epoch || 1)
        });
      }
    }
    const event: SystemEventRecord<'direct-guest:revoked'> = {
      eventId: systemEventRepository.createEventId(),
      circleId: config.circle_id,
      recipientIdentityId: existing.guest_identity_id as IdentityId,
      type: 'direct-guest:revoked', serverTimestamp: Date.now(),
      payload: { revocation, hostIdentityPublicKey },
    };
    await systemEventRepository.insertEvent({ ...event, familyId: params.familyId, createdAt: event.serverTimestamp });
    return { kind: 'revoked' as const, revoked, removedChannels, event };
  }));

  if (outcome.kind === 'invalid_channels') {
    throw new DirectGuestRegistrationRevocationError(
      400,
      'INVALID_REQUEST',
      'A selected channel subscription is not active'
    );
  }
  if (outcome.kind === 'not_found') {
    throw new DirectGuestRegistrationRevocationError(
      404,
      'NOT_FOUND',
      'Direct guest registration not found'
    );
  }
  return outcome;
}
