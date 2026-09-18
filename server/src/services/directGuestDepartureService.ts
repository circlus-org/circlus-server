import type { IdentityId, PublicKey, SystemEventRecord } from '@shared/types';
import { matchesDirectGuestDeparture, type DirectGuestDeparture } from '../../../shared/directGuestDeparture';
import { pool, transaction, inTransactionContext } from '../db';
import { identityRepository, systemEventRepository } from '../db/repositories';
import type { DirectGuestRegistrationRecord } from '../db/repositories/directGuestRegistrationRepository';
import { configService } from './configService';
import { verifySignedRequest } from '../utils/crypto';

export class DirectGuestDepartureError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function commitDirectGuestDeparture(params: {
  familyId: string; guestIdentityId: string; departure?: DirectGuestDeparture;
}): Promise<{ registration: DirectGuestRegistrationRecord; event: SystemEventRecord<'direct-guest:departed'> | null; guestEvent: SystemEventRecord<'direct-guest:departed'> | null }> {
  return transaction((client) => inTransactionContext(client, async () => {
    const rows = await pool.query<DirectGuestRegistrationRecord>(
      `SELECT * FROM direct_guest_registrations WHERE family_id = $1 AND guest_identity_id = $2
        AND status IN ('active', 'deleted_by_guest') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [params.familyId, params.guestIdentityId],
    );
    const registration = rows.rows[0];
    if (!registration) throw new DirectGuestDepartureError(404, 'NOT_FOUND', 'Direct guest registration not found');
    const [identity, config] = await Promise.all([
      identityRepository.findByIdentityId(params.familyId, params.guestIdentityId as IdentityId),
      configService.getFamilyConfig(params.familyId),
    ]);
    const key = identity ? { algorithm: identity.public_key_algorithm, value: identity.public_key_value } as PublicKey : null;
    const origin = config?.public_base_url ? new URL(config.public_base_url).origin : '';
    const proof = params.departure;
    if (!key || !proof || !matchesDirectGuestDeparture(proof, {
      circleOrigin: origin, registrationId: registration.registration_id, linkId: registration.link_id,
      hostIdentityId: registration.host_identity_id, guestIdentityId: registration.guest_identity_id,
    }) || !verifySignedRequest(proof, key)) {
      throw new DirectGuestDepartureError(400, 'INVALID_SIGNATURE', 'A valid guest identity signature is required to withdraw guest access');
    }
    // A retry cannot overwrite the first proof or create a duplicate notification.
    if (registration.status === 'deleted_by_guest') return { registration, event: null, guestEvent: null };
    const updated = await pool.query<DirectGuestRegistrationRecord>(
      `UPDATE direct_guest_registrations SET status = 'deleted_by_guest', revoked_at = NOW(), updated_at = NOW(), departure_proof = $3::jsonb
       WHERE family_id = $1 AND registration_id = $2 RETURNING *`,
      [params.familyId, registration.registration_id, JSON.stringify(proof)],
    );
    const event: SystemEventRecord<'direct-guest:departed'> = {
      eventId: systemEventRepository.createEventId(), circleId: config!.circle_id,
      recipientIdentityId: registration.host_identity_id as IdentityId, type: 'direct-guest:departed',
      payload: { departure: proof, guestIdentityPublicKey: key }, serverTimestamp: Date.now(),
    };
    await systemEventRepository.insertEvent({
      ...event, familyId: params.familyId, createdAt: event.serverTimestamp,
    });
    const guestEvent = { ...event, eventId: systemEventRepository.createEventId(), recipientIdentityId: params.guestIdentityId };
    await systemEventRepository.insertEvent({ ...guestEvent, familyId: params.familyId, createdAt: guestEvent.serverTimestamp });
    return { registration: updated.rows[0], event, guestEvent };
  }));
}
