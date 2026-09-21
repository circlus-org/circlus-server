import { nanoid } from 'nanoid';
import { getClient, pool, transaction } from '../index';
import type { PoolClient } from 'pg';

export type AnnouncementChannelStatus = 'active' | 'archived' | 'deleted';
export type AnnouncementChannelSubscriptionStatus = 'active' | 'paused' | 'unsubscribed' | 'removed_by_author';
export type AnnouncementChannelPublicSiteState = 'hidden' | 'requested' | 'published';

export type AnnouncementChannelRecord = {
  channel_id: string;
  family_id: string;
  owner_identity_id: string;
  title: null;
  description: string | null;
  metadata_epoch: number | null;
  metadata_ciphertext: string | null;
  metadata_revision: number;
  metadata_author_device_id: string | null;
  metadata_author_claim: unknown | null;
  metadata_author_device_public_key_algorithm?: string;
  metadata_author_device_public_key_value?: string;
  metadata_author_device_encryption_public_key_algorithm?: string;
  metadata_author_device_encryption_public_key_value?: string;
  metadata_author_device_registration_attestation?: unknown;
  metadata_author_identity_public_key_algorithm?: string;
  metadata_author_identity_public_key_value?: string;
  reactions_enabled: boolean;
  is_default: boolean;
  disclose_server_admin_status: boolean;
  public_site_state: AnnouncementChannelPublicSiteState;
  public_site_visible: boolean;
  public_site_slug: string | null;
  public_site_cta_label: string | null;
  public_site_intro_title: string | null;
  public_site_intro_text: string | null;
  public_site_intro_image_url: string | null;
  public_site_guest_link_id: string | null;
  public_site_guest_link_url: string | null;
  public_site_requested_by_identity_id: string | null;
  public_site_requested_at: Date | null;
  public_site_approved_by_identity_id: string | null;
  public_site_approved_at: Date | null;
  status: AnnouncementChannelStatus;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  deleted_at: Date | null;
  key_epoch: number;
  next_post_sequence: number;
  key_epoch_updated_at: Date;
};

export type AnnouncementChannelSubscriptionRecord = {
  subscription_id: string;
  family_id: string;
  channel_id: string;
  subscriber_identity_id: string;
  source_link_id: string | null;
  notifications_enabled: boolean;
  status: AnnouncementChannelSubscriptionStatus;
  subscribed_at: Date;
  updated_at: Date;
  unsubscribed_at: Date | null;
  removed_by_identity_id: string | null;
  removed_at: Date | null;
  last_received_sequence: number | null;
  last_read_sequence: number | null;
  key_status: 'pending' | 'ready';
  subscription_claim: unknown | null;
};

export type AnnouncementChannelEpochKeyRecord = {
  family_id: string;
  channel_id: string;
  epoch: number;
  key_commitment: string;
  proposer_identity_id: string;
  proposer_device_id: string;
  signed_epoch_transition: unknown;
  membership_state_id: string | null;
  created_at: Date;
};

export type AnnouncementChannelKeyEnvelopeRecord = {
  family_id: string;
  channel_id: string;
  epoch: number;
  identity_id: string;
  envelope_ciphertext: string;
  publisher_identity_id: string;
  membership_state_id: string | null;
  created_at: Date;
};

export type AnnouncementChannelPostRecord = {
  post_id: string;
  family_id: string;
  channel_id: string;
  post_sequence: number;
  author_identity_id: string;
  author_device_id: string;
  client_post_id: string;
  client_created_at: number | null;
  epoch: number;
  ciphertext: string;
  notification_preview_ciphertext: string | null;
  author_signature: string;
  author_signed_claim: unknown;
  author_device_public_key_algorithm?: string;
  author_device_public_key_value?: string;
  author_device_encryption_public_key_algorithm?: string;
  author_device_encryption_public_key_value?: string;
  author_device_registration_attestation?: unknown;
  author_identity_public_key_algorithm?: string;
  author_identity_public_key_value?: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
};

export type AnnouncementChannelActivityRecord = AnnouncementChannelPostRecord & {
  unread_count: number;
};

export type VisibleAnnouncementChannelRecord = AnnouncementChannelRecord & {
  author_is_circle_owner: boolean;
  author_is_server_admin: boolean;
  subscription_id: string | null;
  subscription_status: AnnouncementChannelSubscriptionStatus | null;
  notifications_enabled: boolean | null;
  source_link_id: string | null;
  key_status: 'pending' | 'ready' | null;
  last_received_sequence: number | null;
  last_read_sequence: number | null;
  link_count: number;
  subscriber_count: number;
};

export type AnnouncementChannelRecipientRecord = {
  subscription_id: string;
  registration_id: string | null;
  guest_identity_id: string;
  guest_identity_name: string | null;
  guest_public_key_algorithm: 'ed25519' | 'x25519' | null;
  guest_public_key_value: string | null;
  source_link_id: string | null;
};

export type OwnedChannelSubscriptionImpactRecord = {
  channel_id: string;
  key_epoch: number;
  subscription_id: string;
};

export type AnnouncementChannelPostEngagementRecipientRecord = {
  subscription_id: string;
  subscriber_identity_id: string;
  subscriber_identity_name: string | null;
  source_link_id: string | null;
  subscription_status: AnnouncementChannelSubscriptionStatus;
  received: boolean;
  viewed: boolean;
};

export type AnnouncementChannelDeliveryPolicy = {
  subscription_id: string;
  notifications_enabled: boolean;
};

export type PublicSiteAnnouncementChannelRecord = AnnouncementChannelRecord & {
  public_site_guest_link_url: string | null;
};

export class AnnouncementChannelRepository {
  async create(input: {
    familyId: string;
    ownerIdentityId: string;
  }, client?: PoolClient): Promise<AnnouncementChannelRecord> {
    const result = await (client || pool).query<AnnouncementChannelRecord>(
      `INSERT INTO announcement_channels (
         channel_id, family_id, owner_identity_id, title, description, is_default
       ) VALUES ($1, $2, $3, NULL, NULL, FALSE)
       RETURNING *`,
      [
        `ach_${nanoid(22)}`,
        input.familyId,
        input.ownerIdentityId,
      ]
    );
    return result.rows[0];
  }

  async findById(familyId: string, channelId: string): Promise<AnnouncementChannelRecord | null> {
    const result = await pool.query<AnnouncementChannelRecord>(
      `SELECT *
         FROM announcement_channels
        WHERE family_id = $1
          AND channel_id = $2
        LIMIT 1`,
      [familyId, channelId]
    );
    return result.rows[0] || null;
  }

  async updateMetadata(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    epoch: number;
    expectedRevision: number;
    ciphertext: string;
    authorDeviceId: string;
    authorClaim: unknown;
  }): Promise<AnnouncementChannelRecord | null> {
    const result = await pool.query<AnnouncementChannelRecord>(
      `UPDATE announcement_channels
          SET metadata_epoch = $4,
              metadata_ciphertext = $5,
              metadata_revision = metadata_revision + 1,
              metadata_author_device_id = $6,
              metadata_author_claim = $7::jsonb,
              updated_at = NOW()
        WHERE family_id = $1
          AND channel_id = $2
          AND owner_identity_id = $3
          AND status = 'active'
          AND key_epoch = $4
          AND metadata_revision = $8
       RETURNING *`,
      [
        input.familyId,
        input.channelId,
        input.ownerIdentityId,
        input.epoch,
        input.ciphertext,
        input.authorDeviceId,
        JSON.stringify(input.authorClaim),
        input.expectedRevision,
      ]
    );
    return result.rows[0] || null;
  }

  async updateServerAdminDisclosure(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    enabled: boolean;
  }): Promise<AnnouncementChannelRecord | null> {
    const result = await pool.query<AnnouncementChannelRecord>(
      `UPDATE announcement_channels
          SET disclose_server_admin_status = $4,
              updated_at = NOW()
        WHERE family_id = $1
          AND channel_id = $2
          AND owner_identity_id = $3
          AND status = 'active'
       RETURNING *`,
      [input.familyId, input.channelId, input.ownerIdentityId, input.enabled]
    );
    return result.rows[0] || null;
  }

  async findByLink(familyId: string, linkId: string, client?: PoolClient): Promise<AnnouncementChannelRecord | null> {
    const result = await (client || pool).query<AnnouncementChannelRecord>(
      `SELECT c.*
         FROM announcement_channel_links cl
         JOIN announcement_channels c
           ON c.family_id = cl.family_id
          AND c.channel_id = cl.channel_id
        WHERE cl.family_id = $1
          AND cl.link_id = $2
        LIMIT 1`,
      [familyId, linkId]
    );
    return result.rows[0] || null;
  }

  async clearPublicGuestLink(
    familyId: string,
    linkId: string,
    client?: PoolClient
  ): Promise<AnnouncementChannelRecord | null> {
    const result = await (client || pool).query<AnnouncementChannelRecord>(
      `UPDATE announcement_channels
          SET public_site_guest_link_id = NULL,
              public_site_guest_link_url = NULL,
              updated_at = NOW()
        WHERE family_id = $1
          AND public_site_guest_link_id = $2
       RETURNING *`,
      [familyId, linkId]
    );
    return result.rows[0] || null;
  }

  async attachLink(input: {
    familyId: string;
    channelId: string;
    linkId: string;
    ownerIdentityId: string;
  }, externalClient?: PoolClient): Promise<AnnouncementChannelRecord | null> {
    const client = externalClient || await getClient();
    const ownsTransaction = !externalClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      const channel = await client.query<AnnouncementChannelRecord>(
        `SELECT *
           FROM announcement_channels
          WHERE family_id = $1
            AND channel_id = $2
            AND owner_identity_id = $3
            AND status = 'active'
          LIMIT 1
          FOR UPDATE`,
        [input.familyId, input.channelId, input.ownerIdentityId]
      );
      if (!channel.rows[0]) {
        if (ownsTransaction) await client.query('ROLLBACK');
        return null;
      }
      const link = await client.query<{ link_id: string }>(
        `SELECT link_id
           FROM direct_guest_links
          WHERE family_id = $1
            AND link_id = $2
            AND host_identity_id = $3
            AND status = 'active'
          LIMIT 1
          FOR UPDATE`,
        [input.familyId, input.linkId, input.ownerIdentityId]
      );
      if (!link.rows[0]) {
        if (ownsTransaction) await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `INSERT INTO announcement_channel_links (family_id, channel_id, link_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (family_id, link_id) DO NOTHING`,
        [input.familyId, input.channelId, input.linkId]
      );
      const attached = await client.query<{ channel_id: string }>(
        `SELECT channel_id
           FROM announcement_channel_links
          WHERE family_id = $1
            AND link_id = $2
          LIMIT 1`,
        [input.familyId, input.linkId]
      );
      if (attached.rows[0]?.channel_id !== input.channelId) {
        if (ownsTransaction) await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `UPDATE announcement_channels
            SET public_site_guest_link_id = COALESCE(public_site_guest_link_id, $3),
                updated_at = NOW()
          WHERE family_id = $1
            AND channel_id = $2`,
        [input.familyId, input.channelId, input.linkId]
      );
      const updated = await client.query<AnnouncementChannelRecord>(
        `SELECT * FROM announcement_channels WHERE family_id = $1 AND channel_id = $2`,
        [input.familyId, input.channelId]
      );
      if (ownsTransaction) await client.query('COMMIT');
      return updated.rows[0] || null;
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  async ensureDefaultForLink(input: {
    familyId: string;
    linkId: string;
    ownerIdentityId: string;
  }, externalClient?: PoolClient): Promise<AnnouncementChannelRecord> {
    const client = externalClient || await getClient();
    const ownsTransaction = !externalClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      const linked = await client.query<AnnouncementChannelRecord>(
        `SELECT c.*
           FROM announcement_channel_links cl
           JOIN announcement_channels c
             ON c.family_id = cl.family_id
            AND c.channel_id = cl.channel_id
          WHERE cl.family_id = $1
            AND cl.link_id = $2
          LIMIT 1
          FOR UPDATE OF c`,
        [input.familyId, input.linkId]
      );
      if (linked.rows[0]) {
        if (ownsTransaction) await client.query('COMMIT');
        return linked.rows[0];
      }

      let channel = await client.query<AnnouncementChannelRecord>(
        `SELECT *
           FROM announcement_channels
          WHERE family_id = $1
            AND owner_identity_id = $2
            AND is_default = TRUE
            AND status = 'active'
          LIMIT 1
          FOR UPDATE`,
        [input.familyId, input.ownerIdentityId]
      );

      if (!channel.rows[0]) {
        await client.query(
          `INSERT INTO announcement_channels (
             channel_id, family_id, owner_identity_id, title, description, is_default
           ) VALUES ($1, $2, $3, NULL, NULL, TRUE)
           ON CONFLICT DO NOTHING`,
          [`ach_${nanoid(22)}`, input.familyId, input.ownerIdentityId]
        );
        channel = await client.query<AnnouncementChannelRecord>(
          `SELECT *
             FROM announcement_channels
            WHERE family_id = $1
              AND owner_identity_id = $2
              AND is_default = TRUE
              AND status = 'active'
            LIMIT 1
            FOR UPDATE`,
          [input.familyId, input.ownerIdentityId]
        );
      }

      const resolved = channel.rows[0];
      if (!resolved) throw new Error('Failed to create default announcement channel');

      await client.query(
        `INSERT INTO announcement_channel_links (family_id, channel_id, link_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (family_id, link_id) DO NOTHING`,
        [input.familyId, resolved.channel_id, input.linkId]
      );
      const attached = await client.query<AnnouncementChannelRecord>(
        `SELECT c.*
           FROM announcement_channel_links cl
           JOIN announcement_channels c
             ON c.family_id = cl.family_id
            AND c.channel_id = cl.channel_id
          WHERE cl.family_id = $1
            AND cl.link_id = $2
          LIMIT 1`,
        [input.familyId, input.linkId]
      );
      if (ownsTransaction) await client.query('COMMIT');
      if (!attached.rows[0]) throw new Error('Failed to attach guest link to announcement channel');
      return attached.rows[0];
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  async ensureHostLinkChannelMappings(input: {
    familyId: string;
    ownerIdentityId: string;
    linkIds: string[];
    autoSubscribeLinkIds: string[];
  }): Promise<Array<{ link_id: string; channel_id: string }>> {
    if (input.linkIds.length === 0) return [];
    return transaction(async (client) => {
      const existing = await client.query<{ link_id: string; channel_id: string }>(
        `SELECT link_id, channel_id
           FROM announcement_channel_links
          WHERE family_id = $1 AND link_id = ANY($2::text[])`,
        [input.familyId, input.linkIds]
      );
      const mappedLinkIds = new Set(existing.rows.map((row) => row.link_id));
      const missingAutoSubscribeLinkIds = input.autoSubscribeLinkIds.filter(
        (linkId) => !mappedLinkIds.has(linkId)
      );
      if (missingAutoSubscribeLinkIds.length === 0) return existing.rows;

      let defaultChannel = await client.query<{ channel_id: string }>(
        `SELECT channel_id
           FROM announcement_channels
          WHERE family_id = $1
            AND owner_identity_id = $2
            AND is_default = TRUE
            AND status = 'active'
          LIMIT 1
          FOR UPDATE`,
        [input.familyId, input.ownerIdentityId]
      );
      if (!defaultChannel.rows[0]) {
        await client.query(
          `INSERT INTO announcement_channels (
             channel_id, family_id, owner_identity_id, title, description, is_default
           ) VALUES ($1, $2, $3, NULL, NULL, TRUE)
           ON CONFLICT DO NOTHING`,
          [`ach_${nanoid(22)}`, input.familyId, input.ownerIdentityId]
        );
        defaultChannel = await client.query<{ channel_id: string }>(
          `SELECT channel_id
             FROM announcement_channels
            WHERE family_id = $1
              AND owner_identity_id = $2
              AND is_default = TRUE
              AND status = 'active'
            LIMIT 1
            FOR UPDATE`,
          [input.familyId, input.ownerIdentityId]
        );
      }
      const channelId = defaultChannel.rows[0]?.channel_id;
      if (!channelId) throw new Error('Failed to resolve default announcement channel');

      await client.query(
        `INSERT INTO announcement_channel_links (family_id, channel_id, link_id)
         SELECT link.family_id, $3, link.link_id
           FROM direct_guest_links link
          WHERE link.family_id = $1
            AND link.host_identity_id = $2
            AND link.status = 'active'
            AND link.auto_subscribe_to_channel = TRUE
            AND link.link_id = ANY($4::text[])
         ON CONFLICT (family_id, link_id) DO NOTHING`,
        [input.familyId, input.ownerIdentityId, channelId, missingAutoSubscribeLinkIds]
      );
      const resolved = await client.query<{ link_id: string; channel_id: string }>(
        `SELECT link_id, channel_id
           FROM announcement_channel_links
          WHERE family_id = $1 AND link_id = ANY($2::text[])`,
        [input.familyId, input.linkIds]
      );
      return resolved.rows;
    });
  }

  async listVisibleForIdentity(input: {
    familyId: string;
    identityId: string;
    role?: string | null;
  }): Promise<VisibleAnnouncementChannelRecord[]> {
    const result = await pool.query<VisibleAnnouncementChannelRecord>(
      `SELECT
         c.*,
         metadata_device.public_key_algorithm AS metadata_author_device_public_key_algorithm,
         metadata_device.public_key_value AS metadata_author_device_public_key_value,
         metadata_device.encryption_public_key_algorithm AS metadata_author_device_encryption_public_key_algorithm,
         metadata_device.encryption_public_key_value AS metadata_author_device_encryption_public_key_value,
         metadata_device.registration_attestation AS metadata_author_device_registration_attestation,
         metadata_identity.public_key_algorithm AS metadata_author_identity_public_key_algorithm,
         metadata_identity.public_key_value AS metadata_author_identity_public_key_value,
         s.subscription_id,
         s.status AS subscription_status,
         s.notifications_enabled,
         s.source_link_id,
         s.key_status,
         s.last_received_sequence,
         s.last_read_sequence,
         EXISTS (
           SELECT 1
           FROM identities author_identity
           WHERE author_identity.family_id = c.family_id
             AND author_identity.identity_id = c.owner_identity_id
             AND author_identity.role = 'owner'
             AND author_identity.status = 'active'
         ) AS author_is_circle_owner,
         EXISTS (
           SELECT 1
           FROM server_admins author_server_admin
           WHERE author_server_admin.principal_identity_id = c.owner_identity_id
             AND author_server_admin.status = 'active'
         ) AS author_is_server_admin,
         (
           SELECT COUNT(*)::integer
           FROM announcement_channel_links link_count
           WHERE link_count.family_id = c.family_id
             AND link_count.channel_id = c.channel_id
         ) AS link_count,
         (
           SELECT COUNT(*)::integer
           FROM announcement_channel_subscriptions subscriber_count
           WHERE subscriber_count.family_id = c.family_id
             AND subscriber_count.channel_id = c.channel_id
             AND subscriber_count.status = 'active'
             AND subscriber_count.subscriber_identity_id <> c.owner_identity_id
         ) AS subscriber_count
       FROM announcement_channels c
       LEFT JOIN announcement_channel_subscriptions s
         ON s.family_id = c.family_id
        AND s.channel_id = c.channel_id
        AND s.subscriber_identity_id = $2
       LEFT JOIN devices metadata_device
         ON metadata_device.device_id = c.metadata_author_device_id
       LEFT JOIN identities metadata_identity
         ON metadata_identity.family_id = c.family_id
        AND metadata_identity.identity_id = c.owner_identity_id
       WHERE c.family_id = $1
         AND c.status = 'active'
         AND (c.owner_identity_id = $2 OR s.status IS DISTINCT FROM 'removed_by_author')
         AND (
           c.owner_identity_id = $2
           OR $3 IN ('owner', 'member')
           OR EXISTS (
             SELECT 1
             FROM announcement_channel_links acl
             JOIN direct_guest_registrations registration
               ON registration.family_id = acl.family_id
              AND registration.link_id = acl.link_id
              AND registration.guest_identity_id = $2
              AND registration.status = 'active'
             WHERE acl.family_id = c.family_id
               AND acl.channel_id = c.channel_id
           )
           OR s.status = 'active'
           OR s.status = 'unsubscribed'
         )
       ORDER BY c.is_default DESC, c.created_at ASC`,
      [input.familyId, input.identityId, input.role || '']
    );
    return result.rows;
  }

  async listPublicSiteVisible(familyId: string): Promise<PublicSiteAnnouncementChannelRecord[]> {
    const result = await pool.query<PublicSiteAnnouncementChannelRecord>(
      `SELECT c.*,
              CASE WHEN link.status = 'active' THEN c.public_site_guest_link_url ELSE NULL END
                AS public_site_guest_link_url
         FROM announcement_channels c
         LEFT JOIN direct_guest_links link
           ON link.family_id = c.family_id
          AND link.link_id = c.public_site_guest_link_id
          AND link.status = 'active'
        WHERE c.family_id = $1
          AND c.status = 'active'
          AND c.public_site_visible = TRUE
        ORDER BY c.created_at`,
      [familyId]
    );
    return result.rows;
  }

  async updatePublicSite(input: {
    familyId: string;
    channelId: string;
    visible: boolean;
    slug?: string | null;
    ctaLabel?: string | null;
    introTitle?: string | null;
    introText?: string | null;
    introImageUrl?: string | null;
    guestLinkId?: string | null;
    guestLinkUrl?: string | null;
    state?: AnnouncementChannelPublicSiteState;
    requestedByIdentityId?: string | null;
    approvedByIdentityId?: string | null;
  }, client?: PoolClient): Promise<AnnouncementChannelRecord | null> {
    const state = input.state || (input.visible ? 'published' : 'hidden');
    const result = await (client || pool).query<AnnouncementChannelRecord>(
      `UPDATE announcement_channels
          SET public_site_state = $3,
              public_site_visible = ($3 = 'published'),
              public_site_slug = $4,
              public_site_cta_label = $5,
              public_site_intro_title = $6,
              public_site_intro_text = $7,
              public_site_intro_image_url = $8,
              public_site_guest_link_id = $9,
              public_site_guest_link_url = $10,
              public_site_requested_by_identity_id = CASE
                WHEN $3 IN ('requested', 'published') THEN $11
                ELSE NULL
              END,
              public_site_requested_at = CASE
                WHEN $3 IN ('requested', 'published') THEN COALESCE(public_site_requested_at, NOW())
                ELSE NULL
              END,
              public_site_approved_by_identity_id = CASE
                WHEN $3 = 'published' THEN $12
                ELSE NULL
              END,
              public_site_approved_at = CASE
                WHEN $3 = 'published' THEN COALESCE(public_site_approved_at, NOW())
                ELSE NULL
              END,
              updated_at = NOW()
        WHERE family_id = $1
          AND channel_id = $2
       RETURNING *`,
      [
        input.familyId,
        input.channelId,
        state,
        input.slug || null,
        input.ctaLabel || null,
        input.introTitle || null,
        input.introText || null,
        input.introImageUrl || null,
        input.guestLinkId || null,
        input.guestLinkUrl || null,
        input.requestedByIdentityId || null,
        input.approvedByIdentityId || null,
      ]
    );
    return result.rows[0] || null;
  }

  async canIdentityAccess(input: {
    familyId: string;
    channelId: string;
    identityId: string;
    role?: string | null;
  }): Promise<boolean> {
    const visible = await this.listVisibleForIdentity(input);
    return visible.some((channel) => channel.channel_id === input.channelId);
  }

  async subscribe(input: {
    familyId: string;
    channelId: string;
    identityId: string;
    sourceLinkId?: string | null;
    notificationsEnabled?: boolean;
    subscriptionClaim: unknown;
  }): Promise<AnnouncementChannelSubscriptionRecord> {
    const result = await pool.query<AnnouncementChannelSubscriptionRecord>(
      `INSERT INTO announcement_channel_subscriptions (
         subscription_id,
         family_id,
         channel_id,
         subscriber_identity_id,
         source_link_id,
         notifications_enabled,
         status,
         subscribed_at,
         updated_at,
         unsubscribed_at,
         subscription_claim
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW(), NULL, $7::jsonb)
       ON CONFLICT (family_id, channel_id, subscriber_identity_id) DO UPDATE
       SET source_link_id = COALESCE(
             announcement_channel_subscriptions.source_link_id,
             EXCLUDED.source_link_id
           ),
           notifications_enabled = EXCLUDED.notifications_enabled,
           status = CASE
             WHEN announcement_channel_subscriptions.status = 'removed_by_author'
               THEN announcement_channel_subscriptions.status
             ELSE 'active'
           END,
           subscribed_at = CASE
             WHEN announcement_channel_subscriptions.status = 'unsubscribed' THEN NOW()
             ELSE announcement_channel_subscriptions.subscribed_at
           END,
           updated_at = NOW(),
           unsubscribed_at = CASE
             WHEN announcement_channel_subscriptions.status = 'removed_by_author'
               THEN announcement_channel_subscriptions.unsubscribed_at
             ELSE NULL
           END,
           removed_by_identity_id = CASE
             WHEN announcement_channel_subscriptions.status = 'removed_by_author'
               THEN announcement_channel_subscriptions.removed_by_identity_id
             ELSE NULL
           END,
           removed_at = CASE
             WHEN announcement_channel_subscriptions.status = 'removed_by_author'
               THEN announcement_channel_subscriptions.removed_at
             ELSE NULL
           END,
           subscription_claim = EXCLUDED.subscription_claim
       RETURNING *`,
      [
        `acs_${nanoid(22)}`,
        input.familyId,
        input.channelId,
        input.identityId,
        input.sourceLinkId || null,
        input.notificationsEnabled !== false,
        JSON.stringify(input.subscriptionClaim),
      ]
    );
    return result.rows[0];
  }

  async unsubscribe(
    familyId: string,
    channelId: string,
    identityId: string
  ): Promise<AnnouncementChannelSubscriptionRecord | null> {
    const result = await pool.query<AnnouncementChannelSubscriptionRecord>(
      `UPDATE announcement_channel_subscriptions
          SET status = 'unsubscribed',
              notifications_enabled = FALSE,
              updated_at = NOW(),
              unsubscribed_at = NOW()
        WHERE family_id = $1
          AND channel_id = $2
          AND subscriber_identity_id = $3
          AND status IN ('active', 'paused')
       RETURNING *`,
      [familyId, channelId, identityId]
    );
    return result.rows[0] || null;
  }

  async removeSubscriberByAuthor(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    subscriberIdentityId: string;
  }, client?: PoolClient): Promise<AnnouncementChannelSubscriptionRecord | null> {
    const result = await (client || pool).query<AnnouncementChannelSubscriptionRecord>(
      `UPDATE announcement_channel_subscriptions subscription
          SET status = 'removed_by_author',
              notifications_enabled = FALSE,
              updated_at = NOW(),
              unsubscribed_at = NOW(),
              removed_by_identity_id = $3,
              removed_at = NOW()
         FROM announcement_channels channel
        WHERE subscription.family_id = $1
          AND subscription.channel_id = $2
          AND subscription.subscriber_identity_id = $4
          AND subscription.status = 'active'
          AND channel.family_id = subscription.family_id
          AND channel.channel_id = subscription.channel_id
          AND channel.owner_identity_id = $3
          AND subscription.subscriber_identity_id <> channel.owner_identity_id
       RETURNING subscription.*`,
      [input.familyId, input.channelId, input.ownerIdentityId, input.subscriberIdentityId]
    );
    return result.rows[0] || null;
  }

  async restoreSubscriberByAuthor(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    subscriberIdentityId: string;
  }): Promise<AnnouncementChannelSubscriptionRecord | null> {
    const result = await pool.query<AnnouncementChannelSubscriptionRecord>(
      `UPDATE announcement_channel_subscriptions subscription
          SET status = 'unsubscribed',
              updated_at = NOW(),
              removed_by_identity_id = NULL,
              removed_at = NULL
         FROM announcement_channels channel
        WHERE subscription.family_id = $1
          AND subscription.channel_id = $2
          AND subscription.subscriber_identity_id = $4
          AND subscription.status = 'removed_by_author'
          AND channel.family_id = subscription.family_id
          AND channel.channel_id = subscription.channel_id
          AND channel.owner_identity_id = $3
       RETURNING subscription.*`,
      [input.familyId, input.channelId, input.ownerIdentityId, input.subscriberIdentityId]
    );
    return result.rows[0] || null;
  }

  async listOwnedActiveSubscriptionsForGuest(input: {
    familyId: string;
    ownerIdentityId: string;
    guestIdentityId: string;
  }, client?: PoolClient): Promise<OwnedChannelSubscriptionImpactRecord[]> {
    const result = await (client || pool).query<OwnedChannelSubscriptionImpactRecord>(
      `SELECT channel.channel_id, channel.key_epoch, subscription.subscription_id
         FROM announcement_channel_subscriptions subscription
         JOIN announcement_channels channel
           ON channel.family_id = subscription.family_id
          AND channel.channel_id = subscription.channel_id
          AND channel.owner_identity_id = $2
          AND channel.status = 'active'
        WHERE subscription.family_id = $1
          AND subscription.subscriber_identity_id = $3
          AND subscription.status = 'active'
        ORDER BY channel.created_at ASC`,
      [input.familyId, input.ownerIdentityId, input.guestIdentityId]
    );
    return result.rows;
  }

  async updateNotifications(
    familyId: string,
    channelId: string,
    identityId: string,
    notificationsEnabled: boolean
  ): Promise<AnnouncementChannelSubscriptionRecord | null> {
    const result = await pool.query<AnnouncementChannelSubscriptionRecord>(
      `UPDATE announcement_channel_subscriptions
          SET notifications_enabled = $4,
              updated_at = NOW()
        WHERE family_id = $1
          AND channel_id = $2
          AND subscriber_identity_id = $3
          AND status = 'active'
       RETURNING *`,
      [familyId, channelId, identityId, notificationsEnabled]
    );
    return result.rows[0] || null;
  }

  async findDeliveryPolicy(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    subscriberIdentityId: string;
  }): Promise<AnnouncementChannelDeliveryPolicy | null> {
    const result = await pool.query<AnnouncementChannelDeliveryPolicy>(
      `SELECT s.subscription_id, s.notifications_enabled
         FROM announcement_channel_subscriptions s
         JOIN announcement_channels c
           ON c.family_id = s.family_id
          AND c.channel_id = s.channel_id
          AND c.owner_identity_id = $3
          AND c.status = 'active'
        WHERE s.family_id = $1
          AND s.channel_id = $2
          AND s.subscriber_identity_id = $4
          AND s.status = 'active'
        LIMIT 1`,
      [
        input.familyId,
        input.channelId,
        input.ownerIdentityId,
        input.subscriberIdentityId,
      ]
    );
    return result.rows[0] || null;
  }

  async findActiveSubscription(
    familyId: string,
    channelId: string,
    subscriptionId: string
  ): Promise<AnnouncementChannelSubscriptionRecord | null> {
    const result = await pool.query<AnnouncementChannelSubscriptionRecord>(
      `SELECT *
         FROM announcement_channel_subscriptions
        WHERE family_id = $1
          AND channel_id = $2
          AND subscription_id = $3
          AND status = 'active'
        LIMIT 1`,
      [familyId, channelId, subscriptionId]
    );
    return result.rows[0] || null;
  }

  async findSubscriptionForIdentity(
    familyId: string,
    channelId: string,
    identityId: string
  ): Promise<AnnouncementChannelSubscriptionRecord | null> {
    const result = await pool.query<AnnouncementChannelSubscriptionRecord>(
      `SELECT * FROM announcement_channel_subscriptions
        WHERE family_id = $1 AND channel_id = $2
          AND subscriber_identity_id = $3
        LIMIT 1`,
      [familyId, channelId, identityId]
    );
    return result.rows[0] || null;
  }

  async listPushSubscribersPage(
    familyId: string,
    channelId: string,
    ownerIdentityId: string,
    afterIdentityId: string | null,
    limit: number
  ): Promise<Array<{ identity_id: string }>> {
    const result = await pool.query<{ identity_id: string }>(
      `SELECT subscriber_identity_id AS identity_id
         FROM announcement_channel_subscriptions
        WHERE family_id = $1 AND channel_id = $2 AND status = 'active' AND key_status = 'ready'
          AND subscriber_identity_id <> $3
          AND notifications_enabled = TRUE
          AND ($4::text IS NULL OR subscriber_identity_id > $4)
        ORDER BY subscriber_identity_id ASC
        LIMIT $5`,
      [familyId, channelId, ownerIdentityId, afterIdentityId, limit]
    );
    return result.rows;
  }

  async listActiveRecipients(
    familyId: string,
    channelId: string,
    ownerIdentityId: string
  ): Promise<AnnouncementChannelRecipientRecord[]> {
    const result = await pool.query<AnnouncementChannelRecipientRecord>(
      `SELECT DISTINCT ON (s.subscriber_identity_id)
         s.subscription_id,
         r.registration_id,
         s.subscriber_identity_id AS guest_identity_id,
         i.identity_name AS guest_identity_name,
         i.public_key_algorithm AS guest_public_key_algorithm,
         i.public_key_value AS guest_public_key_value,
         s.source_link_id
       FROM announcement_channel_subscriptions s
       JOIN announcement_channels c
         ON c.family_id = s.family_id
        AND c.channel_id = s.channel_id
        AND c.owner_identity_id = $3
       JOIN identities i
         ON i.family_id = s.family_id
        AND i.identity_id = s.subscriber_identity_id
        AND i.status = 'active'
       LEFT JOIN LATERAL (
         SELECT registration.registration_id,
                registration.guest_identity_id,
                registration.created_at
         FROM announcement_channel_links acl
         JOIN direct_guest_registrations registration
           ON registration.family_id = acl.family_id
          AND registration.link_id = acl.link_id
          AND registration.guest_identity_id = s.subscriber_identity_id
          AND registration.status = 'active'
         WHERE acl.family_id = s.family_id
           AND acl.channel_id = s.channel_id
         ORDER BY registration.created_at DESC
         LIMIT 1
       ) r ON TRUE
       WHERE s.family_id = $1
         AND s.channel_id = $2
         AND s.status = 'active'
         AND s.subscriber_identity_id <> $3
       ORDER BY s.subscriber_identity_id, r.created_at DESC NULLS LAST`,
      [familyId, channelId, ownerIdentityId]
    );
    return result.rows;
  }

  async listRemovedRecipients(
    familyId: string,
    channelId: string,
    ownerIdentityId: string
  ): Promise<AnnouncementChannelRecipientRecord[]> {
    const result = await pool.query<AnnouncementChannelRecipientRecord>(
      `SELECT
         s.subscription_id,
         NULL::text AS registration_id,
         s.subscriber_identity_id AS guest_identity_id,
         i.identity_name AS guest_identity_name,
         i.public_key_algorithm AS guest_public_key_algorithm,
         i.public_key_value AS guest_public_key_value,
         s.source_link_id
       FROM announcement_channel_subscriptions s
       JOIN announcement_channels c
         ON c.family_id = s.family_id
        AND c.channel_id = s.channel_id
        AND c.owner_identity_id = $3
       JOIN identities i
         ON i.family_id = s.family_id
        AND i.identity_id = s.subscriber_identity_id
       WHERE s.family_id = $1
         AND s.channel_id = $2
         AND s.status = 'removed_by_author'
       ORDER BY s.removed_at DESC NULLS LAST`,
      [familyId, channelId, ownerIdentityId]
    );
    return result.rows;
  }

  async listActiveRegistrationsForChannel(
    familyId: string,
    channelId: string,
    ownerIdentityId: string
  ): Promise<Array<{ registration_id: string; guest_identity_id: string; link_id: string }>> {
    const result = await pool.query<{ registration_id: string; guest_identity_id: string; link_id: string }>(
      `SELECT r.registration_id, r.guest_identity_id, r.link_id
         FROM announcement_channels c
         JOIN announcement_channel_links acl
           ON acl.family_id = c.family_id
          AND acl.channel_id = c.channel_id
         JOIN direct_guest_registrations r
           ON r.family_id = acl.family_id
          AND r.link_id = acl.link_id
          AND r.status = 'active'
        WHERE c.family_id = $1
          AND c.channel_id = $2
          AND c.owner_identity_id = $3
          AND c.status = 'active'`,
      [familyId, channelId, ownerIdentityId]
    );
    return result.rows;
  }

  async findEpochKey(
    familyId: string,
    channelId: string,
    epoch: number,
    client?: PoolClient
  ): Promise<AnnouncementChannelEpochKeyRecord | null> {
    const result = await (client || pool).query<AnnouncementChannelEpochKeyRecord>(
      `SELECT * FROM announcement_channel_epoch_keys
        WHERE family_id = $1 AND channel_id = $2 AND epoch = $3
        LIMIT 1`,
      [familyId, channelId, epoch]
    );
    return result.rows[0] || null;
  }

  async claimEpochKey(input: {
    familyId: string;
    channelId: string;
    epoch: number;
    keyCommitment: string;
    proposerIdentityId: string;
    proposerDeviceId: string;
    signedEpochTransition: unknown;
    membershipStateId: string;
  }, client?: PoolClient): Promise<AnnouncementChannelEpochKeyRecord> {
    const result = await (client || pool).query<AnnouncementChannelEpochKeyRecord>(
      `INSERT INTO announcement_channel_epoch_keys (
         family_id, channel_id, epoch, key_commitment, proposer_identity_id,
         proposer_device_id, signed_epoch_transition, membership_state_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (family_id, channel_id, epoch) DO UPDATE
         SET key_commitment = announcement_channel_epoch_keys.key_commitment
       RETURNING *`,
      [
        input.familyId,
        input.channelId,
        input.epoch,
        input.keyCommitment,
        input.proposerIdentityId,
        input.proposerDeviceId,
        JSON.stringify(input.signedEpochTransition),
        input.membershipStateId,
      ]
    );
    return result.rows[0];
  }

  async upsertKeyEnvelopes(input: {
    familyId: string;
    channelId: string;
    epoch: number;
    publisherIdentityId: string;
    membershipStateId: string;
    envelopes: Array<{ identityId: string; envelopeCiphertext: string }>;
  }, externalClient?: PoolClient): Promise<void> {
    if (input.envelopes.length === 0) return;
    const client = externalClient || await getClient();
    const ownsTransaction = !externalClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      for (const envelope of input.envelopes) {
        await client.query(
          `INSERT INTO announcement_channel_key_envelopes (
             family_id, channel_id, epoch, identity_id, envelope_ciphertext,
             publisher_identity_id, membership_state_id, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (family_id, channel_id, epoch, identity_id) DO UPDATE
             SET envelope_ciphertext = EXCLUDED.envelope_ciphertext,
                 publisher_identity_id = EXCLUDED.publisher_identity_id,
                 membership_state_id = EXCLUDED.membership_state_id,
                 created_at = NOW()`,
          [
            input.familyId,
            input.channelId,
            input.epoch,
            envelope.identityId,
            envelope.envelopeCiphertext,
            input.publisherIdentityId,
            input.membershipStateId,
          ]
        );
        await client.query(
          `UPDATE announcement_channel_subscriptions
              SET key_status = 'ready', updated_at = NOW()
            WHERE family_id = $1 AND channel_id = $2
              AND subscriber_identity_id = $3 AND status = 'active'`,
          [input.familyId, input.channelId, envelope.identityId]
        );
      }
      if (ownsTransaction) await client.query('COMMIT');
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  async rotateEpoch(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    proposerDeviceId: string;
    nextEpoch: number;
    keyCommitment: string;
    signedEpochTransition: unknown;
    membershipStateId: string;
    envelopes: Array<{ identityId: string; envelopeCiphertext: string }>;
  }): Promise<number | null> {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const channel = await client.query<AnnouncementChannelRecord>(
        `SELECT * FROM announcement_channels
          WHERE family_id = $1 AND channel_id = $2
            AND owner_identity_id = $3 AND status = 'active'
          FOR UPDATE`,
        [input.familyId, input.channelId, input.ownerIdentityId]
      );
      const row = channel.rows[0];
      if (!row || input.nextEpoch !== Number(row.key_epoch) + 1) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `INSERT INTO announcement_channel_epoch_keys (
           family_id, channel_id, epoch, key_commitment, proposer_identity_id,
           proposer_device_id, signed_epoch_transition, membership_state_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          input.familyId, input.channelId, input.nextEpoch, input.keyCommitment,
          input.ownerIdentityId, input.proposerDeviceId, JSON.stringify(input.signedEpochTransition),
          input.membershipStateId,
        ]
      );
      for (const envelope of input.envelopes) {
        await client.query(
          `INSERT INTO announcement_channel_key_envelopes (
             family_id, channel_id, epoch, identity_id, envelope_ciphertext,
             publisher_identity_id, membership_state_id, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            input.familyId, input.channelId, input.nextEpoch, envelope.identityId,
            envelope.envelopeCiphertext, input.ownerIdentityId,
            input.membershipStateId,
          ]
        );
      }
      await client.query(
        `UPDATE announcement_channels
            SET key_epoch = $3, key_epoch_updated_at = NOW(), updated_at = NOW()
          WHERE family_id = $1 AND channel_id = $2`,
        [input.familyId, input.channelId, input.nextEpoch]
      );
      await client.query(
        `UPDATE announcement_channel_subscriptions
            SET key_status = 'ready', updated_at = NOW()
          WHERE family_id = $1 AND channel_id = $2 AND status = 'active'`,
        [input.familyId, input.channelId]
      );
      await client.query('COMMIT');
      return input.nextEpoch;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findKeyEnvelope(
    familyId: string,
    channelId: string,
    epoch: number,
    identityId: string
  ): Promise<AnnouncementChannelKeyEnvelopeRecord | null> {
    const result = await pool.query<AnnouncementChannelKeyEnvelopeRecord>(
      `SELECT * FROM announcement_channel_key_envelopes
        WHERE family_id = $1 AND channel_id = $2 AND epoch = $3 AND identity_id = $4
        LIMIT 1`,
      [familyId, channelId, epoch, identityId]
    );
    return result.rows[0] || null;
  }

  async listMissingKeyRecipients(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    epoch: number;
  }): Promise<Array<{
    identity_id: string;
    public_key_algorithm: string;
    public_key_value: string;
    source_link_id: string | null;
    subscription_claim: unknown | null;
  }>> {
    const result = await pool.query<{
      identity_id: string;
      public_key_algorithm: string;
      public_key_value: string;
      source_link_id: string | null;
      subscription_claim: unknown | null;
    }>(
      `SELECT i.identity_id, i.public_key_algorithm, i.public_key_value,
              eligible.source_link_id, eligible.subscription_claim
         FROM identities i
         JOIN (
           SELECT c.family_id, c.channel_id, member.identity_id,
                  NULL::text AS source_link_id, NULL::jsonb AS subscription_claim
             FROM announcement_channels c
             JOIN identities member
               ON member.family_id = c.family_id
              AND member.status = 'active'
              AND member.role IN ('owner', 'member')
            WHERE c.family_id = $1 AND c.channel_id = $2 AND c.owner_identity_id = $3
           UNION
           SELECT s.family_id, s.channel_id, s.subscriber_identity_id,
                  s.source_link_id, s.subscription_claim
             FROM announcement_channel_subscriptions s
            WHERE s.family_id = $1 AND s.channel_id = $2 AND s.status = 'active'
         ) eligible ON eligible.family_id = i.family_id AND eligible.identity_id = i.identity_id
         LEFT JOIN announcement_channel_key_envelopes e
           ON e.family_id = eligible.family_id AND e.channel_id = eligible.channel_id
          AND e.epoch = $4 AND e.identity_id = eligible.identity_id
        WHERE i.status = 'active' AND e.identity_id IS NULL
        ORDER BY i.identity_id`,
      [input.familyId, input.channelId, input.ownerIdentityId, input.epoch]
    );
    return result.rows;
  }

  async createPost(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    authorDeviceId: string;
    clientPostId: string;
    clientCreatedAt: number | null;
    epoch: number;
    ciphertext: string;
    notificationPreviewCiphertext: string | null;
    authorSignature: string;
    authorSignedClaim: unknown;
  }): Promise<{ post: AnnouncementChannelPostRecord; deduplicated: boolean }> {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const existing = await client.query<AnnouncementChannelPostRecord>(
        `SELECT * FROM announcement_channel_posts
          WHERE family_id = $1 AND channel_id = $2
            AND author_device_id = $3 AND client_post_id = $4
          LIMIT 1`,
        [input.familyId, input.channelId, input.authorDeviceId, input.clientPostId]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { post: existing.rows[0], deduplicated: true };
      }
      const channel = await client.query<AnnouncementChannelRecord>(
        `SELECT * FROM announcement_channels
          WHERE family_id = $1 AND channel_id = $2
            AND owner_identity_id = $3 AND status = 'active'
          FOR UPDATE`,
        [input.familyId, input.channelId, input.ownerIdentityId]
      );
      const row = channel.rows[0];
      if (!row || Number(row.key_epoch) !== input.epoch) {
        throw Object.assign(new Error('CHANNEL_EPOCH_MISMATCH'), { code: 'CHANNEL_EPOCH_MISMATCH' });
      }
      const postId = `acp_${nanoid(22)}`;
      const sequence = Number(row.next_post_sequence);
      const inserted = await client.query<AnnouncementChannelPostRecord>(
        `INSERT INTO announcement_channel_posts (
           post_id, family_id, channel_id, post_sequence, author_identity_id,
           author_device_id, client_post_id, client_created_at, epoch, ciphertext,
           notification_preview_ciphertext, author_signature, author_signed_claim
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
         RETURNING *`,
        [
          postId, input.familyId, input.channelId, sequence, input.ownerIdentityId,
          input.authorDeviceId, input.clientPostId, input.clientCreatedAt, input.epoch,
          input.ciphertext, input.notificationPreviewCiphertext, input.authorSignature,
          JSON.stringify(input.authorSignedClaim),
        ]
      );
      await client.query(
        `UPDATE announcement_channels
            SET next_post_sequence = next_post_sequence + 1, updated_at = NOW()
          WHERE family_id = $1 AND channel_id = $2`,
        [input.familyId, input.channelId]
      );
      await client.query(
        `INSERT INTO announcement_channel_push_outbox (
           post_id, family_id, channel_id, author_identity_id
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (post_id) DO NOTHING`,
        [postId, input.familyId, input.channelId, input.ownerIdentityId]
      );
      await client.query('COMMIT');
      return { post: inserted.rows[0], deduplicated: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listPosts(input: {
    familyId: string;
    channelId: string;
    afterSequence: number;
    limit: number;
  }): Promise<AnnouncementChannelPostRecord[]> {
    const result = await pool.query<AnnouncementChannelPostRecord>(
      `SELECT p.*,
              d.public_key_algorithm AS author_device_public_key_algorithm,
              d.public_key_value AS author_device_public_key_value,
              d.encryption_public_key_algorithm AS author_device_encryption_public_key_algorithm,
              d.encryption_public_key_value AS author_device_encryption_public_key_value,
              d.registration_attestation AS author_device_registration_attestation,
              i.public_key_algorithm AS author_identity_public_key_algorithm,
              i.public_key_value AS author_identity_public_key_value
         FROM announcement_channel_posts p
         JOIN devices d ON d.device_id = p.author_device_id
         JOIN identities i ON i.identity_id = p.author_identity_id
        WHERE p.family_id = $1 AND p.channel_id = $2 AND p.post_sequence > $3
        ORDER BY p.post_sequence ASC
        LIMIT $4`,
      [input.familyId, input.channelId, input.afterSequence, input.limit]
    );
    return result.rows;
  }

  async listLatestPosts(input: {
    familyId: string;
    channelId: string;
    limit: number;
  }): Promise<AnnouncementChannelPostRecord[]> {
    const result = await pool.query<AnnouncementChannelPostRecord>(
      `SELECT * FROM (
         SELECT p.*,
                d.public_key_algorithm AS author_device_public_key_algorithm,
                d.public_key_value AS author_device_public_key_value,
                d.encryption_public_key_algorithm AS author_device_encryption_public_key_algorithm,
                d.encryption_public_key_value AS author_device_encryption_public_key_value,
                d.registration_attestation AS author_device_registration_attestation,
                i.public_key_algorithm AS author_identity_public_key_algorithm,
                i.public_key_value AS author_identity_public_key_value
           FROM announcement_channel_posts p
           JOIN devices d ON d.device_id = p.author_device_id
           JOIN identities i ON i.identity_id = p.author_identity_id
          WHERE p.family_id = $1 AND p.channel_id = $2
          ORDER BY p.post_sequence DESC
          LIMIT $3
       ) latest
       ORDER BY latest.post_sequence ASC`,
      [input.familyId, input.channelId, input.limit]
    );
    return result.rows;
  }

  async listPostsBefore(input: {
    familyId: string;
    channelId: string;
    beforeSequence: number;
    limit: number;
  }): Promise<AnnouncementChannelPostRecord[]> {
    const result = await pool.query<AnnouncementChannelPostRecord>(
      `SELECT * FROM (
         SELECT p.*,
                d.public_key_algorithm AS author_device_public_key_algorithm,
                d.public_key_value AS author_device_public_key_value,
                d.encryption_public_key_algorithm AS author_device_encryption_public_key_algorithm,
                d.encryption_public_key_value AS author_device_encryption_public_key_value,
                d.registration_attestation AS author_device_registration_attestation,
                i.public_key_algorithm AS author_identity_public_key_algorithm,
                i.public_key_value AS author_identity_public_key_value
           FROM announcement_channel_posts p
           JOIN devices d ON d.device_id = p.author_device_id
           JOIN identities i ON i.identity_id = p.author_identity_id
          WHERE p.family_id = $1
            AND p.channel_id = $2
            AND p.post_sequence < $3
          ORDER BY p.post_sequence DESC
          LIMIT $4
       ) older
       ORDER BY older.post_sequence ASC`,
      [input.familyId, input.channelId, input.beforeSequence, input.limit]
    );
    return result.rows;
  }

  async listLatestPostActivity(input: {
    familyId: string;
    identityId: string;
    channelIds: string[];
  }): Promise<AnnouncementChannelActivityRecord[]> {
    if (input.channelIds.length === 0) return [];
    const result = await pool.query<AnnouncementChannelActivityRecord>(
      `WITH visible_channels AS (
         SELECT c.channel_id,
                c.owner_identity_id,
                s.last_read_sequence
           FROM announcement_channels c
           LEFT JOIN announcement_channel_subscriptions s
             ON s.family_id = c.family_id
            AND s.channel_id = c.channel_id
            AND s.subscriber_identity_id = $2
          WHERE c.family_id = $1
            AND c.channel_id = ANY($3::text[])
            AND c.status = 'active'
            AND (
              c.owner_identity_id = $2
              OR s.status = 'active'
            )
       )
       SELECT p.*,
              d.public_key_algorithm AS author_device_public_key_algorithm,
              d.public_key_value AS author_device_public_key_value,
              d.encryption_public_key_algorithm AS author_device_encryption_public_key_algorithm,
              d.encryption_public_key_value AS author_device_encryption_public_key_value,
              d.registration_attestation AS author_device_registration_attestation,
              i.public_key_algorithm AS author_identity_public_key_algorithm,
              i.public_key_value AS author_identity_public_key_value,
              CASE
                WHEN visible.owner_identity_id = $2 THEN 0
                ELSE GREATEST(0, p.post_sequence - COALESCE(visible.last_read_sequence, 0))
              END::integer AS unread_count
         FROM visible_channels visible
         JOIN LATERAL (
           SELECT latest.*
             FROM announcement_channel_posts latest
            WHERE latest.family_id = $1
              AND latest.channel_id = visible.channel_id
            ORDER BY latest.post_sequence DESC
            LIMIT 1
         ) p ON TRUE
         JOIN devices d ON d.device_id = p.author_device_id
         JOIN identities i ON i.identity_id = p.author_identity_id`,
      [input.familyId, input.identityId, input.channelIds]
    );
    return result.rows;
  }

  async findPostById(familyId: string, postId: string): Promise<AnnouncementChannelPostRecord | null> {
    const result = await pool.query<AnnouncementChannelPostRecord>(
      `SELECT * FROM announcement_channel_posts WHERE family_id = $1 AND post_id = $2 LIMIT 1`,
      [familyId, postId]
    );
    return result.rows[0] || null;
  }

  async editPost(input: {
    familyId: string;
    channelId: string;
    postId: string;
    ownerIdentityId: string;
    authorDeviceId: string;
    epoch: number;
    ciphertext: string;
    notificationPreviewCiphertext: string | null;
    authorSignature: string;
    authorSignedClaim: unknown;
    expectedRevision: number;
  }): Promise<AnnouncementChannelPostRecord | null> {
    const result = await pool.query<AnnouncementChannelPostRecord>(
      `UPDATE announcement_channel_posts p
          SET ciphertext = $7,
              notification_preview_ciphertext = $8,
              author_signature = $9,
              author_signed_claim = $10::jsonb,
              author_device_id = $11,
              revision = revision + 1,
              edited_at = NOW(),
              updated_at = NOW()
         FROM announcement_channels c
        WHERE p.family_id = $1 AND p.channel_id = $2 AND p.post_id = $3
          AND p.author_identity_id = $4 AND p.epoch = $5 AND p.revision = $6
          AND p.deleted_at IS NULL
          AND c.family_id = p.family_id AND c.channel_id = p.channel_id
          AND c.owner_identity_id = $4 AND c.key_epoch = $5
       RETURNING p.*`,
      [
        input.familyId, input.channelId, input.postId, input.ownerIdentityId,
        input.epoch, input.expectedRevision, input.ciphertext,
        input.notificationPreviewCiphertext, input.authorSignature,
        JSON.stringify(input.authorSignedClaim), input.authorDeviceId,
      ]
    );
    return result.rows[0] || null;
  }

  async markRead(input: {
    familyId: string;
    channelId: string;
    identityId: string;
    sequence: number;
  }): Promise<number | null> {
    const result = await pool.query<{ last_read_sequence: number }>(
      `UPDATE announcement_channel_subscriptions subscription
          SET last_received_sequence = GREATEST(COALESCE(last_received_sequence, 0), $4),
              last_read_sequence = GREATEST(COALESCE(last_read_sequence, 0), $4),
              updated_at = NOW()
         FROM announcement_channels channel
        WHERE subscription.family_id = $1 AND subscription.channel_id = $2
          AND subscription.subscriber_identity_id = $3 AND subscription.status = 'active'
          AND channel.family_id = subscription.family_id
          AND channel.channel_id = subscription.channel_id
          AND $4 <= GREATEST(0, channel.next_post_sequence - 1)
       RETURNING subscription.last_read_sequence`,
      [input.familyId, input.channelId, input.identityId, input.sequence]
    );
    return result.rows[0] ? Number(result.rows[0].last_read_sequence) : null;
  }

  async markReceived(input: {
    familyId: string;
    channelId: string;
    identityId: string;
    sequence: number;
  }): Promise<number | null> {
    const result = await pool.query<{ last_received_sequence: number }>(
      `UPDATE announcement_channel_subscriptions subscription
          SET last_received_sequence = GREATEST(COALESCE(last_received_sequence, 0), $4),
              updated_at = NOW()
         FROM announcement_channels channel
        WHERE subscription.family_id = $1 AND subscription.channel_id = $2
          AND subscription.subscriber_identity_id = $3 AND subscription.status = 'active'
          AND channel.family_id = subscription.family_id
          AND channel.channel_id = subscription.channel_id
          AND $4 <= GREATEST(0, channel.next_post_sequence - 1)
       RETURNING subscription.last_received_sequence`,
      [input.familyId, input.channelId, input.identityId, input.sequence]
    );
    return result.rows[0] ? Number(result.rows[0].last_received_sequence) : null;
  }

  async listPostEngagement(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    sequences: number[];
  }): Promise<Map<number, { receivedCount: number; viewedCount: number }>> {
    if (input.sequences.length === 0) return new Map();
    const result = await pool.query<{
      post_sequence: number;
      received_count: number;
      viewed_count: number;
    }>(
      `SELECT post.post_sequence,
              (
                SELECT COUNT(*)::integer
                  FROM announcement_channel_subscriptions received
                 WHERE received.family_id = $1
                   AND received.channel_id = $2
                   AND received.subscriber_identity_id <> $3
                   AND received.last_received_sequence >= post.post_sequence
              ) AS received_count,
              (
                SELECT COUNT(*)::integer
                  FROM announcement_channel_subscriptions viewed
                 WHERE viewed.family_id = $1
                   AND viewed.channel_id = $2
                   AND viewed.subscriber_identity_id <> $3
                   AND viewed.last_read_sequence >= post.post_sequence
              ) AS viewed_count
         FROM unnest($4::bigint[]) AS post(post_sequence)`,
      [input.familyId, input.channelId, input.ownerIdentityId, input.sequences]
    );
    return new Map(result.rows.map((row) => [
      Number(row.post_sequence),
      { receivedCount: Number(row.received_count), viewedCount: Number(row.viewed_count) },
    ]));
  }

  async listPostEngagementRecipients(input: {
    familyId: string;
    channelId: string;
    ownerIdentityId: string;
    sequence: number;
    afterSubscriberIdentityId?: string | null;
    limit: number;
  }): Promise<AnnouncementChannelPostEngagementRecipientRecord[]> {
    const result = await pool.query<AnnouncementChannelPostEngagementRecipientRecord>(
      `SELECT subscription.subscription_id,
              subscription.subscriber_identity_id,
              identity.identity_name AS subscriber_identity_name,
              subscription.source_link_id,
              subscription.status AS subscription_status,
              COALESCE(subscription.last_received_sequence >= $4, FALSE) AS received,
              COALESCE(subscription.last_read_sequence >= $4, FALSE) AS viewed
         FROM announcement_channel_subscriptions subscription
         JOIN identities identity
           ON identity.family_id = subscription.family_id
          AND identity.identity_id = subscription.subscriber_identity_id
        WHERE subscription.family_id = $1
          AND subscription.channel_id = $2
          AND subscription.subscriber_identity_id <> $3
          AND ($5::text IS NULL OR subscription.subscriber_identity_id > $5)
        ORDER BY subscription.subscriber_identity_id
        LIMIT $6`,
      [
        input.familyId,
        input.channelId,
        input.ownerIdentityId,
        input.sequence,
        input.afterSubscriberIdentityId || null,
        input.limit,
      ]
    );
    return result.rows;
  }
}

export const announcementChannelRepository = new AnnouncementChannelRepository();
