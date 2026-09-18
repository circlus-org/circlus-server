import { pool } from '../index';

export type AnnouncementChannelPushOutboxRecord = {
  post_id: string;
  family_id: string;
  channel_id: string;
  author_identity_id: string;
  cursor_identity_id: string | null;
  status: 'pending' | 'processing' | 'completed';
  attempts: number;
  available_at: Date;
  locked_at: Date | null;
  last_error: string | null;
  created_at: Date;
  completed_at: Date | null;
};

class AnnouncementChannelPushOutboxRepository {
  async claimNext(): Promise<AnnouncementChannelPushOutboxRecord | null> {
    const result = await pool.query<AnnouncementChannelPushOutboxRecord>(
      `WITH candidate AS (
         SELECT post_id
           FROM announcement_channel_push_outbox
          WHERE (
            (status = 'pending' AND available_at <= NOW())
            OR (status = 'processing' AND locked_at < NOW() - INTERVAL '5 minutes')
          )
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE announcement_channel_push_outbox outbox
          SET status = 'processing',
              locked_at = NOW(),
              attempts = attempts + 1,
              last_error = NULL
         FROM candidate
        WHERE outbox.post_id = candidate.post_id
       RETURNING outbox.*`
    );
    return result.rows[0] || null;
  }

  async checkpoint(postId: string, cursorIdentityId: string): Promise<void> {
    await pool.query(
      `UPDATE announcement_channel_push_outbox
          SET cursor_identity_id = $2,
              locked_at = NOW()
        WHERE post_id = $1 AND status = 'processing'`,
      [postId, cursorIdentityId]
    );
  }

  async complete(postId: string): Promise<void> {
    await pool.query(
      `UPDATE announcement_channel_push_outbox
          SET status = 'completed',
              locked_at = NULL,
              completed_at = NOW(),
              last_error = NULL
        WHERE post_id = $1`,
      [postId]
    );
  }

  async retry(postId: string, error: string, delaySeconds: number): Promise<void> {
    await pool.query(
      `UPDATE announcement_channel_push_outbox
          SET status = 'pending',
              locked_at = NULL,
              available_at = NOW() + ($3 * INTERVAL '1 second'),
              last_error = LEFT($2, 2000)
        WHERE post_id = $1`,
      [postId, error, delaySeconds]
    );
  }
}

export const announcementChannelPushOutboxRepository = new AnnouncementChannelPushOutboxRepository();
