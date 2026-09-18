import type { PoolClient } from 'pg';
import { getClient, pool, transaction } from '../index';
import type { CircleSiteAssetKind } from '../../../../shared/circleSiteAssets';

export type CircleSitePublicationAssetKind = CircleSiteAssetKind;
export type CircleSitePublicationAssetStatus = 'reserved' | 'ready' | 'published' | 'deleted';
export type CircleSiteImageSlot = 'cover' | 'channel_intro';

export type CircleSitePublicationAssetRecord = {
  asset_id: string;
  family_id: string;
  publication_id: string | null;
  source_channel_post_id: string | null;
  site_image_slot: CircleSiteImageSlot | null;
  site_image_channel_id: string | null;
  uploader_identity_id: string;
  kind: CircleSitePublicationAssetKind;
  original_file_name: string;
  mime_type: string;
  size_bytes: number | string;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  storage_key: string;
  upload_token_hash: string | null;
  reserved_until: Date | null;
  status: CircleSitePublicationAssetStatus;
  uploaded_at: Date | null;
  published_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function normalizeAsset(row: CircleSitePublicationAssetRecord): CircleSitePublicationAssetRecord {
  return {
    ...row,
    size_bytes: Number(row.size_bytes),
    status: row.status as CircleSitePublicationAssetStatus,
    kind: row.kind as CircleSitePublicationAssetKind,
  };
}

export class CircleSitePublicationAssetRepository {
  async createReservation(input: {
    assetId: string;
    familyId: string;
    sourceChannelPostId: string;
    uploaderIdentityId: string;
    kind: CircleSitePublicationAssetKind;
    originalFileName: string;
    mimeType: string;
    sizeBytes: number;
    width?: number | null;
    height?: number | null;
    altText?: string | null;
    storageKey: string;
    uploadTokenHash: string;
    reservedUntil: Date;
  }): Promise<CircleSitePublicationAssetRecord> {
    return transaction(async client => {
      const inserted = await client.query<CircleSitePublicationAssetRecord>(
        `INSERT INTO circle_site_publication_assets (
           asset_id, family_id, source_channel_post_id, uploader_identity_id,
           kind, original_file_name, mime_type, size_bytes, width, height,
           alt_text, storage_key, upload_token_hash, reserved_until, status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'reserved'
         )
         RETURNING *`,
        [
          input.assetId,
          input.familyId,
          input.sourceChannelPostId,
          input.uploaderIdentityId,
          input.kind,
          input.originalFileName,
          input.mimeType,
          input.sizeBytes,
          input.width ?? null,
          input.height ?? null,
          input.altText ?? null,
          input.storageKey,
          input.uploadTokenHash,
          input.reservedUntil,
        ]
      );
      await client.query(
        `UPDATE family_config
            SET reserved_attachment_storage_bytes = reserved_attachment_storage_bytes + $2,
                updated_at = NOW()
          WHERE family_id = $1`,
        [input.familyId, input.sizeBytes]
      );
      return normalizeAsset(inserted.rows[0]);
    });
  }

  async createSiteImageReservation(input: {
    assetId: string;
    familyId: string;
    uploaderIdentityId: string;
    slot: CircleSiteImageSlot;
    channelId?: string | null;
    originalFileName: string;
    mimeType: string;
    sizeBytes: number;
    width?: number | null;
    height?: number | null;
    storageKey: string;
    uploadTokenHash: string;
    reservedUntil: Date;
  }): Promise<CircleSitePublicationAssetRecord> {
    return transaction(async client => {
      const inserted = await client.query<CircleSitePublicationAssetRecord>(
        `INSERT INTO circle_site_publication_assets (
           asset_id, family_id, source_channel_post_id, site_image_slot,
           site_image_channel_id, uploader_identity_id, kind,
           original_file_name, mime_type, size_bytes, width, height,
           storage_key, upload_token_hash, reserved_until, status
         ) VALUES (
           $1, $2, NULL, $3, $4, $5, 'image', $6, $7, $8, $9, $10,
           $11, $12, $13, 'reserved'
         )
         RETURNING *`,
        [
          input.assetId,
          input.familyId,
          input.slot,
          input.channelId ?? null,
          input.uploaderIdentityId,
          input.originalFileName,
          input.mimeType,
          input.sizeBytes,
          input.width ?? null,
          input.height ?? null,
          input.storageKey,
          input.uploadTokenHash,
          input.reservedUntil,
        ]
      );
      await client.query(
        `UPDATE family_config
            SET reserved_attachment_storage_bytes = reserved_attachment_storage_bytes + $2,
                updated_at = NOW()
          WHERE family_id = $1`,
        [input.familyId, input.sizeBytes]
      );
      return normalizeAsset(inserted.rows[0]);
    });
  }

  async findById(familyId: string, assetId: string): Promise<CircleSitePublicationAssetRecord | null> {
    const result = await pool.query<CircleSitePublicationAssetRecord>(
      `SELECT *
         FROM circle_site_publication_assets
        WHERE family_id = $1 AND asset_id = $2
        LIMIT 1`,
      [familyId, assetId]
    );
    return result.rows[0] ? normalizeAsset(result.rows[0]) : null;
  }

  async markReady(input: {
    familyId: string;
    assetId: string;
    sizeBytes: number;
  }): Promise<CircleSitePublicationAssetRecord | null> {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query<CircleSitePublicationAssetRecord>(
        `SELECT *
           FROM circle_site_publication_assets
          WHERE family_id = $1 AND asset_id = $2
          FOR UPDATE`,
        [input.familyId, input.assetId]
      );
      const asset = locked.rows[0];
      if (!asset || asset.status !== 'reserved' || Number(asset.size_bytes) !== input.sizeBytes) {
        await client.query('ROLLBACK');
        return null;
      }
      const updated = await client.query<CircleSitePublicationAssetRecord>(
        `UPDATE circle_site_publication_assets
            SET status = 'ready',
                upload_token_hash = NULL,
                reserved_until = NULL,
                uploaded_at = NOW(),
                updated_at = NOW()
          WHERE family_id = $1 AND asset_id = $2
          RETURNING *`,
        [input.familyId, input.assetId]
      );
      await client.query(
        `UPDATE family_config
            SET reserved_attachment_storage_bytes = GREATEST(0, reserved_attachment_storage_bytes - $2),
                used_attachment_storage_bytes = used_attachment_storage_bytes + $2,
                updated_at = NOW()
          WHERE family_id = $1`,
        [input.familyId, input.sizeBytes]
      );
      await client.query('COMMIT');
      return updated.rows[0] ? normalizeAsset(updated.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async publishSiteImage(input: {
    familyId: string;
    assetId: string;
    sizeBytes: number;
  }): Promise<CircleSitePublicationAssetRecord | null> {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query<CircleSitePublicationAssetRecord>(
        `SELECT *
           FROM circle_site_publication_assets
          WHERE family_id = $1 AND asset_id = $2
          FOR UPDATE`,
        [input.familyId, input.assetId]
      );
      const asset = locked.rows[0];
      if (
        !asset
        || asset.status !== 'reserved'
        || Number(asset.size_bytes) !== input.sizeBytes
        || !asset.site_image_slot
      ) {
        await client.query('ROLLBACK');
        return null;
      }

      const lockKey = `${input.familyId}:${asset.site_image_slot}:${asset.site_image_channel_id || ''}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      const replaced = await client.query<CircleSitePublicationAssetRecord>(
        `UPDATE circle_site_publication_assets
            SET status = 'deleted',
                deleted_at = NOW(),
                updated_at = NOW()
          WHERE family_id = $1
            AND site_image_slot = $2
            AND site_image_channel_id IS NOT DISTINCT FROM $3
            AND status = 'published'
          RETURNING *`,
        [input.familyId, asset.site_image_slot, asset.site_image_channel_id]
      );
      const replacedBytes = replaced.rows.reduce((total, row) => total + Number(row.size_bytes), 0);

      const imageUrl = `/site-images/${encodeURIComponent(asset.asset_id)}/${encodeURIComponent(asset.original_file_name)}`;
      if (asset.site_image_slot === 'cover') {
        await client.query(
          `INSERT INTO circle_site_settings (family_id, cover_image_url)
           VALUES ($1, $2)
           ON CONFLICT (family_id) DO UPDATE
             SET cover_image_url = EXCLUDED.cover_image_url,
                 updated_at = NOW()`,
          [input.familyId, imageUrl]
        );
      } else {
        const updatedChannel = await client.query(
          `UPDATE announcement_channels
              SET public_site_intro_image_url = $3,
                  updated_at = NOW()
            WHERE family_id = $1 AND channel_id = $2
            RETURNING channel_id`,
          [input.familyId, asset.site_image_channel_id, imageUrl]
        );
        if (updatedChannel.rows.length !== 1) {
          await client.query('ROLLBACK');
          return null;
        }
      }

      const updated = await client.query<CircleSitePublicationAssetRecord>(
        `UPDATE circle_site_publication_assets
            SET status = 'published',
                upload_token_hash = NULL,
                reserved_until = NULL,
                uploaded_at = NOW(),
                published_at = NOW(),
                updated_at = NOW()
          WHERE family_id = $1 AND asset_id = $2
          RETURNING *`,
        [input.familyId, input.assetId]
      );
      await client.query(
        `UPDATE family_config
            SET reserved_attachment_storage_bytes = GREATEST(0, reserved_attachment_storage_bytes - $2),
                used_attachment_storage_bytes = GREATEST(0, used_attachment_storage_bytes + $2 - $3),
                updated_at = NOW()
          WHERE family_id = $1`,
        [input.familyId, input.sizeBytes, replacedBytes]
      );
      await client.query('COMMIT');
      return updated.rows[0] ? normalizeAsset(updated.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async removeSiteImage(input: {
    familyId: string;
    slot: CircleSiteImageSlot;
    channelId?: string | null;
  }): Promise<CircleSitePublicationAssetRecord | null> {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const lockKey = `${input.familyId}:${input.slot}:${input.channelId || ''}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      const removed = await client.query<CircleSitePublicationAssetRecord>(
        `UPDATE circle_site_publication_assets
            SET status = 'deleted',
                deleted_at = NOW(),
                updated_at = NOW()
          WHERE family_id = $1
            AND site_image_slot = $2
            AND site_image_channel_id IS NOT DISTINCT FROM $3
            AND status = 'published'
          RETURNING *`,
        [input.familyId, input.slot, input.channelId ?? null]
      );
      if (input.slot === 'cover') {
        await client.query(
          `UPDATE circle_site_settings
              SET cover_image_url = NULL,
                  updated_at = NOW()
            WHERE family_id = $1`,
          [input.familyId]
        );
      } else {
        await client.query(
          `UPDATE announcement_channels
              SET public_site_intro_image_url = NULL,
                  updated_at = NOW()
            WHERE family_id = $1 AND channel_id = $2`,
          [input.familyId, input.channelId]
        );
      }
      const removedBytes = removed.rows.reduce((total, row) => total + Number(row.size_bytes), 0);
      if (removedBytes > 0) {
        await client.query(
          `UPDATE family_config
              SET used_attachment_storage_bytes = GREATEST(0, used_attachment_storage_bytes - $2),
                  updated_at = NOW()
            WHERE family_id = $1`,
          [input.familyId, removedBytes]
        );
      }
      await client.query('COMMIT');
      return removed.rows[0] ? normalizeAsset(removed.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Replaces the complete public asset set for a publication.
   *
   * Returns null when at least one requested asset is unavailable. The caller
   * owns the transaction so publication state and assets can commit atomically.
   * An empty assetIds array is a valid replacement and deletes every previous
   * public copy.
   */
  async replaceForPublication(input: {
    familyId: string;
    publicationId: string;
    sourceChannelPostId: string;
    uploaderIdentityId: string;
    assetIds: string[];
  }, client: PoolClient): Promise<CircleSitePublicationAssetRecord[] | null> {
    const result = input.assetIds.length > 0
      ? await client.query<CircleSitePublicationAssetRecord>(
          `UPDATE circle_site_publication_assets
            SET publication_id = $2,
                status = 'published',
                published_at = COALESCE(published_at, NOW()),
                updated_at = NOW()
          WHERE family_id = $1
            AND asset_id = ANY($3::text[])
            AND source_channel_post_id = $4
            AND uploader_identity_id = $5
            AND kind IN ('image', 'download')
            AND status IN ('ready', 'published')
            AND (publication_id IS NULL OR publication_id = $2)
          RETURNING *`,
          [
            input.familyId,
            input.publicationId,
            input.assetIds,
            input.sourceChannelPostId,
            input.uploaderIdentityId,
          ]
        )
      : { rows: [] as CircleSitePublicationAssetRecord[] };
    if (result.rows.length !== input.assetIds.length) {
      return null;
    }

    // The requested list is the complete desired state. In particular, an
    // empty list removes every previously published asset.
    const replaced = await client.query<{ size_bytes: number | string }>(
      `UPDATE circle_site_publication_assets
            SET status = 'deleted',
                deleted_at = NOW(),
                updated_at = NOW()
          WHERE family_id = $1
            AND publication_id = $2
            AND status = 'published'
            AND NOT (asset_id = ANY($3::text[]))
          RETURNING size_bytes`,
      [input.familyId, input.publicationId, input.assetIds]
    );
    const replacedBytes = replaced.rows.reduce(
      (total, row) => total + Number(row.size_bytes),
      0
    );
    if (replacedBytes > 0) {
      await client.query(
        `UPDATE family_config
            SET used_attachment_storage_bytes = GREATEST(0, used_attachment_storage_bytes - $2),
                updated_at = NOW()
          WHERE family_id = $1`,
        [input.familyId, replacedBytes]
      );
    }
    return result.rows.map(normalizeAsset);
  }

  async listByPublication(
    familyId: string,
    publicationId: string
  ): Promise<CircleSitePublicationAssetRecord[]> {
    const result = await pool.query<CircleSitePublicationAssetRecord>(
      `SELECT *
         FROM circle_site_publication_assets
        WHERE family_id = $1
          AND publication_id = $2
          AND status = 'published'
          AND (
            kind = 'download'
            OR (kind = 'image' AND mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
          )
        ORDER BY created_at ASC`,
      [familyId, publicationId]
    );
    return result.rows.map(normalizeAsset);
  }

  async findPublicAsset(
    familyId: string,
    assetId: string
  ): Promise<CircleSitePublicationAssetRecord | null> {
    const result = await pool.query<CircleSitePublicationAssetRecord>(
      `SELECT asset.*
         FROM circle_site_publication_assets asset
         JOIN circle_site_publications publication
           ON publication.family_id = asset.family_id
          AND publication.publication_id = asset.publication_id
        WHERE asset.family_id = $1
          AND asset.asset_id = $2
          AND asset.status = 'published'
          AND (
            asset.kind = 'download'
            OR (asset.kind = 'image' AND asset.mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
          )
          AND publication.status = 'published'
        LIMIT 1`,
      [familyId, assetId]
    );
    return result.rows[0] ? normalizeAsset(result.rows[0]) : null;
  }

  async findPublicSiteImage(
    familyId: string,
    assetId: string
  ): Promise<CircleSitePublicationAssetRecord | null> {
    const result = await pool.query<CircleSitePublicationAssetRecord>(
      `SELECT *
         FROM circle_site_publication_assets
        WHERE family_id = $1
          AND asset_id = $2
          AND site_image_slot IS NOT NULL
          AND kind = 'image'
          AND mime_type IN ('image/jpeg', 'image/png', 'image/webp')
          AND status = 'published'
        LIMIT 1`,
      [familyId, assetId]
    );
    return result.rows[0] ? normalizeAsset(result.rows[0]) : null;
  }

  async claimExpiredUnpublishedAssets(params: {
    now: Date;
    readyCutoff: Date;
  }): Promise<CircleSitePublicationAssetRecord[]> {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const selected = await client.query<CircleSitePublicationAssetRecord>(
        `SELECT *
           FROM circle_site_publication_assets
          WHERE status = 'deleted'
             OR (
                  status = 'reserved'
                  AND reserved_until IS NOT NULL
                  AND reserved_until < $1
                )
             OR (
                  status = 'ready'
                  AND publication_id IS NULL
                  AND uploaded_at IS NOT NULL
                  AND uploaded_at < $2
                )
          FOR UPDATE SKIP LOCKED`,
        [params.now, params.readyCutoff]
      );
      if (selected.rows.length === 0) {
        await client.query('COMMIT');
        return [];
      }

      const assetIds = selected.rows.map((row) => row.asset_id);
      await client.query(
        `UPDATE circle_site_publication_assets
            SET status = 'deleted',
                upload_token_hash = NULL,
                reserved_until = NULL,
                deleted_at = NOW(),
                updated_at = NOW()
          WHERE asset_id = ANY($1::text[])
            AND status <> 'deleted'`,
        [assetIds]
      );

      const quotaByFamily = new Map<string, { reserved: number; used: number }>();
      for (const row of selected.rows) {
        const quota = quotaByFamily.get(row.family_id) || { reserved: 0, used: 0 };
        if (row.status === 'reserved') quota.reserved += Number(row.size_bytes);
        else if (row.status === 'ready') quota.used += Number(row.size_bytes);
        quotaByFamily.set(row.family_id, quota);
      }
      for (const [familyId, quota] of quotaByFamily) {
        await client.query(
          `UPDATE family_config
              SET reserved_attachment_storage_bytes = GREATEST(0, reserved_attachment_storage_bytes - $2),
                  used_attachment_storage_bytes = GREATEST(0, used_attachment_storage_bytes - $3),
                  updated_at = NOW()
            WHERE family_id = $1`,
          [familyId, quota.reserved, quota.used]
        );
      }
      await client.query('COMMIT');
      return selected.rows.map(normalizeAsset);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteClaimedAsset(assetId: string): Promise<void> {
    await pool.query(
      `DELETE FROM circle_site_publication_assets
        WHERE asset_id = $1 AND status = 'deleted'`,
      [assetId]
    );
  }
}

export const circleSitePublicationAssetRepository = new CircleSitePublicationAssetRepository();
