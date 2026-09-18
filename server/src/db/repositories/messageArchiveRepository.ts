import { pool } from '../index';

export interface MessageArchiveJobRecord {
  archive_id: string;
  family_id: string;
  owner_identity_id: string;
  writer_device_id: string;
  destination_type: 'circle';
  destination_config: unknown;
  mode: 'text';
  wrapped_archive_key: unknown | null;
  archive_key_version: number;
  encrypted_manifest: unknown | null;
  manifest_revision: number;
  status: 'active' | 'paused' | 'disabled';
  last_archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageArchiveSegmentRecord {
  segment_id: string;
  archive_id: string;
  period_key: string;
  state: 'current' | 'final';
  revision: number;
  period_started_at: Date | null;
  period_ended_at: Date | null;
  message_count: number;
  byte_size: number;
  encrypted_segment: unknown;
  created_at: Date;
  updated_at: Date;
}

export class MessageArchiveRepository {
  async findJob(familyId: string, ownerIdentityId: string): Promise<MessageArchiveJobRecord | null> {
    const result = await pool.query<MessageArchiveJobRecord>(
      `SELECT *
         FROM message_archive_jobs
        WHERE family_id = $1
          AND owner_identity_id = $2
          AND destination_type = 'circle'
          AND status IN ('active', 'paused')
        ORDER BY created_at DESC
        LIMIT 1`,
      [familyId, ownerIdentityId]
    );
    return result.rows[0] || null;
  }

  async createJob(data: {
    familyId: string;
    ownerIdentityId: string;
    writerDeviceId: string;
    wrappedArchiveKey: unknown;
    encryptedManifest?: unknown | null;
  }): Promise<MessageArchiveJobRecord> {
    const result = await pool.query<MessageArchiveJobRecord>(
      `INSERT INTO message_archive_jobs (
         family_id,
         owner_identity_id,
         writer_device_id,
         destination_type,
         destination_config,
         mode,
         wrapped_archive_key,
         archive_key_version,
         encrypted_manifest,
         manifest_revision,
         status
       )
       VALUES ($1, $2, $3, 'circle', '{"circle":"current"}'::jsonb, 'text', $4::jsonb, 1, $5::jsonb, CASE WHEN $5::jsonb IS NULL THEN 0 ELSE 1 END, 'active')
       RETURNING *`,
      [
        data.familyId,
        data.ownerIdentityId,
        data.writerDeviceId,
        JSON.stringify(data.wrappedArchiveKey),
        data.encryptedManifest == null ? null : JSON.stringify(data.encryptedManifest)
      ]
    );
    return result.rows[0];
  }

  async updateManifest(data: {
    familyId: string;
    archiveId: string;
    ownerIdentityId: string;
    writerDeviceId: string;
    expectedRevision: number;
    encryptedManifest: unknown;
    lastArchivedAt?: Date | null;
  }): Promise<MessageArchiveJobRecord | null> {
    const result = await pool.query<MessageArchiveJobRecord>(
      `UPDATE message_archive_jobs
          SET encrypted_manifest = $6::jsonb,
              manifest_revision = manifest_revision + 1,
              last_archived_at = COALESCE($7::timestamptz, last_archived_at),
              updated_at = NOW()
        WHERE family_id = $1
          AND archive_id = $2
          AND owner_identity_id = $3
          AND writer_device_id = $4
          AND manifest_revision = $5
          AND destination_type = 'circle'
          AND status = 'active'
       RETURNING *`,
      [
        data.familyId,
        data.archiveId,
        data.ownerIdentityId,
        data.writerDeviceId,
        data.expectedRevision,
        JSON.stringify(data.encryptedManifest),
        data.lastArchivedAt ?? null
      ]
    );
    return result.rows[0] || null;
  }

  async disableJob(data: {
    familyId: string;
    archiveId: string;
    ownerIdentityId: string;
  }): Promise<MessageArchiveJobRecord | null> {
    const result = await pool.query<MessageArchiveJobRecord>(
      `UPDATE message_archive_jobs
          SET status = 'disabled',
              updated_at = NOW()
        WHERE family_id = $1
          AND archive_id = $2
          AND owner_identity_id = $3
          AND status IN ('active', 'paused')
       RETURNING *`,
      [data.familyId, data.archiveId, data.ownerIdentityId]
    );
    return result.rows[0] || null;
  }

  async updateWriterDevice(data: {
    familyId: string;
    archiveId: string;
    ownerIdentityId: string;
    nextWriterDeviceId: string;
  }): Promise<MessageArchiveJobRecord | null> {
    const result = await pool.query<MessageArchiveJobRecord>(
      `UPDATE message_archive_jobs
          SET writer_device_id = $4,
              updated_at = NOW()
        WHERE family_id = $1
          AND archive_id = $2
          AND owner_identity_id = $3
          AND destination_type = 'circle'
          AND status = 'active'
       RETURNING *`,
      [
        data.familyId,
        data.archiveId,
        data.ownerIdentityId,
        data.nextWriterDeviceId
      ]
    );
    return result.rows[0] || null;
  }

  async putSegment(data: {
    familyId: string;
    archiveId: string;
    ownerIdentityId: string;
    writerDeviceId: string;
    periodKey: string;
    expectedRevision?: number | null;
    periodStartedAt?: Date | null;
    periodEndedAt?: Date | null;
    messageCount: number;
    byteSize: number;
    encryptedSegment: unknown;
  }): Promise<MessageArchiveSegmentRecord> {
    const result = await pool.query<MessageArchiveSegmentRecord>(
      `INSERT INTO message_archive_segments (
         archive_id,
         family_id,
         owner_identity_id,
         writer_device_id,
         period_key,
         state,
         revision,
         period_started_at,
         period_ended_at,
         message_count,
         byte_size,
         encrypted_segment
       )
       VALUES ($1, $2, $3, $4, $5, 'current', 1, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (archive_id, period_key) DO UPDATE SET
         writer_device_id = EXCLUDED.writer_device_id,
         revision = message_archive_segments.revision + 1,
         period_started_at = EXCLUDED.period_started_at,
         period_ended_at = EXCLUDED.period_ended_at,
         message_count = EXCLUDED.message_count,
         byte_size = EXCLUDED.byte_size,
         encrypted_segment = EXCLUDED.encrypted_segment,
         updated_at = NOW()
       WHERE message_archive_segments.writer_device_id = EXCLUDED.writer_device_id
         AND message_archive_segments.state = 'current'
         AND (
           $11::integer IS NOT NULL
           AND message_archive_segments.revision = $11::integer
         )
       RETURNING segment_id, archive_id, period_key, state, revision, period_started_at, period_ended_at, message_count, byte_size, encrypted_segment, created_at, updated_at`,
      [
        data.archiveId,
        data.familyId,
        data.ownerIdentityId,
        data.writerDeviceId,
        data.periodKey,
        data.periodStartedAt ?? null,
        data.periodEndedAt ?? null,
        data.messageCount,
        data.byteSize,
        JSON.stringify(data.encryptedSegment),
        data.expectedRevision ?? null
      ]
    );
    if (!result.rows[0]) {
      throw new Error('Archive segment revision conflict');
    }
    return result.rows[0];
  }

  async findSegment(data: {
    familyId: string;
    archiveId: string;
    ownerIdentityId: string;
    periodKey: string;
  }): Promise<MessageArchiveSegmentRecord | null> {
    const result = await pool.query<MessageArchiveSegmentRecord>(
      `SELECT segment_id, archive_id, period_key, state, revision, period_started_at, period_ended_at, message_count, byte_size, encrypted_segment, created_at, updated_at
         FROM message_archive_segments
        WHERE family_id = $1
          AND archive_id = $2
          AND owner_identity_id = $3
          AND period_key = $4
        LIMIT 1`,
      [
        data.familyId,
        data.archiveId,
        data.ownerIdentityId,
        data.periodKey
      ]
    );
    return result.rows[0] || null;
  }

  async getArchiveByteSize(data: {
    familyId: string;
    archiveId: string;
    ownerIdentityId: string;
  }): Promise<number> {
    const result = await pool.query<{ byte_size: string | number | null }>(
      `SELECT COALESCE(SUM(byte_size), 0)::bigint AS byte_size
         FROM message_archive_segments
        WHERE family_id = $1
          AND archive_id = $2
          AND owner_identity_id = $3`,
      [data.familyId, data.archiveId, data.ownerIdentityId]
    );
    return Math.max(0, Number(result.rows[0]?.byte_size || 0));
  }

  async finalizeSegment(data: {
    familyId: string;
    archiveId: string;
    ownerIdentityId: string;
    writerDeviceId: string;
    periodKey: string;
    expectedRevision: number;
  }): Promise<MessageArchiveSegmentRecord | null> {
    const result = await pool.query<MessageArchiveSegmentRecord>(
      `UPDATE message_archive_segments
          SET state = 'final',
              revision = revision + 1,
              updated_at = NOW()
        WHERE family_id = $1
          AND archive_id = $2
          AND owner_identity_id = $3
          AND writer_device_id = $4
          AND period_key = $5
          AND revision = $6
          AND state = 'current'
       RETURNING segment_id, archive_id, period_key, state, revision, period_started_at, period_ended_at, message_count, byte_size, encrypted_segment, created_at, updated_at`,
      [
        data.familyId,
        data.archiveId,
        data.ownerIdentityId,
        data.writerDeviceId,
        data.periodKey,
        data.expectedRevision
      ]
    );
    return result.rows[0] || null;
  }

  async listSegments(data: {
    familyId: string;
    archiveId: string;
    ownerIdentityId: string;
    afterPeriodKey?: string | null;
    limit: number;
  }): Promise<MessageArchiveSegmentRecord[]> {
    const result = await pool.query<MessageArchiveSegmentRecord>(
      `SELECT segment_id, archive_id, period_key, state, revision, period_started_at, period_ended_at, message_count, byte_size, encrypted_segment, created_at, updated_at
         FROM message_archive_segments
        WHERE family_id = $1
          AND archive_id = $2
          AND owner_identity_id = $3
          AND period_key > $4
        ORDER BY period_key ASC
        LIMIT $5`,
      [
        data.familyId,
        data.archiveId,
        data.ownerIdentityId,
        data.afterPeriodKey ?? '',
        data.limit
      ]
    );
    return result.rows;
  }
}

export const messageArchiveRepository = new MessageArchiveRepository();
