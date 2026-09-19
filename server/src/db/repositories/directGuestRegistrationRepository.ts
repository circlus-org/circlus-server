import { pool } from '../index';
import type { PoolClient } from 'pg';
import type { DirectGuestAcceptance, LinkCapabilityProof } from '../../../../shared/linkCapability';
import type {
  CreateDirectGuestRegistrationParams,
  ListDirectGuestRegistrationsByLinkResult,
  FindActiveDirectGuestRegistrationByPairResult,
  FindActiveDirectGuestRegistrationByHostResult,
  UpdateDirectGuestRegistrationPermissionsByHostParams,
} from './directGuestRegistrationRepository.queries';
import {
  createDirectGuestRegistration,
  listDirectGuestRegistrationsByLink,
  findActiveDirectGuestRegistrationByPair,
  findActiveDirectGuestRegistrationByHost,
  revokeDirectGuestRegistrationByHost,
  updateDirectGuestRegistrationPermissionsByHost,
  selfDeleteDirectGuestRegistration,
  touchDirectGuestRegistrationLastSeen,
  revokeAllDirectGuestRegistrationsByLink,
} from './directGuestRegistrationRepository.queries';

export type DirectGuestRegistrationStatus = 'active' | 'revoked' | 'deleted_by_guest' | 'deleted_by_host' | 'promoted';

export type DirectGuestRegistrationPermissionFlags = {
  can_message: boolean;
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_server_attachments?: boolean;
  host_can_message_guest?: boolean;
  guest_can_message_host?: boolean;
  host_can_call_guest?: boolean;
  guest_can_call_host?: boolean;
  host_can_direct_file_transfer_guest?: boolean;
  guest_can_direct_file_transfer_host?: boolean;
  host_can_server_attachments_guest?: boolean;
  guest_can_server_attachments_host?: boolean;
};

export type DirectGuestRegistrationRecord = DirectGuestRegistrationPermissionFlags & {
  registration_id: string;
  family_id: string;
  link_id: string;
  host_identity_id: string;
  guest_identity_id: string;
  status: DirectGuestRegistrationStatus;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date | null;
  capability_id?: string | null;
  revocation_proof?: import('../../../../shared/directGuestRevocation').DirectGuestRevocation | null;
  host_public_key_algorithm?: 'ed25519' | 'x25519' | null;
  host_public_key_value?: string | null;
  departure_proof?: import('../../../../shared/directGuestDeparture').DirectGuestDeparture | null;
  admission_claim?: {
    capabilityProof: LinkCapabilityProof;
    subjectAcceptance: DirectGuestAcceptance;
  } | null;
};

export type DirectGuestRegistrationListRecord = DirectGuestRegistrationRecord & {
  guest_identity_name: string | null;
  guest_public_key_algorithm: 'ed25519' | 'x25519' | null;
  guest_public_key_value: string | null;
};

function mapDirectGuestRegistration(
  row: FindActiveDirectGuestRegistrationByPairResult | FindActiveDirectGuestRegistrationByHostResult
): DirectGuestRegistrationRecord {
  return {
    ...row,
    status: row.status as DirectGuestRegistrationStatus,
  };
}

function mapDirectGuestRegistrationListRow(
  row: ListDirectGuestRegistrationsByLinkResult
): DirectGuestRegistrationListRecord {
  return {
    ...mapDirectGuestRegistration(row),
    guest_identity_name: row.guest_identity_name,
    guest_public_key_algorithm: row.guest_public_key_algorithm as DirectGuestRegistrationListRecord['guest_public_key_algorithm'],
    guest_public_key_value: row.guest_public_key_value,
  };
}

export class DirectGuestRegistrationRepository {
  async create(input: {
    registrationId: string;
    familyId: string;
    linkId: string;
    hostIdentityId: string;
    guestIdentityId: string;
    canMessage: boolean;
    canCall: boolean;
    canDirectFileTransfer: boolean;
    canServerAttachments: boolean;
    hostCanMessageGuest: boolean;
    guestCanMessageHost: boolean;
    hostCanCallGuest: boolean;
    guestCanCallHost: boolean;
    hostCanDirectFileTransferGuest: boolean;
    guestCanDirectFileTransferHost: boolean;
    hostCanServerAttachmentsGuest: boolean;
    guestCanServerAttachmentsHost: boolean;
  }): Promise<DirectGuestRegistrationRecord> {
    const params: CreateDirectGuestRegistrationParams = {
      registrationId: input.registrationId,
      familyId: input.familyId,
      linkId: input.linkId,
      hostIdentityId: input.hostIdentityId,
      guestIdentityId: input.guestIdentityId,
      canMessage: input.canMessage,
      canCall: input.canCall,
      canDirectFileTransfer: input.canDirectFileTransfer,
      canServerAttachments: input.canServerAttachments,
      hostCanMessageGuest: input.hostCanMessageGuest,
      guestCanMessageHost: input.guestCanMessageHost,
      hostCanCallGuest: input.hostCanCallGuest,
      guestCanCallHost: input.guestCanCallHost,
      hostCanDirectFileTransferGuest: input.hostCanDirectFileTransferGuest,
      guestCanDirectFileTransferHost: input.guestCanDirectFileTransferHost,
      hostCanServerAttachmentsGuest: input.hostCanServerAttachmentsGuest,
      guestCanServerAttachmentsHost: input.guestCanServerAttachmentsHost,
    };
    const results = await createDirectGuestRegistration.run(params, pool);
    return mapDirectGuestRegistration(results[0]);
  }

  async listByLink(
    familyId: string,
    linkId: string,
    hostIdentityId: string
  ): Promise<DirectGuestRegistrationListRecord[]> {
    const results = await listDirectGuestRegistrationsByLink.run({ familyId, linkId, hostIdentityId }, pool);
    return results.map(mapDirectGuestRegistrationListRow);
  }

  async listByHost(
    familyId: string,
    hostIdentityId: string,
    linkIds: string[] | null = null
  ): Promise<DirectGuestRegistrationListRecord[]> {
    const result = await pool.query<DirectGuestRegistrationListRecord>(
      `SELECT registration.*,
              identity.identity_name AS guest_identity_name,
              identity.public_key_algorithm AS guest_public_key_algorithm,
              identity.public_key_value AS guest_public_key_value
         FROM direct_guest_registrations registration
         JOIN direct_guest_links link
           ON link.family_id = registration.family_id
          AND link.link_id = registration.link_id
          AND link.host_identity_id = registration.host_identity_id
         LEFT JOIN identities identity
           ON identity.family_id = registration.family_id
          AND identity.identity_id = registration.guest_identity_id
        WHERE registration.family_id = $1
          AND registration.host_identity_id = $2
          AND ($3::text[] IS NULL OR registration.link_id = ANY($3::text[]))
        ORDER BY registration.created_at DESC`,
      [familyId, hostIdentityId, linkIds]
    );
    return result.rows.map((row) => ({
      ...row,
      status: row.status as DirectGuestRegistrationStatus,
      guest_public_key_algorithm: row.guest_public_key_algorithm as DirectGuestRegistrationListRecord['guest_public_key_algorithm'],
    }));
  }

  async findLatestByPair(familyId: string, identityA: string, identityB: string): Promise<DirectGuestRegistrationListRecord | null> {
    const result = await pool.query<DirectGuestRegistrationListRecord>(
      `SELECT r.*, i.public_key_algorithm AS guest_public_key_algorithm, i.public_key_value AS guest_public_key_value,
              i.identity_name AS guest_identity_name, h.public_key_algorithm AS host_public_key_algorithm, h.public_key_value AS host_public_key_value
       FROM direct_guest_registrations r LEFT JOIN identities i ON i.family_id = r.family_id AND i.identity_id = r.guest_identity_id
       LEFT JOIN identities h ON h.family_id = r.family_id AND h.identity_id = r.host_identity_id
       WHERE r.family_id = $1 AND ((r.host_identity_id = $2 AND r.guest_identity_id = $3) OR (r.host_identity_id = $3 AND r.guest_identity_id = $2))
       ORDER BY r.created_at DESC LIMIT 1`, [familyId, identityA, identityB]);
    return result.rows[0] || null;
  }

  async findActiveByPair(
    familyId: string,
    identityA: string,
    identityB: string
  ): Promise<DirectGuestRegistrationRecord | null> {
    const results = await findActiveDirectGuestRegistrationByPair.run({ familyId, identityA, identityB }, pool);
    return results[0] ? mapDirectGuestRegistration(results[0]) : null;
  }

  async findActiveByHost(
    familyId: string,
    registrationId: string,
    hostIdentityId: string
  ): Promise<DirectGuestRegistrationRecord | null> {
    const results = await findActiveDirectGuestRegistrationByHost.run({ familyId, registrationId, hostIdentityId }, pool);
    return results[0] ? mapDirectGuestRegistration(results[0]) : null;
  }

  async findByHost(
    familyId: string,
    registrationId: string,
    hostIdentityId: string
  ): Promise<DirectGuestRegistrationRecord | null> {
    const result = await pool.query<DirectGuestRegistrationRecord>(
      `SELECT *
         FROM direct_guest_registrations
        WHERE family_id = $1
          AND registration_id = $2
          AND host_identity_id = $3
        LIMIT 1`,
      [familyId, registrationId, hostIdentityId]
    );
    const row = result.rows[0];
    return row ? { ...row, status: row.status as DirectGuestRegistrationStatus } : null;
  }

  async deleteInactiveByHost(
    familyId: string,
    registrationId: string,
    hostIdentityId: string
  ): Promise<DirectGuestRegistrationRecord | null> {
    const result = await pool.query<DirectGuestRegistrationRecord>(
      `WITH target AS (
         SELECT registration_id
           FROM direct_guest_registrations
          WHERE family_id = $1
            AND registration_id = $2
            AND host_identity_id = $3
            AND status <> 'active'
       ),
       detached_deliveries AS (
         UPDATE direct_guest_broadcast_deliveries delivery
            SET registration_id = NULL
           FROM target
          WHERE delivery.family_id = $1
            AND delivery.registration_id = target.registration_id
       )
       DELETE FROM direct_guest_registrations registration
       USING target
       WHERE registration.registration_id = target.registration_id
       RETURNING registration.*`,
      [familyId, registrationId, hostIdentityId]
    );
    const row = result.rows[0];
    return row ? { ...row, status: row.status as DirectGuestRegistrationStatus } : null;
  }

  async findActiveByHostForUpdate(
    familyId: string,
    registrationId: string,
    hostIdentityId: string,
    client: PoolClient
  ): Promise<DirectGuestRegistrationRecord | null> {
    const result = await client.query<DirectGuestRegistrationRecord>(
      `SELECT *
         FROM direct_guest_registrations
        WHERE family_id = $1
          AND registration_id = $2
          AND host_identity_id = $3
          AND status = 'active'
        FOR UPDATE`,
      [familyId, registrationId, hostIdentityId]
    );
    const row = result.rows[0];
    return row ? { ...row, status: row.status as DirectGuestRegistrationStatus } : null;
  }

  async revokeByHost(
    familyId: string,
    registrationId: string,
    hostIdentityId: string,
    client?: PoolClient
  ): Promise<DirectGuestRegistrationRecord | null> {
    const results = await revokeDirectGuestRegistrationByHost.run(
      { familyId, registrationId, hostIdentityId },
      client || pool
    );
    return results[0] ? mapDirectGuestRegistration(results[0]) : null;
  }

  async updatePermissionsByHost(input: {
    familyId: string;
    registrationId: string;
    hostIdentityId: string;
    canMessage: boolean;
    canCall: boolean;
    canDirectFileTransfer: boolean;
    canServerAttachments: boolean;
    hostCanMessageGuest: boolean;
    guestCanMessageHost: boolean;
    hostCanCallGuest: boolean;
    guestCanCallHost: boolean;
    hostCanDirectFileTransferGuest: boolean;
    guestCanDirectFileTransferHost: boolean;
    hostCanServerAttachmentsGuest: boolean;
    guestCanServerAttachmentsHost: boolean;
  }): Promise<DirectGuestRegistrationRecord | null> {
    const params: UpdateDirectGuestRegistrationPermissionsByHostParams = input;
    const results = await updateDirectGuestRegistrationPermissionsByHost.run(params, pool);
    return results[0] ? mapDirectGuestRegistration(results[0]) : null;
  }

  async selfDelete(familyId: string, guestIdentityId: string): Promise<DirectGuestRegistrationRecord | null> {
    const results = await selfDeleteDirectGuestRegistration.run({ familyId, guestIdentityId }, pool);
    return results[0] ? mapDirectGuestRegistration(results[0]) : null;
  }

  async touchLastSeen(familyId: string, guestIdentityId: string): Promise<void> {
    await touchDirectGuestRegistrationLastSeen.run({ familyId, guestIdentityId }, pool);
  }

  async revokeAllByLink(familyId: string, linkId: string, client?: PoolClient): Promise<void> {
    await revokeAllDirectGuestRegistrationsByLink.run({ familyId, linkId }, client || pool);
  }
}

export const directGuestRegistrationRepository = new DirectGuestRegistrationRepository();
