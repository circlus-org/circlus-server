import { transaction } from '../index';
import { nanoid } from 'nanoid';
import type { FindByIdentityIdResult } from './identityRepository.queries';
import type { FindByDeviceIdResult } from './deviceRepository.queries';
import type { DirectGuestRegistrationRecord, DirectGuestRegistrationStatus } from './directGuestRegistrationRepository';
import type { CreateDirectGuestRegistrationParams } from './directGuestRegistrationRepository.queries';
import { createDirectGuestRegistration } from './directGuestRegistrationRepository.queries';
import type { DirectGuestAcceptance, LinkCapabilityProof } from '../../../../shared/linkCapability';
import type { ChannelSubscriptionAcceptance, DeviceRegistrationAttestation } from '../../../../shared/types';

export type DirectGuestPublicResult = {
  identity: FindByIdentityIdResult;
  device: FindByDeviceIdResult;
  registration: DirectGuestRegistrationRecord;
};

export class DirectGuestHostUnavailableError extends Error {
  constructor() {
    super('Direct guest link host is unavailable');
    this.name = 'DirectGuestHostUnavailableError';
  }
}

export class DirectGuestPublicRepository {
  async findExistingGuestIdentityDeviceAndRegistration(params: {
    familyId: string;
    linkId: string;
    identityId: string;
    deviceId: string;
  }): Promise<DirectGuestPublicResult | null> {
    const registrationResult = await transaction(async (client) => {
      const registrationQuery = await client.query<DirectGuestRegistrationRecord>(
        `SELECT *
         FROM direct_guest_registrations
         WHERE family_id = $1
           AND link_id = $2
           AND guest_identity_id = $3
           AND status = 'active'
         LIMIT 1`,
        [params.familyId, params.linkId, params.identityId]
      );
      const registration = registrationQuery.rows[0];
      if (!registration) return null;

      const [identityQuery, deviceQuery] = await Promise.all([
        client.query<FindByIdentityIdResult>(
          `SELECT *
           FROM identities
           WHERE family_id = $1 AND identity_id = $2
           LIMIT 1`,
          [params.familyId, params.identityId]
        ),
        client.query<FindByDeviceIdResult>(
          `SELECT *
           FROM devices
           WHERE family_id = $1 AND device_id = $2 AND identity_id = $3 AND status = 'active'
           LIMIT 1`,
          [params.familyId, params.deviceId, params.identityId]
        )
      ]);
      const identity = identityQuery.rows[0];
      const device = deviceQuery.rows[0];
      if (!identity || !device) return null;
      return { identity, device, registration };
    });
    return registrationResult;
  }

  async createGuestIdentityDeviceAndRegistration(params: {
    familyId: string;
    identityId: string;
    deviceId: string;
    registrationId: string;
    identityPublicKey: { algorithm: string; value: string };
    encryptedIdentityPrivateKey: unknown;
    devicePublicKey: { algorithm: string; value: string };
    deviceEncryptionPublicKey?: { algorithm: string; value: string } | null;
    registrationAttestation: DeviceRegistrationAttestation;
    webOrigin?: string | null;
    encryptedPhysicalDeviceId?: unknown | null;
    capabilityId?: string | null;
    admissionClaim?: {
      capabilityProof: LinkCapabilityProof;
      subjectAcceptance: DirectGuestAcceptance;
    } | null;
    channelSubscriptionClaim?: ChannelSubscriptionAcceptance | null;
    link: {
      link_id: string;
      host_identity_id: string;
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
      auto_subscribe_to_channel?: boolean;
      capability_mode?: 'single-use' | 'unlimited' | null;
      expires_at?: Date | null;
    };
  }): Promise<DirectGuestPublicResult> {
    return transaction(async (client) => {
      const lockedLink = await client.query<{
        status: string;
        capability_mode: 'single-use' | 'unlimited' | null;
        expires_at: Date | null;
      }>(
        `SELECT status, capability_mode, expires_at
           FROM direct_guest_links
          WHERE family_id = $1 AND link_id = $2
          FOR UPDATE`,
        [params.familyId, params.link.link_id]
      );
      const currentLink = lockedLink.rows[0];
      if (!currentLink || currentLink.status !== 'active' || (currentLink.expires_at && currentLink.expires_at.getTime() <= Date.now())) {
        throw new DirectGuestHostUnavailableError();
      }
      if (currentLink.capability_mode === 'single-use') {
        const priorUse = await client.query(
          `SELECT 1 FROM direct_guest_registrations
            WHERE family_id = $1 AND link_id = $2
            LIMIT 1`,
          [params.familyId, params.link.link_id]
        );
        if ((priorUse.rowCount || 0) > 0) throw new DirectGuestHostUnavailableError();
      }
      const hostResult = await client.query<{ status: string }>(
        `SELECT status
         FROM identities
         WHERE family_id = $1 AND identity_id = $2
         LIMIT 1
         FOR SHARE`,
        [params.familyId, params.link.host_identity_id]
      );
      if (hostResult.rows[0]?.status !== 'active') {
        throw new DirectGuestHostUnavailableError();
      }

      const identityInsert = await client.query<FindByIdentityIdResult>(
        `INSERT INTO identities
          (identity_id, family_id, public_key_algorithm, public_key_value, encrypted_private_key, role, publish_identity, identity_name,
           admission_capability_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,'guest',FALSE,$6,$7)
         RETURNING *`,
        [
          params.identityId,
          params.familyId,
          params.identityPublicKey.algorithm,
          params.identityPublicKey.value,
          JSON.stringify(params.encryptedIdentityPrivateKey),
          null,
          params.capabilityId || null
        ]
      );
      const identity = identityInsert.rows[0];

      const deviceInsert = await client.query<FindByDeviceIdResult>(
        `INSERT INTO devices
          (device_id, family_id, identity_id, public_key_algorithm, public_key_value, encryption_public_key_algorithm, encryption_public_key_value, registration_attestation, web_origin, encrypted_physical_device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)
         RETURNING *`,
        [
          params.deviceId,
          params.familyId,
          identity.identity_id,
          params.devicePublicKey.algorithm,
          params.devicePublicKey.value,
          params.deviceEncryptionPublicKey?.algorithm || null,
          params.deviceEncryptionPublicKey?.value || null,
          JSON.stringify(params.registrationAttestation),
          params.webOrigin || null,
          params.encryptedPhysicalDeviceId ? JSON.stringify(params.encryptedPhysicalDeviceId) : null
        ]
      );
      const device = deviceInsert.rows[0];

      const registrationParams: CreateDirectGuestRegistrationParams = {
        registrationId: params.registrationId,
        familyId: params.familyId,
        linkId: params.link.link_id,
        hostIdentityId: params.link.host_identity_id,
        guestIdentityId: identity.identity_id,
        canMessage: params.link.can_message,
        canCall: params.link.can_call,
        canDirectFileTransfer: params.link.can_direct_file_transfer,
        canServerAttachments: params.link.can_server_attachments ?? params.link.can_direct_file_transfer,
        hostCanMessageGuest: true,
        guestCanMessageHost: params.link.guest_can_message_host ?? params.link.can_message,
        hostCanCallGuest: true,
        guestCanCallHost: params.link.guest_can_call_host ?? params.link.can_call,
        hostCanDirectFileTransferGuest: true,
        guestCanDirectFileTransferHost: params.link.guest_can_direct_file_transfer_host ?? params.link.can_direct_file_transfer,
        hostCanServerAttachmentsGuest: true,
        guestCanServerAttachmentsHost: params.link.guest_can_server_attachments_host ?? params.link.can_server_attachments ?? params.link.can_direct_file_transfer,
      };
      const [registrationRow] = await createDirectGuestRegistration.run(registrationParams, client);
      if (params.capabilityId && params.admissionClaim) {
        await client.query(
          `UPDATE direct_guest_registrations
           SET capability_id = $1, admission_claim = $2::jsonb
           WHERE family_id = $3 AND registration_id = $4`,
          [params.capabilityId, JSON.stringify(params.admissionClaim), params.familyId, params.registrationId]
        );
      }
      const registration: DirectGuestRegistrationRecord = {
        ...registrationRow,
        status: registrationRow.status as DirectGuestRegistrationStatus,
      };
      if (currentLink.capability_mode === 'single-use') {
        await client.query(
          `UPDATE direct_guest_links
              SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
            WHERE family_id = $1 AND link_id = $2`,
          [params.familyId, params.link.link_id]
        );
      }

      // Channel acquisition is independent from direct-chat permissions. Both
      // the explicit auto-subscribe flag and a channel association are needed.
      await client.query(
        `INSERT INTO announcement_channel_subscriptions (
           subscription_id,
           family_id,
           channel_id,
           subscriber_identity_id,
           source_link_id,
           notifications_enabled,
           status,
           subscription_claim
         )
         SELECT $1, acl.family_id, acl.channel_id, $2, acl.link_id, TRUE, 'active', $6::jsonb
           FROM announcement_channel_links acl
          WHERE acl.family_id = $3
            AND acl.link_id = $4
            AND $5 = TRUE
         ON CONFLICT (family_id, channel_id, subscriber_identity_id) DO UPDATE
         SET status = 'active',
             notifications_enabled = TRUE,
             source_link_id = COALESCE(
               announcement_channel_subscriptions.source_link_id,
               EXCLUDED.source_link_id
             ),
             subscription_claim = EXCLUDED.subscription_claim,
             updated_at = NOW(),
             unsubscribed_at = NULL`,
        [
          `acs_${nanoid(22)}`,
          identity.identity_id,
          params.familyId,
          params.link.link_id,
          params.link.auto_subscribe_to_channel,
          params.channelSubscriptionClaim ? JSON.stringify(params.channelSubscriptionClaim) : null,
        ]
      );

      return { identity, device, registration };
    });
  }
}

export const directGuestPublicRepository = new DirectGuestPublicRepository();
