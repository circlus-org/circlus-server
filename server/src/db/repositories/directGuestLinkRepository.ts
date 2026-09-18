import { pool } from '../index';
import type { PoolClient } from 'pg';
import type { LinkCapabilityDescriptor, LinkCapabilityMode } from '../../../../shared/linkCapability';
import type { LinkCapabilityRevocation } from '../../../../shared/linkCapability';
import type {
  CreateDirectGuestLinkResult,
  FindDirectGuestLinkByIdResult,
  GetDirectGuestLinkDefaultsResult,
  ListDirectGuestLinksByHostIdentityResult,
  UpsertDirectGuestLinkDefaultsParams,
} from './directGuestLinkRepository.queries';
import {
  findDirectGuestLinkById,
  getDirectGuestLinkDefaults,
  listDirectGuestLinksByHostIdentity,
  revokeDirectGuestLink,
  revokeExhaustedDirectGuestLink,
  upsertDirectGuestLinkDefaults,
} from './directGuestLinkRepository.queries';

const CREATE_DIRECT_GUEST_LINK_SQL = `
  INSERT INTO direct_guest_links (
    link_id,
    family_id,
    host_identity_id,
    created_by_identity_id,
    secret_hash,
    encrypted_secret,
    can_message,
    can_call,
    can_direct_file_transfer,
    can_server_attachments,
    title,
    presentation_title,
    presentation_description,
    presentation_image_url,
    max_uses,
    host_can_message_guest,
    guest_can_message_host,
    host_can_call_guest,
    guest_can_call_host,
    host_can_direct_file_transfer_guest,
    guest_can_direct_file_transfer_host,
    host_can_server_attachments_guest,
    guest_can_server_attachments_host,
    auto_subscribe_to_channel,
    public_site_visible,
    public_site_channel_slug,
    public_site_cta_label,
    public_site_intro_title,
    public_site_intro_text,
    public_site_intro_image_url,
    public_site_guest_link_url,
    capability_id,
    capability_public_key,
    capability_mode,
    capability_descriptor,
    expires_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
    $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
    $31, $32, $33, $34, $35, $36
  )
  RETURNING *
`;

export type DirectGuestLinkStatus = 'active' | 'revoked';
export type DirectGuestPermissionFlags = {
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
};

export type DirectGuestLinkRecord = DirectGuestPermissionFlags & {
  link_id: string;
  family_id: string;
  host_identity_id: string;
  created_by_identity_id: string;
  secret_hash: string;
  encrypted_secret?: unknown | null;
  status: DirectGuestLinkStatus;
  title: string | null;
  presentation_title?: string | null;
  presentation_description?: string | null;
  presentation_image_url?: string | null;
  public_site_visible: boolean;
  public_site_channel_slug: string | null;
  public_site_cta_label: string | null;
  public_site_intro_title: string | null;
  public_site_intro_text: string | null;
  public_site_intro_image_url: string | null;
  public_site_guest_link_url: string | null;
  max_uses?: number | null;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
  capability_id?: string | null;
  capability_public_key?: string | null;
  capability_mode?: LinkCapabilityMode | null;
  capability_descriptor?: LinkCapabilityDescriptor | null;
  expires_at?: Date | null;
};

export type DirectGuestLinkPresentationRecord = {
  presentation_title: string | null;
  presentation_description: string | null;
  presentation_image_url: string | null;
};

export type DirectGuestLinkListRecord = DirectGuestLinkRecord & {
  registration_count: string;
  active_registration_count: string;
};

function mapDirectGuestLink(row: FindDirectGuestLinkByIdResult): DirectGuestLinkRecord {
  const withPresentation = row as unknown as {
    encrypted_secret?: unknown | null;
    presentation_title?: string | null;
    presentation_description?: string | null;
    presentation_image_url?: string | null;
  };
  return {
    ...row,
    encrypted_secret: withPresentation.encrypted_secret ?? null,
    presentation_title: withPresentation.presentation_title ?? null,
    presentation_description: withPresentation.presentation_description ?? null,
    presentation_image_url: withPresentation.presentation_image_url ?? null,
    public_site_visible: row.public_site_visible,
    public_site_channel_slug: row.public_site_channel_slug,
    public_site_cta_label: row.public_site_cta_label,
    public_site_intro_title: row.public_site_intro_title,
    public_site_intro_text: row.public_site_intro_text,
    public_site_intro_image_url: row.public_site_intro_image_url,
    public_site_guest_link_url: row.public_site_guest_link_url,
    status: row.status as DirectGuestLinkStatus,
  };
}

function mapDirectGuestLinkListRow(row: ListDirectGuestLinksByHostIdentityResult): DirectGuestLinkListRecord {
  return {
    ...mapDirectGuestLink(row),
    registration_count: row.registration_count ?? '0',
    active_registration_count: row.active_registration_count ?? '0',
  };
}

function mapDirectGuestLinkPresentationRow(
  row: GetDirectGuestLinkDefaultsResult
): DirectGuestLinkPresentationRecord {
  return {
    presentation_title: row.presentation_title,
    presentation_description: row.presentation_description,
    presentation_image_url: row.presentation_image_url,
  };
}

export class DirectGuestLinkRepository {
  async clearPresentationImageReferences(familyId: string, blobId: string): Promise<void> {
    const imageUrlSuffix = `%/api/direct-guest-links/presentation-images/${blobId}`;
    await pool.query(
      `UPDATE direct_guest_links
       SET presentation_image_url = NULL, updated_at = NOW()
       WHERE family_id = $1 AND presentation_image_url LIKE $2`,
      [familyId, imageUrlSuffix]
    );
    await pool.query(
      `UPDATE direct_guest_link_defaults
       SET presentation_image_url = NULL, updated_at = NOW()
       WHERE family_id = $1 AND presentation_image_url LIKE $2`,
      [familyId, imageUrlSuffix]
    );
  }

  async create(input: {
    linkId: string;
    familyId: string;
    hostIdentityId: string;
    createdByIdentityId: string;
    secretHash: string;
    encryptedSecret?: unknown | null;
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
    autoSubscribeToChannel: boolean;
    title?: string | null;
    presentationTitle?: string | null;
    presentationDescription?: string | null;
    presentationImageUrl?: string | null;
    maxUses?: number | null;
    publicSiteVisible?: boolean;
    publicSiteChannelSlug?: string | null;
    publicSiteCtaLabel?: string | null;
    publicSiteIntroTitle?: string | null;
    publicSiteIntroText?: string | null;
    publicSiteIntroImageUrl?: string | null;
    publicSiteGuestLinkUrl?: string | null;
    capabilityId?: string;
    capabilityMode?: LinkCapabilityMode;
    capabilityDescriptor?: LinkCapabilityDescriptor;
    expiresAt?: Date;
  }, client?: PoolClient): Promise<DirectGuestLinkRecord> {
    // Keep this write as an ordinary parameterized query. The generated pgtyped
    // metadata stores character offsets for named parameters; editing the source
    // query without regenerating it can leave a literal `:parameter` in SQL sent
    // to PostgreSQL. Numbered placeholders cannot become stale in that way.
    const result = await (client || pool).query<CreateDirectGuestLinkResult>(
      CREATE_DIRECT_GUEST_LINK_SQL,
      [
        input.linkId,
        input.familyId,
        input.hostIdentityId,
        input.createdByIdentityId,
        input.secretHash,
        input.encryptedSecret ? JSON.stringify(input.encryptedSecret) : null,
        input.canMessage,
        input.canCall,
        input.canDirectFileTransfer,
        input.canServerAttachments,
        input.title || null,
        input.presentationTitle || null,
        input.presentationDescription || null,
        input.presentationImageUrl || null,
        input.maxUses ?? null,
        input.hostCanMessageGuest,
        input.guestCanMessageHost,
        input.hostCanCallGuest,
        input.guestCanCallHost,
        input.hostCanDirectFileTransferGuest,
        input.guestCanDirectFileTransferHost,
        input.hostCanServerAttachmentsGuest,
        input.guestCanServerAttachmentsHost,
        input.autoSubscribeToChannel,
        input.publicSiteVisible ?? false,
        input.publicSiteChannelSlug || null,
        input.publicSiteCtaLabel || null,
        input.publicSiteIntroTitle || null,
        input.publicSiteIntroText || null,
        input.publicSiteIntroImageUrl || null,
        input.publicSiteGuestLinkUrl || null,
        input.capabilityId || null,
        input.capabilityDescriptor?.payload.capabilityPublicKey.value || null,
        input.capabilityMode || null,
        input.capabilityDescriptor ? JSON.stringify(input.capabilityDescriptor) : null,
        input.expiresAt || null,
      ]
    );
    return mapDirectGuestLink(result.rows[0]);
  }

  async getDefaults(familyId: string, hostIdentityId: string): Promise<DirectGuestLinkPresentationRecord | null> {
    const results = await getDirectGuestLinkDefaults.run({ familyId, hostIdentityId }, pool);
    return results[0] ? mapDirectGuestLinkPresentationRow(results[0]) : null;
  }

  async setDefaults(input: {
    familyId: string;
    hostIdentityId: string;
    presentationTitle?: string | null;
    presentationDescription?: string | null;
    presentationImageUrl?: string | null;
  }): Promise<DirectGuestLinkPresentationRecord> {
    const params: UpsertDirectGuestLinkDefaultsParams = {
      familyId: input.familyId,
      hostIdentityId: input.hostIdentityId,
      presentationTitle: input.presentationTitle || null,
      presentationDescription: input.presentationDescription || null,
      presentationImageUrl: input.presentationImageUrl || null,
    };
    const results = await upsertDirectGuestLinkDefaults.run(params, pool);
    return mapDirectGuestLinkPresentationRow(results[0]);
  }

  async revokeIfExhausted(familyId: string, linkId: string): Promise<void> {
    await revokeExhaustedDirectGuestLink.run({ familyId, linkId }, pool);
  }

  async findById(familyId: string, linkId: string): Promise<DirectGuestLinkRecord | null> {
    const results = await findDirectGuestLinkById.run({ familyId, linkId }, pool);
    return results[0] ? mapDirectGuestLink(results[0]) : null;
  }

  async setCapabilityRevocation(
    familyId: string,
    linkId: string,
    revocation: LinkCapabilityRevocation
  ): Promise<void> {
    await pool.query(
      `UPDATE direct_guest_links
       SET capability_revocation = $1::jsonb
       WHERE family_id = $2 AND link_id = $3`,
      [JSON.stringify(revocation), familyId, linkId]
    );
  }

  async listByHostIdentity(familyId: string, hostIdentityId: string): Promise<DirectGuestLinkListRecord[]> {
    const results = await listDirectGuestLinksByHostIdentity.run({ familyId, hostIdentityId }, pool);
    return results.map(mapDirectGuestLinkListRow);
  }

  async deleteRevokedEmpty(
    familyId: string,
    linkId: string,
    hostIdentityId: string
  ): Promise<DirectGuestLinkRecord | null> {
    const result = await pool.query<FindDirectGuestLinkByIdResult>(
      `WITH target AS (
         SELECT l.family_id, l.link_id
         FROM direct_guest_links l
         WHERE l.family_id = $1
           AND l.link_id = $2
           AND l.host_identity_id = $3
           AND l.status = 'revoked'
           AND NOT EXISTS (
             SELECT 1
             FROM direct_guest_registrations r
             WHERE r.family_id = l.family_id
               AND r.link_id = l.link_id
           )
       ),
       deleted_channel_links AS (
         DELETE FROM announcement_channel_links acl
         USING target
         WHERE acl.family_id = target.family_id
           AND acl.link_id = target.link_id
       )
       DELETE FROM direct_guest_links l
       USING target
       WHERE l.family_id = target.family_id
         AND l.link_id = target.link_id
       RETURNING l.*`,
      [familyId, linkId, hostIdentityId]
    );
    return result.rows[0] ? mapDirectGuestLink(result.rows[0]) : null;
  }

  async revoke(
    familyId: string,
    linkId: string,
    hostIdentityId: string,
    client?: PoolClient
  ): Promise<DirectGuestLinkRecord | null> {
    const results = await revokeDirectGuestLink.run({ familyId, linkId, hostIdentityId }, client || pool);
    return results[0] ? mapDirectGuestLink(results[0]) : null;
  }

}

export const directGuestLinkRepository = new DirectGuestLinkRepository();
