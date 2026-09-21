import { pool } from '../index';

export type CircleOwnerGuestTreeRow = {
  registration_id: string;
  link_id: string;
  host_identity_id: string;
  guest_identity_id: string;
  guest_public_key_algorithm: 'ed25519' | 'x25519';
  guest_public_key_value: string;
  guest_status: 'active' | 'disabled' | 'removed';
  registration_status: 'active' | 'revoked' | 'deleted_by_guest' | 'deleted_by_host' | 'promoted';
  can_create_guest_invites: boolean;
  can_message: boolean;
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_server_attachments: boolean;
  host_can_message_guest: boolean;
  guest_can_message_host: boolean;
  host_can_call_guest: boolean;
  guest_can_call_host: boolean;
  host_can_direct_file_transfer_guest: boolean;
  guest_can_direct_file_transfer_host: boolean;
  host_can_server_attachments_guest: boolean;
  guest_can_server_attachments_host: boolean;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date | null;
  active_device_count: number;
  revoked_device_count: number;
  active_child_guest_count: number;
};

export class CircleOwnerGuestTreeRepository {
  async listChildren(params: {
    familyId: string;
    hostIdentityId: string;
    afterRegistrationId: string | null;
    limit: number;
    includeInactive: boolean;
  }): Promise<CircleOwnerGuestTreeRow[]> {
    const result = await pool.query<CircleOwnerGuestTreeRow>(
      `SELECT registration.registration_id,
              registration.link_id,
              registration.host_identity_id,
              registration.guest_identity_id,
              guest.public_key_algorithm AS guest_public_key_algorithm,
              guest.public_key_value AS guest_public_key_value,
              guest.status AS guest_status,
              registration.status AS registration_status,
              guest.can_create_guest_invites,
              registration.can_message,
              registration.can_call,
              registration.can_direct_file_transfer,
              registration.can_server_attachments,
              registration.host_can_message_guest,
              registration.guest_can_message_host,
              registration.host_can_call_guest,
              registration.guest_can_call_host,
              registration.host_can_direct_file_transfer_guest,
              registration.guest_can_direct_file_transfer_host,
              registration.host_can_server_attachments_guest,
              registration.guest_can_server_attachments_host,
              registration.created_at,
              registration.updated_at,
              registration.revoked_at,
              device_summary.last_seen_at,
              device_summary.active_device_count,
              device_summary.revoked_device_count,
              COALESCE(child_summary.active_child_guest_count, 0)::int AS active_child_guest_count
         FROM direct_guest_registrations registration
         JOIN identities guest
           ON guest.family_id = registration.family_id
          AND guest.identity_id = registration.guest_identity_id
         LEFT JOIN LATERAL (
           SELECT MAX(COALESCE(device.last_seen_at, device.created_at)) AS last_seen_at,
                  COUNT(*) FILTER (WHERE device.status = 'active')::int AS active_device_count,
                  COUNT(*) FILTER (WHERE device.status = 'revoked')::int AS revoked_device_count
             FROM devices device
            WHERE device.family_id = registration.family_id
              AND device.identity_id = registration.guest_identity_id
         ) device_summary ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT child.guest_identity_id)::int AS active_child_guest_count
             FROM direct_guest_registrations child
            WHERE child.family_id = registration.family_id
              AND child.host_identity_id = registration.guest_identity_id
              AND child.status = 'active'
         ) child_summary ON TRUE
        WHERE registration.family_id = $1
          AND registration.host_identity_id = $2
          AND ($3::boolean = TRUE OR (
            registration.status = 'active'
            AND guest.status = 'active'
          ))
          AND ($4::text IS NULL OR registration.registration_id > $4)
        ORDER BY registration.registration_id ASC
        LIMIT $5`,
      [
        params.familyId,
        params.hostIdentityId,
        params.includeInactive,
        params.afterRegistrationId,
        params.limit + 1,
      ]
    );
    return result.rows;
  }
}

export const circleOwnerGuestTreeRepository = new CircleOwnerGuestTreeRepository();
