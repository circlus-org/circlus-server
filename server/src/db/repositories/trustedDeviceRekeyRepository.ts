import { nanoid } from 'nanoid';
import type { PoolClient } from 'pg';
import type { IdentityId } from '@shared/types';
import { pool, transaction } from '../index';

export type TrustedDeviceRekeyReason = 'device_revoked' | 'device_added';

export type TrustedDeviceRekeyJob = {
  job_id: string;
  family_id: string;
  identity_id: IdentityId;
  device_id: string;
  reason: TrustedDeviceRekeyReason;
  status: 'pending' | 'processing' | 'completed';
  attempts: number;
  target_count: number;
  completed_count: number;
};

export type TrustedDeviceRekeyEnqueueResult = {
  jobId: string;
  status: 'pending' | 'completed';
  groupTargets: number;
  directTargets: number;
};

export type TrustedDeviceRekeyGroupNotification = {
  chatId: string;
  keyEpoch: number;
  participantIdentityIds: IdentityId[];
  rekeyRequiredAt: number;
};

export type TrustedDeviceRekeyBatchResult = {
  completed: boolean;
  processedTargets: number;
  groupNotifications: TrustedDeviceRekeyGroupNotification[];
};

export class TrustedDeviceRekeyRepository {
  async enqueue(client: PoolClient, params: {
    familyId: string;
    identityId: IdentityId;
    deviceId: string;
    reason: TrustedDeviceRekeyReason;
  }): Promise<TrustedDeviceRekeyEnqueueResult> {
    const jobId = `device_rekey_${nanoid()}`;
    await client.query(
      `INSERT INTO trusted_device_rekey_jobs
         (job_id, family_id, identity_id, device_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, params.familyId, params.identityId, params.deviceId, params.reason]
    );

    const groupResult = await client.query(
      `INSERT INTO trusted_device_rekey_targets (job_id, family_id, target_type, chat_id)
       SELECT $1, $2, 'group', participant.chat_id
         FROM group_chat_participants participant
         JOIN group_chats chat
           ON chat.family_id = participant.family_id
          AND chat.chat_id = participant.chat_id
        WHERE participant.family_id = $2
          AND participant.identity_id = $3
          AND participant.is_active = TRUE
          AND chat.protocol_version = 2
       ON CONFLICT DO NOTHING`,
      [jobId, params.familyId, params.identityId]
    );
    const directResult = await client.query(
      `INSERT INTO trusted_device_rekey_targets (job_id, family_id, target_type, chat_id)
       SELECT $1, $2, 'direct', chats.direct_chat_id
         FROM (
           SELECT DISTINCT direct_chat_id
             FROM messages
            WHERE family_id = $2
              AND (sender_identity_id = $3 OR recipient_identity_id = $3)
           UNION
           SELECT direct_chat_id
             FROM direct_chat_epoch_state
            WHERE family_id = $2
              AND (
                split_part(direct_chat_id, '::', 1) = $3
                OR split_part(direct_chat_id, '::', 2) = $3
              )
         ) chats
       ON CONFLICT DO NOTHING`,
      [jobId, params.familyId, params.identityId]
    );
    const groupTargets = groupResult.rowCount || 0;
    const directTargets = directResult.rowCount || 0;
    const targetCount = groupTargets + directTargets;
    await client.query(
      `UPDATE trusted_device_rekey_jobs
          SET target_count = $2,
              status = CASE WHEN $2 = 0 THEN 'completed' ELSE 'pending' END,
              completed_at = CASE WHEN $2 = 0 THEN NOW() ELSE NULL END
        WHERE job_id = $1`,
      [jobId, targetCount]
    );
    return {
      jobId,
      status: targetCount === 0 ? 'completed' : 'pending',
      groupTargets,
      directTargets,
    };
  }

  async claimNext(): Promise<TrustedDeviceRekeyJob | null> {
    const result = await pool.query<TrustedDeviceRekeyJob>(
      `WITH candidate AS (
         SELECT job.job_id
           FROM trusted_device_rekey_jobs job
           JOIN family_config family ON family.family_id = job.family_id
          WHERE (
            (job.status = 'pending' AND job.available_at <= NOW())
            OR (job.status = 'processing' AND job.locked_at < NOW() - INTERVAL '5 minutes')
          )
            AND family.status = 'active'
          ORDER BY job.created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE trusted_device_rekey_jobs job
          SET status = 'processing',
              locked_at = NOW(),
              attempts = attempts + 1,
              last_error = NULL
         FROM candidate
        WHERE job.job_id = candidate.job_id
       RETURNING job.*`
    );
    return result.rows[0] || null;
  }

  async rotateNextBatch(jobId: string, batchSize: number): Promise<TrustedDeviceRekeyBatchResult> {
    return transaction(async (client) => {
      const jobResult = await client.query<TrustedDeviceRekeyJob>(
        `SELECT *
           FROM trusted_device_rekey_jobs
          WHERE job_id = $1
          FOR UPDATE`,
        [jobId]
      );
      const job = jobResult.rows[0];
      if (!job || job.status !== 'processing') {
        return { completed: true, processedTargets: 0, groupNotifications: [] };
      }

      const targetResult = await client.query<{ target_type: 'group' | 'direct'; chat_id: string }>(
        `SELECT target_type, chat_id
           FROM trusted_device_rekey_targets
          WHERE job_id = $1 AND status = 'pending'
          ORDER BY target_type DESC, chat_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2`,
        [jobId, batchSize]
      );
      if (targetResult.rows.length === 0) {
        await this.completeWithClient(client, jobId);
        return { completed: true, processedTargets: 0, groupNotifications: [] };
      }

      const now = Date.now();
      const groupIds = targetResult.rows.filter((row) => row.target_type === 'group').map((row) => row.chat_id);
      const directIds = targetResult.rows.filter((row) => row.target_type === 'direct').map((row) => row.chat_id);
      const epochByTarget = new Map<string, number | null>();
      const notifications: TrustedDeviceRekeyGroupNotification[] = [];

      if (groupIds.length > 0) {
        const required = await client.query<{ chat_id: string; key_epoch: number }>(
          `UPDATE group_chats
              SET rekey_required_at = $3,
                  rekey_required_reason = $4,
                  rekey_required_identity_id = $5,
                  updated_at = $3
            WHERE family_id = $1 AND chat_id = ANY($2::text[])
          RETURNING chat_id, key_epoch`,
          [job.family_id, groupIds, now, job.reason, job.identity_id]
        );
        const participants = await client.query<{ chat_id: string; identity_id: IdentityId }>(
          `SELECT chat_id, identity_id
             FROM group_chat_participants
            WHERE family_id = $1
              AND chat_id = ANY($2::text[])
              AND is_active = TRUE`,
          [job.family_id, groupIds]
        );
        const participantsByChat = new Map<string, IdentityId[]>();
        for (const participant of participants.rows) {
          const values = participantsByChat.get(participant.chat_id) || [];
          values.push(participant.identity_id);
          participantsByChat.set(participant.chat_id, values);
        }
        for (const row of required.rows) {
          const epoch = Number(row.key_epoch);
          epochByTarget.set(`group:${row.chat_id}`, epoch);
          notifications.push({
            chatId: row.chat_id,
            keyEpoch: epoch,
            participantIdentityIds: participantsByChat.get(row.chat_id) || [],
            rekeyRequiredAt: now,
          });
        }
      }

      if (directIds.length > 0) {
        const rotated = await client.query<{ direct_chat_id: string; current_epoch: number }>(
          `INSERT INTO direct_chat_epoch_state (family_id, direct_chat_id, current_epoch, updated_at)
           SELECT $1, target.direct_chat_id, 2, $3
             FROM unnest($2::text[]) AS target(direct_chat_id)
           ON CONFLICT (family_id, direct_chat_id)
           DO UPDATE SET current_epoch = direct_chat_epoch_state.current_epoch + 1,
                         updated_at = EXCLUDED.updated_at
           RETURNING direct_chat_id, current_epoch`,
          [job.family_id, directIds, now]
        );
        for (const row of rotated.rows) {
          epochByTarget.set(`direct:${row.direct_chat_id}`, Number(row.current_epoch));
        }
      }

      const types = targetResult.rows.map((row) => row.target_type);
      const chatIds = targetResult.rows.map((row) => row.chat_id);
      const epochs = targetResult.rows.map((row) => epochByTarget.get(`${row.target_type}:${row.chat_id}`) ?? null);
      await client.query(
        `UPDATE trusted_device_rekey_targets target
            SET status = 'completed',
                rotated_epoch = completed.rotated_epoch,
                completed_at = NOW()
           FROM unnest($2::text[], $3::text[], $4::integer[])
                AS completed(target_type, chat_id, rotated_epoch)
          WHERE target.job_id = $1
            AND target.target_type = completed.target_type
            AND target.chat_id = completed.chat_id
            AND target.status = 'pending'`,
        [jobId, types, chatIds, epochs]
      );
      const remaining = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM trusted_device_rekey_targets
          WHERE job_id = $1 AND status = 'pending'`,
        [jobId]
      );
      const completed = Number(remaining.rows[0]?.count || 0) === 0;
      await client.query(
        `UPDATE trusted_device_rekey_jobs
            SET completed_count = completed_count + $2,
                locked_at = CASE WHEN $3 THEN NULL ELSE NOW() END,
                status = CASE WHEN $3 THEN 'completed' ELSE status END,
                completed_at = CASE WHEN $3 THEN NOW() ELSE completed_at END
          WHERE job_id = $1`,
        [jobId, targetResult.rows.length, completed]
      );
      return {
        completed,
        processedTargets: targetResult.rows.length,
        groupNotifications: notifications,
      };
    });
  }

  async release(jobId: string): Promise<void> {
    await pool.query(
      `UPDATE trusted_device_rekey_jobs
          SET status = 'pending', locked_at = NULL, available_at = NOW()
        WHERE job_id = $1 AND status = 'processing'`,
      [jobId]
    );
  }

  async retry(jobId: string, error: string, delaySeconds: number): Promise<void> {
    await pool.query(
      `UPDATE trusted_device_rekey_jobs
          SET status = 'pending',
              locked_at = NULL,
              available_at = NOW() + ($3 * INTERVAL '1 second'),
              last_error = LEFT($2, 2000)
        WHERE job_id = $1`,
      [jobId, error, delaySeconds]
    );
  }

  async cleanupCompleted(retentionDays: number = 30): Promise<number> {
    const safeRetentionDays = Math.max(1, Math.min(365, Math.floor(retentionDays)));
    const result = await pool.query(
      `DELETE FROM trusted_device_rekey_jobs
        WHERE status = 'completed'
          AND completed_at < NOW() - ($1 * INTERVAL '1 day')`,
      [safeRetentionDays]
    );
    return result.rowCount || 0;
  }

  private async completeWithClient(client: PoolClient, jobId: string): Promise<void> {
    await client.query(
      `UPDATE trusted_device_rekey_jobs
          SET status = 'completed', locked_at = NULL, completed_at = NOW(), last_error = NULL
        WHERE job_id = $1`,
      [jobId]
    );
  }
}

export const trustedDeviceRekeyRepository = new TrustedDeviceRekeyRepository();
