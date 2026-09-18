import { pool, query } from '../index';
import type { IdentityId } from '@shared/types';
import { getFeaturePolicyRuntimeConfig } from '../../config/serverRuntimeConfig';

import type {
  FindByIdentityIdResult,
  CreateIdentityParams,
  FindPublishedIdentitiesParams,
  FindPublishedIdentitiesResult,
} from './identityRepository.queries';

import {
  findByIdentityId,
  findByPublicKey,
  createIdentity,
  updateStatus,
  countIdentities,
  findByStatus,
  findByRole,
  findAllIdentities,
  findPublishedIdentities,
  updateRole as updateRoleQuery,
  updateStatusText,
} from './identityRepository.queries';

export class IdentityRepository {
  /**
   * Find identity by identity_id (identityId)
   */
  async findByIdentityId(familyId: string, identityId: IdentityId): Promise<FindByIdentityIdResult | null> {
    const results = await findByIdentityId.run({ familyId, identityId }, pool);
    return results[0] || null;
  }

  async findByIdentityIds(familyId: string, identityIds: IdentityId[]): Promise<FindByIdentityIdResult[]> {
    if (identityIds.length === 0) return [];

    const result = await pool.query<FindByIdentityIdResult>(
      `SELECT *
       FROM identities
       WHERE family_id = $1
         AND identity_id = ANY($2::text[])`,
      [familyId, identityIds]
    );
    return result.rows;
  }

  /**
   * Find identity by public key value
   */
  async findByPublicKey(familyId: string, publicKeyValue: string): Promise<FindByIdentityIdResult | null> {
    const results = await findByPublicKey.run({ familyId, publicKeyValue }, pool);
    return results[0] || null;
  }

  /**
   * Create new identity
   */
  async create(data: {
    familyId: string;
    identityId: IdentityId;
    publicKeyAlgorithm: 'ed25519' | 'x25519';
    publicKeyValue: string;
    encryptedPrivateKey: any;
    role?: 'owner' | 'member' | 'guest';
    publishIdentity?: boolean;
    identityName?: string | null;
  }): Promise<FindByIdentityIdResult> {
    const params: CreateIdentityParams & { familyId: string } = {
      familyId: data.familyId,
      identityId: data.identityId,
      publicKeyAlgorithm: data.publicKeyAlgorithm,
      publicKeyValue: data.publicKeyValue,
      encryptedPrivateKey: data.encryptedPrivateKey,
      role: data.role || 'member',
      publishIdentity: data.publishIdentity ?? false,
      identityName: data.identityName || null,
    };
    const results = await createIdentity.run(params, pool);
    return results[0];
  }

  /**
   * Find published identities for a family
   */
  async findPublished(familyId: string): Promise<FindPublishedIdentitiesResult[]> {
    const params: FindPublishedIdentitiesParams & { familyId: string } = { familyId };
    return await findPublishedIdentities.run(params, pool);
  }

  /**
   * Update identity status
   */
  async updateStatus(
    familyId: string,
    identityId: IdentityId,
    status: 'active' | 'disabled'
  ): Promise<FindByIdentityIdResult> {
    const results = await updateStatus.run({ familyId, identityId, status }, pool);
    return results[0];
  }

  /**
   * Update identity role
   */
  async updateRole(
    familyId: string,
    identityId: IdentityId,
    role: 'owner' | 'member' | 'guest'
  ): Promise<FindByIdentityIdResult> {
    const results = await updateRoleQuery.run({ familyId, identityId, role }, pool);
    return results[0];
  }

  /**
   * Count total identities
   */
  async count(familyId: string): Promise<number> {
    const results = await countIdentities.run({ familyId }, pool);
    return parseInt(results[0].count ?? '0', 10);
  }

  /**
   * Find identities by status
   */
  async findByStatus(familyId: string, status: 'active' | 'disabled' | 'removed'): Promise<FindByIdentityIdResult[]> {
    return await findByStatus.run({ familyId, status }, pool);
  }

  /**
   * Find identities by role
   */
  async findByRole(familyId: string, role: string): Promise<FindByIdentityIdResult[]> {
    return await findByRole.run({ familyId, role }, pool);
  }

  /**
   * Find all identities
   */
  async findAll(familyId: string): Promise<FindByIdentityIdResult[]> {
    return await findAllIdentities.run({ familyId }, pool);
  }

  /**
   * Update user status text
   */
  async updateStatusText(
    familyId: string,
    identityId: IdentityId,
    statusText: string | null
  ): Promise<void> {
    await updateStatusText.run({ familyId, identityId, statusText }, pool);
  }

  /**
   * Get statuses and presence for multiple identities.
   * Presence is updated only by the explicit foreground heartbeat. Technical
   * device activity remains in devices.last_seen_at for lifecycle policies.
   */
  async getStatuses(familyId: string, identityIds: IdentityId[]): Promise<Map<IdentityId, {
    statusText: string | null;
    statusUpdatedAt: Date | null;
    avatarBlobId: string | null;
    presenceVisible: boolean;
    lastSeenAt: Date | null;
    onlineUntil: Date | null;
    isOnline: boolean;
  }>> {
    if (identityIds.length === 0) {
      return new Map();
    }

    const onlineWindowSeconds = getFeaturePolicyRuntimeConfig().presence.onlineWindowSeconds;

    const result = await query<{
      identity_id: string;
      status_text: string | null;
      status_updated_at: Date | null;
      avatar_blob_id: string | null;
      presence_visible: boolean;
      last_seen_at: Date | null;
      online_until: Date | null;
      is_online: boolean;
    }>(
      `WITH requested AS (
         SELECT UNNEST($1::text[]) AS identity_id
       )
       SELECT i.identity_id,
              i.status_text,
              i.status_updated_at,
              i.avatar_blob_id,
              i.presence_visible,
              CASE WHEN i.presence_visible THEN i.presence_last_seen_at ELSE NULL END AS last_seen_at,
              CASE
                WHEN NOT i.presence_visible OR i.presence_last_seen_at IS NULL THEN NULL
                ELSE i.presence_last_seen_at + ($3::int * INTERVAL '1 second')
              END AS online_until,
              CASE
                WHEN NOT i.presence_visible THEN FALSE
                ELSE COALESCE(i.presence_last_seen_at >= NOW() - ($3::int * INTERVAL '1 second'), FALSE)
              END AS is_online
       FROM requested r
       JOIN identities i
         ON i.identity_id = r.identity_id
        AND i.family_id = $2`,
      [identityIds, familyId, onlineWindowSeconds]
    );

    const statusMap = new Map<IdentityId, {
      statusText: string | null;
      statusUpdatedAt: Date | null;
      avatarBlobId: string | null;
      presenceVisible: boolean;
      lastSeenAt: Date | null;
      onlineUntil: Date | null;
      isOnline: boolean;
    }>();
    for (const row of result.rows) {
      statusMap.set(row.identity_id as IdentityId, {
        statusText: row.status_text,
        statusUpdatedAt: row.status_updated_at,
        avatarBlobId: row.avatar_blob_id,
        presenceVisible: row.presence_visible,
        lastSeenAt: row.last_seen_at,
        onlineUntil: row.online_until,
        isOnline: row.is_online,
      });
    }

    return statusMap;
  }

  /**
   * Set avatar blob for an identity
   */
  async setAvatar(familyId: string, identityId: IdentityId, blobId: string | null): Promise<void> {
    await query(
      `UPDATE identities
       SET avatar_blob_id = $1, avatar_updated_at = NOW()
       WHERE identity_id = $2 AND family_id = $3`,
      [blobId, identityId, familyId]
    );
  }

  /**
   * Find avatar blob_id for an identity (for public avatar endpoint)
   */
  async findAvatarBlobId(familyId: string, identityId: string): Promise<string | null> {
    const result = await query<{ avatar_blob_id: string | null }>(
      `SELECT avatar_blob_id FROM identities WHERE identity_id = $1 AND family_id = $2`,
      [identityId, familyId]
    );
    return result.rows[0]?.avatar_blob_id ?? null;
  }

  async updatePresenceVisible(familyId: string, identityId: IdentityId, presenceVisible: boolean): Promise<boolean> {
    const result = await query<{ presence_visible: boolean }>(
      `UPDATE identities
       SET presence_visible = $1
       WHERE identity_id = $2 AND family_id = $3
       RETURNING presence_visible`,
      [presenceVisible, identityId, familyId]
    );
    return result.rows[0]?.presence_visible ?? presenceVisible;
  }

  async touchForegroundPresence(familyId: string, identityId: IdentityId): Promise<Date | null> {
    const result = await query<{ presence_last_seen_at: Date }>(
      `UPDATE identities
       SET presence_last_seen_at = NOW()
       WHERE identity_id = $1 AND family_id = $2 AND status = 'active'
       RETURNING presence_last_seen_at`,
      [identityId, familyId]
    );
    return result.rows[0]?.presence_last_seen_at ?? null;
  }

  async touchForegroundPresenceAt(
    familyId: string,
    identityId: IdentityId,
    activityAt: Date
  ): Promise<Date | null> {
    const result = await query<{ presence_last_seen_at: Date }>(
      `UPDATE identities
       SET presence_last_seen_at = GREATEST(
         COALESCE(presence_last_seen_at, $3::timestamp),
         $3::timestamp
       )
       WHERE identity_id = $1 AND family_id = $2 AND status = 'active'
       RETURNING presence_last_seen_at`,
      [identityId, familyId, activityAt]
    );
    return result.rows[0]?.presence_last_seen_at ?? null;
  }

}

export const identityRepository = new IdentityRepository();
