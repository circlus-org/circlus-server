import type { PoolClient } from 'pg';
import { pool, query } from '../index';

export type CircleSitePublicationStatus = 'draft' | 'published' | 'unpublished' | 'deleted';
export type CircleSitePublicationBodyFormat = 'plain_text' | 'markdown';

export interface DBCircleSitePublication {
  publication_id: string;
  family_id: string;
  channel_id: string;
  source_link_id: string | null;
  source_channel_post_id: string;
  author_identity_id: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string;
  body_format: CircleSitePublicationBodyFormat;
  status: CircleSitePublicationStatus;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class CircleSitePublicationRepository {
  async create(input: {
    familyId: string;
    channelId: string;
    sourceLinkId?: string | null;
    sourceChannelPostId: string;
    authorIdentityId: string;
    slug: string;
    title: string;
    summary?: string | null;
    body: string;
    bodyFormat: CircleSitePublicationBodyFormat;
  }, client?: PoolClient): Promise<DBCircleSitePublication> {
    const result = await (client || pool).query<DBCircleSitePublication>(
      `INSERT INTO circle_site_publications (
         family_id, channel_id, source_link_id, source_channel_post_id,
         author_identity_id, slug, title, summary, body, body_format,
         status, published_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'published', NOW())
       RETURNING *`,
      [
        input.familyId,
        input.channelId,
        input.sourceLinkId ?? null,
        input.sourceChannelPostId,
        input.authorIdentityId,
        input.slug,
        input.title,
        input.summary ?? null,
        input.body,
        input.bodyFormat,
      ]
    );
    return result.rows[0];
  }

  async findById(familyId: string, publicationId: string): Promise<DBCircleSitePublication | null> {
    const result = await query<DBCircleSitePublication>(
      `SELECT * FROM circle_site_publications WHERE family_id = $1 AND publication_id = $2 LIMIT 1`,
      [familyId, publicationId]
    );
    return result.rows[0] || null;
  }

  async findBySlug(familyId: string, slug: string): Promise<DBCircleSitePublication | null> {
    const result = await query<DBCircleSitePublication>(
      `SELECT * FROM circle_site_publications WHERE family_id = $1 AND slug = $2 LIMIT 1`,
      [familyId, slug]
    );
    return result.rows[0] || null;
  }

  async findBySourceChannelPostForUpdate(
    familyId: string,
    sourceChannelPostId: string,
    client: PoolClient
  ): Promise<DBCircleSitePublication | null> {
    const result = await client.query<DBCircleSitePublication>(
      `SELECT * FROM circle_site_publications
       WHERE family_id = $1 AND source_channel_post_id = $2
       LIMIT 1
       FOR UPDATE`,
      [familyId, sourceChannelPostId]
    );
    return result.rows[0] || null;
  }

  async listPublishedSourceChannelPostLinks(
    familyId: string,
    postIds: string[]
  ): Promise<Array<Pick<DBCircleSitePublication, 'source_channel_post_id' | 'slug' | 'body_format'>>> {
    if (postIds.length === 0) return [];
    const result = await query<Pick<DBCircleSitePublication, 'source_channel_post_id' | 'slug' | 'body_format'>>(
      `SELECT source_channel_post_id, slug, body_format FROM circle_site_publications
       WHERE family_id = $1
         AND source_channel_post_id = ANY($2::text[])
         AND status = 'published'`,
      [familyId, postIds]
    );
    return result.rows;
  }

  async listPublishedByFamily(familyId: string): Promise<DBCircleSitePublication[]> {
    const result = await query<DBCircleSitePublication>(
      `SELECT * FROM circle_site_publications
       WHERE family_id = $1 AND status = 'published'
       ORDER BY published_at DESC`,
      [familyId]
    );
    return result.rows;
  }

  async listPublishedByLink(familyId: string, linkId: string): Promise<DBCircleSitePublication[]> {
    const result = await query<DBCircleSitePublication>(
      `SELECT * FROM circle_site_publications
       WHERE family_id = $1 AND source_link_id = $2 AND status = 'published'
       ORDER BY published_at DESC`,
      [familyId, linkId]
    );
    return result.rows;
  }

  async listPublishedByChannel(familyId: string, channelId: string): Promise<DBCircleSitePublication[]> {
    const result = await query<DBCircleSitePublication>(
      `SELECT * FROM circle_site_publications
       WHERE family_id = $1 AND channel_id = $2 AND status = 'published'
       ORDER BY published_at DESC`,
      [familyId, channelId]
    );
    return result.rows;
  }

  async listAllByFamily(familyId: string): Promise<DBCircleSitePublication[]> {
    const result = await query<DBCircleSitePublication>(
      `SELECT * FROM circle_site_publications
       WHERE family_id = $1
       ORDER BY created_at DESC`,
      [familyId]
    );
    return result.rows;
  }

  async update(
    familyId: string,
    publicationId: string,
    fields: { title?: string; summary?: string | null; body?: string; bodyFormat?: CircleSitePublicationBodyFormat },
    client?: PoolClient
  ): Promise<DBCircleSitePublication | null> {
    const result = await (client || pool).query<DBCircleSitePublication>(
      `UPDATE circle_site_publications
       SET title = COALESCE($3, title),
           summary = CASE WHEN $4::boolean THEN $5 ELSE summary END,
           body = COALESCE($6, body),
           body_format = COALESCE($7, body_format),
           updated_at = NOW()
       WHERE family_id = $1 AND publication_id = $2
       RETURNING *`,
      [
        familyId,
        publicationId,
        fields.title ?? null,
        fields.summary !== undefined,
        fields.summary ?? null,
        fields.body ?? null,
        fields.bodyFormat ?? null,
      ]
    );
    return result.rows[0] || null;
  }

  async setStatus(
    familyId: string,
    publicationId: string,
    status: CircleSitePublicationStatus,
    client?: PoolClient
  ): Promise<DBCircleSitePublication | null> {
    const result = await (client || pool).query<DBCircleSitePublication>(
      `UPDATE circle_site_publications
       SET status = $3,
           published_at = CASE WHEN $3 = 'published' THEN NOW() ELSE published_at END,
           updated_at = NOW()
       WHERE family_id = $1 AND publication_id = $2
       RETURNING *`,
      [familyId, publicationId, status]
    );
    return result.rows[0] || null;
  }
}

export const circleSitePublicationRepository = new CircleSitePublicationRepository();
