import { rememberMessageSend } from '../../services/messageSendReceipt';
import { MessageRevisionConflict, sameMessageClaim } from '../../services/messageRevision';
import type { PoolClient } from 'pg';
import { pool } from '../index';
import type { DeviceId, DirectEpochTransitionClaim, DirectMessageAuthorClaim, DirectMessageDeliveryProof, DirectMessageReadProof, IdentityId, MessageStatus, TemporaryIdentityDelegationCredential } from '@shared/types';
import type { FindDirectMessageByIdResult, FindMessageDeviceSyncStateResult } from './messageRepository.queries';
import {
  updateDirectMessageStatus,
  findDirectMessageById,
  fetchDirectMessagesForSync,
  fetchDirectMessageStatusUpdatesForSync,
  fetchReadDirectMessagesForSenderUpTo,
  findMessageDeviceSyncState,
  ensureMessageDeviceSyncState,
  upsertMessageDeviceSyncState,
  deleteDirectMessage,
} from './messageRepository.queries';

export type MessageRecord = {
  server_message_id: string;
  family_id: string;
  direct_chat_id: string;
  chat_seq: number;
  sender_identity_id: IdentityId;
  recipient_identity_id: IdentityId;
  sender_device_id: DeviceId;
  ciphertext: string;
  sender_ciphertext: string | null;
  notification_preview_ciphertext: string | null;
  sender_signature: string;
  author_claim?: DirectMessageAuthorClaim | null;
  temporary_identity_delegation: TemporaryIdentityDelegationCredential | null;
  client_message_id: string;
  client_created_at: number | null;
  created_at: number;
  content_updated_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  revision: number;
  status: MessageStatus;
  status_updated_at: number;
  delivery_proof?: DirectMessageDeliveryProof | null;
  read_proof?: DirectMessageReadProof | null;
  epoch: number | null;
};

export type DirectChatEpochKeyRecord = {
  family_id: string;
  direct_chat_id: string;
  epoch: number;
  key_commitment: string;
  proposer_identity_id: IdentityId;
  proposer_device_id: DeviceId | null;
  signed_epoch_transition: DirectEpochTransitionClaim | null;
  created_at: number;
};

export type DirectChatKeyEnvelopeRecord = {
  family_id: string;
  direct_chat_id: string;
  epoch: number;
  identity_id: IdentityId;
  envelope_ciphertext: string;
  publisher_identity_id: IdentityId;
  created_at: number;
};

function getDirectChatId(a: string, b: string): string {
  const left = (a || '').trim();
  const right = (b || '').trim();
  if (!left || !right) return `${left}::${right}`;
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}

function mapMessage(row: FindDirectMessageByIdResult): MessageRecord {
  const rowAny = row as FindDirectMessageByIdResult & {
    direct_chat_id?: string | null;
    chat_seq?: string | number | null;
    content_updated_at?: string | number | null;
    edited_at?: string | number | null;
    deleted_at?: string | number | null;
    revision?: number | null;
    epoch?: string | number | null;
    notification_preview_ciphertext?: string | null;
    temporary_identity_delegation?: TemporaryIdentityDelegationCredential | string | null;
    author_claim?: DirectMessageAuthorClaim | string | null;
    delivery_proof?: DirectMessageDeliveryProof | string | null;
    read_proof?: DirectMessageReadProof | string | null;
  };
  return {
    ...row,
    direct_chat_id: rowAny.direct_chat_id ?? '',
    chat_seq: rowAny.chat_seq == null ? 0 : Number(rowAny.chat_seq),
    sender_identity_id: row.sender_identity_id as IdentityId,
    recipient_identity_id: row.recipient_identity_id as IdentityId,
    sender_device_id: row.sender_device_id as DeviceId,
    notification_preview_ciphertext: rowAny.notification_preview_ciphertext ?? null,
    temporary_identity_delegation: parseJsonField<TemporaryIdentityDelegationCredential>(rowAny.temporary_identity_delegation),
    author_claim: parseJsonField<DirectMessageAuthorClaim>(rowAny.author_claim),
    delivery_proof: parseJsonField<DirectMessageDeliveryProof>(rowAny.delivery_proof),
    read_proof: parseJsonField<DirectMessageReadProof>(rowAny.read_proof),
    status: row.status as MessageStatus,
    client_created_at: row.client_created_at === null ? null : Number(row.client_created_at),
    created_at: Number(row.created_at),
    content_updated_at: Number(rowAny.content_updated_at ?? row.created_at),
    edited_at: rowAny.edited_at == null ? null : Number(rowAny.edited_at),
    deleted_at: rowAny.deleted_at == null ? null : Number(rowAny.deleted_at),
    revision: Number(rowAny.revision ?? 1),
    status_updated_at: Number(row.status_updated_at),
    epoch: rowAny.epoch == null ? null : Number(rowAny.epoch),
  };
}

function parseJsonField<T>(value: T | string | null | undefined): T | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value;
}

function parseDirectEpochClaim(value: DirectEpochTransitionClaim | string | null | undefined): DirectEpochTransitionClaim | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as DirectEpochTransitionClaim;
    } catch {
      return null;
    }
  }
  return value;
}


function mapMessageSyncState(row: FindMessageDeviceSyncStateResult): { last_sync_at: number; last_status_sync_at: number; last_mutation_sync_at: number } {
  const rowAny = row as FindMessageDeviceSyncStateResult & { last_mutation_sync_at?: string | number | null };
  return {
    last_sync_at: Number(row.last_sync_at),
    last_status_sync_at: Number(row.last_status_sync_at),
    last_mutation_sync_at: Number(rowAny.last_mutation_sync_at ?? row.last_sync_at),
  };
}

export class MessageRepository {
  async findByClientMessageId(
    familyId: string,
    deviceId: DeviceId,
    clientMessageId: string
  ): Promise<Pick<MessageRecord, 'server_message_id' | 'created_at'> | null> {
    const receipt = await pool.query(`SELECT message_id AS server_message_id, created_at FROM message_send_receipts
      WHERE family_id=$1 AND scope='direct' AND device_id=$2 AND client_message_id=$3`,[familyId,deviceId,clientMessageId]);
    return receipt.rows[0] || null;
  }

  /**
   * Assigns the next gapless per-chat sequence number inside the caller's
   * transaction. The advisory xact lock serializes assignment per direct chat
   * so that commit order == seq order (no out-of-order-commit overshoot), and
   * the upsert keeps the counter gapless and unique.
   */
  private async assignChatSeq(
    client: PoolClient,
    familyId: string,
    directChatId: string
  ): Promise<number> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1 || $2))', [familyId, directChatId]);
    const result = await client.query<{ last_seq: string }>(
      `INSERT INTO direct_chat_seq (family_id, direct_chat_id, last_seq)
       VALUES ($1, $2, 1)
       ON CONFLICT (family_id, direct_chat_id)
       DO UPDATE SET last_seq = direct_chat_seq.last_seq + 1
       RETURNING last_seq`,
      [familyId, directChatId]
    );
    return Number(result.rows[0].last_seq);
  }

  async insertMessage(record: MessageRecord): Promise<{ chat_seq: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await rememberMessageSend(client, record.family_id, 'direct', record.sender_device_id, record.client_message_id, record.server_message_id, record.created_at);
      const chatSeq = await this.assignChatSeq(client, record.family_id, record.direct_chat_id);
      await client.query(
        `INSERT INTO messages (
           server_message_id,
           family_id,
           direct_chat_id,
           chat_seq,
           sender_identity_id,
           recipient_identity_id,
           sender_device_id,
           ciphertext,
           sender_ciphertext,
           notification_preview_ciphertext,
           sender_signature,
           author_claim,
           client_message_id,
           client_created_at,
           created_at,
           content_updated_at,
           revision,
           status,
           status_updated_at,
           epoch,
           temporary_identity_delegation
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12::jsonb, $13, $14, $15, $15, 1, $16, $17, $18, $19::jsonb
         )`,
        [
          record.server_message_id,
          record.family_id,
          record.direct_chat_id,
          chatSeq,
          record.sender_identity_id,
          record.recipient_identity_id,
          record.sender_device_id,
          record.ciphertext,
          record.sender_ciphertext,
          record.notification_preview_ciphertext,
          record.sender_signature,
          record.author_claim ? JSON.stringify(record.author_claim) : null,
          record.client_message_id,
          record.client_created_at,
          record.created_at,
          record.status,
          record.status_updated_at,
          record.epoch,
          record.temporary_identity_delegation ? JSON.stringify(record.temporary_identity_delegation) : null,
        ]
      );
      await client.query('COMMIT');
      return { chat_seq: chatSeq };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateStatus(
    familyId: string,
    serverMessageId: string,
    status: MessageStatus,
    statusUpdatedAt: number
  ): Promise<void> {
    await updateDirectMessageStatus.run({ familyId, serverMessageId, status, statusUpdatedAt }, pool);
  }

  async recordDeliveryProof(familyId: string, serverMessageId: string, proof: DirectMessageDeliveryProof, statusUpdatedAt: number): Promise<boolean> {
    const result = await pool.query(
      `UPDATE messages SET delivery_proof = $3::jsonb,
         status = CASE WHEN status = 'new' THEN 'delivered' ELSE status END,
         status_updated_at = $4
       WHERE family_id = $1 AND server_message_id = $2
         AND author_claim->>'signature' = $5
         AND (delivery_proof IS NULL OR delivery_proof->'receipt'->'payload'->>'authorClaimSignature' <> $5)`,
      [familyId, serverMessageId, JSON.stringify(proof), statusUpdatedAt, proof.receipt.payload.authorClaimSignature]
    );
    return (result.rowCount || 0) > 0;
  }

  async findMessageById(
    familyId: string,
    serverMessageId: string
  ): Promise<MessageRecord | null> {
    const results = await findDirectMessageById.run({ familyId, serverMessageId }, pool);
    return results[0] ? mapMessage(results[0]) : null;
  }

  async fetchMessagesForSync(
    familyId: string,
    identityId: IdentityId,
    deviceId: DeviceId,
    since: number,
    limit: number,
    peerIdentityId?: IdentityId
  ): Promise<MessageRecord[]> {
    if (peerIdentityId) {
      // Focused per-direct-chat sync: gapless, unique, monotonic chat_seq cursor.
      // Strict `>` is correct because chat_seq is unique + monotonic per chat —
      // no ties, no out-of-order-commit overshoot, so no tiebreak is needed.
      const directChatId = getDirectChatId(identityId, peerIdentityId);
      const results = await pool.query<FindDirectMessageByIdResult>(
        `SELECT *
         FROM messages
         WHERE family_id = $1
           AND direct_chat_id = $2
           AND chat_seq > $3
           AND (
             recipient_identity_id = $4
             OR (sender_identity_id = $4 AND sender_device_id <> $5)
           )
         ORDER BY chat_seq ASC
         LIMIT $6`,
        [familyId, directChatId, since, identityId, deviceId, limit]
      );
      return results.rows.map(mapMessage);
    }

    const results = await fetchDirectMessagesForSync.run({ familyId, identityId, deviceId, since, limit }, pool);
    return results.map(mapMessage);
  }

  async fetchStatusUpdatesForSync(
    familyId: string,
    senderIdentityId: IdentityId,
    since: number,
    limit: number,
    peerIdentityId?: IdentityId
  ): Promise<MessageRecord[]> {
    if (peerIdentityId) {
      const results = await pool.query<FindDirectMessageByIdResult>(
        `SELECT *
         FROM messages
         WHERE family_id = $1
           AND sender_identity_id = $2
           AND recipient_identity_id = $3
           AND status <> 'new'
           AND status_updated_at > $4
         ORDER BY status_updated_at ASC
         LIMIT $5`,
        [familyId, senderIdentityId, peerIdentityId, since, limit]
      );
      return results.rows.map(mapMessage);
    }

    const results = await fetchDirectMessageStatusUpdatesForSync.run({ familyId, senderIdentityId, since, limit }, pool);
    return results.map(mapMessage);
  }

  async fetchReadMessagesForSenderUpTo(
    familyId: string,
    senderIdentityId: IdentityId,
    syncedThrough: number
  ): Promise<MessageRecord[]> {
    const results = await fetchReadDirectMessagesForSenderUpTo.run({ familyId, senderIdentityId, syncedThrough }, pool);
    return results.map(mapMessage);
  }

  async getSyncState(
    familyId: string,
    deviceId: DeviceId
  ): Promise<{ last_sync_at: number; last_status_sync_at: number; last_mutation_sync_at: number }> {
    const results = await findMessageDeviceSyncState.run({ familyId, deviceId }, pool);
    if (results[0]) return mapMessageSyncState(results[0]);

    await ensureMessageDeviceSyncState.run({ familyId, deviceId }, pool);

    return { last_sync_at: 0, last_status_sync_at: 0, last_mutation_sync_at: 0 };
  }

  async updateSyncState(
    familyId: string,
    deviceId: DeviceId,
    lastSyncAt: number,
    lastStatusSyncAt: number,
    lastMutationSyncAt: number
  ): Promise<void> {
    await upsertMessageDeviceSyncState.run({ familyId, deviceId, lastSyncAt, lastStatusSyncAt, lastMutationSyncAt }, pool);
  }

  async deleteMessage(familyId: string, serverMessageId: string): Promise<void> {
    await deleteDirectMessage.run({ familyId, serverMessageId }, pool);
  }

  async deleteThreadMessages(
    familyId: string,
    identityIdA: IdentityId,
    identityIdB: IdentityId,
    clearThroughSequence: number
  ): Promise<number> {
    const result = await pool.query(
      `DELETE FROM messages
       WHERE family_id = $1 AND chat_seq <= $4
         AND (
           (sender_identity_id = $2 AND recipient_identity_id = $3)
           OR
           (sender_identity_id = $3 AND recipient_identity_id = $2)
         )`,
      [familyId, identityIdA, identityIdB, clearThroughSequence]
    );
    return result.rowCount || 0;
  }

  async editMessage(params: {
    familyId: string;
    directChatId: string;
    serverMessageId: string;
    ciphertext: string;
    senderCiphertext: string | null;
    senderSignature: string;
    authorClaim: DirectMessageAuthorClaim;
    editedAt: number;
    epoch?: number | null;
  }): Promise<{ chat_seq: number; applied?: boolean; edited_at?: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT author_claim,revision,chat_seq,edited_at FROM messages WHERE family_id=$1 AND server_message_id=$2 FOR UPDATE`, [params.familyId,params.serverMessageId]);
      const current = locked.rows[0];
      if (current && sameMessageClaim(current.author_claim, params.authorClaim)) {
        await client.query('COMMIT');
        return {chat_seq:Number(current.chat_seq),applied:false,edited_at:Number(current.edited_at)};
      }
      if (!current || Number(current.revision)+1 !== params.authorClaim.payload.revision) throw new MessageRevisionConflict();

      const chatSeq = await this.assignChatSeq(client, params.familyId, params.directChatId);
      await client.query(
        `UPDATE messages
         SET ciphertext = $3,
             sender_ciphertext = $4,
             sender_signature = $5,
             author_claim = $6::jsonb,
             edited_at = $7,
             content_updated_at = $7,
             revision = revision + 1,
             epoch = COALESCE($8, epoch),
             chat_seq = $9
         WHERE family_id = $1
           AND server_message_id = $2`,
        [
          params.familyId,
          params.serverMessageId,
          params.ciphertext,
          params.senderCiphertext,
          params.senderSignature,
          JSON.stringify(params.authorClaim),
          params.editedAt,
          params.epoch ?? null,
          chatSeq,
        ]
      );
      await client.query('COMMIT');
      return { chat_seq: chatSeq, applied: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDirectEpochKey(params: {
    familyId: string;
    directChatId: string;
    epoch: number;
    keyCommitment: string;
    proposerIdentityId: IdentityId;
    proposerDeviceId: DeviceId;
    signedEpochTransition: DirectEpochTransitionClaim;
  }, client?: PoolClient): Promise<{ inserted: DirectChatEpochKeyRecord | null; existing: DirectChatEpochKeyRecord | null }> {
    const db = client || pool;
    await this.ensureDirectEpochState(params.familyId, params.directChatId, params.epoch, client);
    const inserted = await db.query<DirectChatEpochKeyRecord>(
      `INSERT INTO direct_chat_epoch_keys
         (family_id, direct_chat_id, epoch, key_commitment, proposer_identity_id, proposer_device_id, signed_epoch_transition, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (family_id, direct_chat_id, epoch) DO NOTHING
       RETURNING *`,
      [
        params.familyId,
        params.directChatId,
        params.epoch,
        params.keyCommitment,
        params.proposerIdentityId,
        params.proposerDeviceId,
        JSON.stringify(params.signedEpochTransition),
        Date.now(),
      ]
    );
    const insertedRow = inserted.rows[0] ? this.mapDirectEpochKey(inserted.rows[0]) : null;
    const existing = insertedRow
      ? null
      : await this.findDirectEpochKey(params.familyId, params.directChatId, params.epoch, client);
    return { inserted: insertedRow, existing };
  }

  async getDirectCurrentEpoch(familyId: string, directChatId: string, client?: PoolClient): Promise<number> {
    const result = await (client || pool).query<{ current_epoch: number }>(
      `SELECT current_epoch
       FROM direct_chat_epoch_state
       WHERE family_id = $1 AND direct_chat_id = $2
       LIMIT 1`,
      [familyId, directChatId]
    );
    return Number(result.rows[0]?.current_epoch || 1);
  }

  async ensureDirectEpochState(
    familyId: string,
    directChatId: string,
    epoch: number = 1,
    client?: PoolClient
  ): Promise<number> {
    const result = await (client || pool).query<{ current_epoch: number }>(
      `INSERT INTO direct_chat_epoch_state (family_id, direct_chat_id, current_epoch, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (family_id, direct_chat_id)
       DO UPDATE SET current_epoch = GREATEST(direct_chat_epoch_state.current_epoch, EXCLUDED.current_epoch),
                     updated_at = CASE
                       WHEN EXCLUDED.current_epoch > direct_chat_epoch_state.current_epoch THEN EXCLUDED.updated_at
                       ELSE direct_chat_epoch_state.updated_at
                     END
       RETURNING current_epoch`,
      [familyId, directChatId, epoch, Date.now()]
    );
    return Number(result.rows[0]?.current_epoch || epoch || 1);
  }

  async bumpDirectEpoch(familyId: string, directChatId: string): Promise<number> {
    const result = await pool.query<{ current_epoch: number }>(
      `INSERT INTO direct_chat_epoch_state (family_id, direct_chat_id, current_epoch, updated_at)
       VALUES ($1, $2, 2, $3)
       ON CONFLICT (family_id, direct_chat_id)
       DO UPDATE SET current_epoch = direct_chat_epoch_state.current_epoch + 1,
                     updated_at = EXCLUDED.updated_at
       RETURNING current_epoch`,
      [familyId, directChatId, Date.now()]
    );
    return Number(result.rows[0]?.current_epoch || 1);
  }

  async bumpDirectEpochIfStale(familyId: string, directChatId: string, maxAgeMs: number): Promise<{ bumped: boolean; currentEpoch: number }> {
    const now = Date.now();
    const result = await pool.query<{ current_epoch: number }>(
      `INSERT INTO direct_chat_epoch_state (family_id, direct_chat_id, current_epoch, updated_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (family_id, direct_chat_id)
       DO UPDATE SET current_epoch = direct_chat_epoch_state.current_epoch + 1,
                     updated_at = EXCLUDED.updated_at
       WHERE direct_chat_epoch_state.updated_at <= $4
       RETURNING current_epoch`,
      [familyId, directChatId, now, now - maxAgeMs]
    );
    if (result.rows[0]) return { bumped: true, currentEpoch: Number(result.rows[0].current_epoch) };
    return { bumped: false, currentEpoch: await this.getDirectCurrentEpoch(familyId, directChatId) };
  }

  async listDirectChatIdsForIdentity(familyId: string, identityId: IdentityId): Promise<string[]> {
    const result = await pool.query<{ direct_chat_id: string }>(
      `SELECT DISTINCT direct_chat_id
       FROM (
         SELECT CASE
           WHEN sender_identity_id < recipient_identity_id
             THEN sender_identity_id || '::' || recipient_identity_id
           ELSE recipient_identity_id || '::' || sender_identity_id
         END AS direct_chat_id
         FROM messages
         WHERE family_id = $1
           AND (sender_identity_id = $2 OR recipient_identity_id = $2)
         UNION
         SELECT direct_chat_id
         FROM direct_chat_epoch_state
         WHERE family_id = $1
           AND direct_chat_id LIKE '%' || $2 || '%'
       ) chats`,
      [familyId, identityId]
    );
    return result.rows
      .map((row) => String(row.direct_chat_id || '').trim())
      .filter((directChatId) => directChatId.split('::').includes(identityId));
  }

  async cleanupExpiredDirectEpochKeys(retentionMs: number, nowMs: number = Date.now()): Promise<number> {
    const cutoff = nowMs - retentionMs;
    const result = await pool.query(
      `DELETE FROM direct_chat_key_envelopes e
       USING direct_chat_epoch_keys k
       LEFT JOIN direct_chat_epoch_state s
         ON s.family_id = k.family_id AND s.direct_chat_id = k.direct_chat_id
       WHERE e.family_id = k.family_id
         AND NOT EXISTS (
           SELECT 1
             FROM circle_migrations cm
            WHERE cm.family_id = e.family_id
              AND cm.freeze_started_at IS NOT NULL
              AND cm.status NOT IN ('migrated', 'aborted')
         )
         AND e.direct_chat_id = k.direct_chat_id
         AND e.epoch = k.epoch
         AND k.created_at < $1
         AND k.epoch < COALESCE(s.current_epoch, k.epoch)`,
      [cutoff]
    );
    return result.rowCount || 0;
  }

  async cleanupExpiredGroupEpochKeys(retentionMs: number, nowMs: number = Date.now()): Promise<number> {
    const cutoff = nowMs - retentionMs;
    const result = await pool.query(
      `DELETE FROM group_chat_key_envelopes e
       USING group_chat_epoch_keys k
       JOIN group_chats c
         ON c.family_id = k.family_id AND c.chat_id = k.chat_id
       WHERE e.family_id = k.family_id
         AND NOT EXISTS (
           SELECT 1
             FROM circle_migrations cm
            WHERE cm.family_id = e.family_id
              AND cm.freeze_started_at IS NOT NULL
              AND cm.status NOT IN ('migrated', 'aborted')
         )
         AND e.chat_id = k.chat_id
         AND e.epoch = k.epoch
         AND k.created_at < $1
         AND k.epoch < c.key_epoch`,
      [cutoff]
    );
    return result.rowCount || 0;
  }

  async cleanupExpiredChatEpochKeyEnvelopes(nowMs: number = Date.now()): Promise<number> {
    const direct = await pool.query(
      `DELETE FROM direct_chat_key_envelopes e
       USING direct_chat_epoch_keys k
       JOIN family_config fc
         ON fc.family_id = k.family_id
       LEFT JOIN direct_chat_epoch_state s
         ON s.family_id = k.family_id AND s.direct_chat_id = k.direct_chat_id
       WHERE e.family_id = k.family_id
         AND e.direct_chat_id = k.direct_chat_id
         AND e.epoch = k.epoch
         AND k.created_at < ($1::bigint - (COALESCE(fc.chat_epoch_key_retention_hours, 720)::bigint * 60::bigint * 60::bigint * 1000::bigint))
         AND k.epoch < COALESCE(s.current_epoch, k.epoch)`,
      [nowMs]
    );
    const group = await pool.query(
      `DELETE FROM group_chat_key_envelopes e
       USING group_chat_epoch_keys k
       JOIN family_config fc
         ON fc.family_id = k.family_id
       JOIN group_chats c
         ON c.family_id = k.family_id AND c.chat_id = k.chat_id
       WHERE e.family_id = k.family_id
         AND e.chat_id = k.chat_id
         AND e.epoch = k.epoch
         AND k.created_at < ($1::bigint - (COALESCE(fc.chat_epoch_key_retention_hours, 720)::bigint * 60::bigint * 60::bigint * 1000::bigint))
         AND k.epoch < c.key_epoch`,
      [nowMs]
    );
    return (direct.rowCount || 0) + (group.rowCount || 0);
  }

  async findDirectEpochKey(
    familyId: string,
    directChatId: string,
    epoch: number,
    client?: PoolClient
  ): Promise<DirectChatEpochKeyRecord | null> {
    const result = await (client || pool).query<DirectChatEpochKeyRecord>(
      `SELECT *
       FROM direct_chat_epoch_keys
       WHERE family_id = $1 AND direct_chat_id = $2 AND epoch = $3
       LIMIT 1`,
      [familyId, directChatId, epoch]
    );
    return result.rows[0] ? this.mapDirectEpochKey(result.rows[0]) : null;
  }

  async upsertDirectKeyEnvelope(params: {
    familyId: string;
    directChatId: string;
    epoch: number;
    identityId: IdentityId;
    envelopeCiphertext: string;
    publisherIdentityId: IdentityId;
  }, client?: PoolClient): Promise<void> {
    await (client || pool).query(
      `INSERT INTO direct_chat_key_envelopes
         (family_id, direct_chat_id, epoch, identity_id, envelope_ciphertext, publisher_identity_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (family_id, direct_chat_id, epoch, identity_id)
       DO UPDATE SET envelope_ciphertext = EXCLUDED.envelope_ciphertext,
                     publisher_identity_id = EXCLUDED.publisher_identity_id,
                     created_at = EXCLUDED.created_at`,
      [params.familyId, params.directChatId, params.epoch, params.identityId, params.envelopeCiphertext, params.publisherIdentityId, Date.now()]
    );
  }

  async findDirectKeyEnvelopeForIdentity(
    familyId: string,
    directChatId: string,
    epoch: number,
    identityId: IdentityId
  ): Promise<DirectChatKeyEnvelopeRecord | null> {
    const result = await pool.query<DirectChatKeyEnvelopeRecord>(
      `SELECT *
       FROM direct_chat_key_envelopes
       WHERE family_id = $1 AND direct_chat_id = $2 AND epoch = $3 AND identity_id = $4
       LIMIT 1`,
      [familyId, directChatId, epoch, identityId]
    );
    return result.rows[0] ? {
      ...result.rows[0],
      epoch: Number(result.rows[0].epoch),
      identity_id: result.rows[0].identity_id as IdentityId,
      publisher_identity_id: result.rows[0].publisher_identity_id as IdentityId,
      created_at: Number(result.rows[0].created_at),
    } : null;
  }

  private mapDirectEpochKey(row: DirectChatEpochKeyRecord): DirectChatEpochKeyRecord {
    return {
      ...row,
      epoch: Number(row.epoch),
      proposer_identity_id: row.proposer_identity_id as IdentityId,
      proposer_device_id: (row.proposer_device_id as DeviceId | null) ?? null,
      signed_epoch_transition: parseDirectEpochClaim(row.signed_epoch_transition),
      created_at: Number(row.created_at),
    };
  }

  async softDeleteMessage(params: {
    familyId: string;
    directChatId: string;
    serverMessageId: string;
    deletedAt: number;
    authorClaim: DirectMessageAuthorClaim;
  }): Promise<{ chat_seq: number; applied?: boolean; edited_at?: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT author_claim,revision,chat_seq,edited_at FROM messages WHERE family_id=$1 AND server_message_id=$2 FOR UPDATE`, [params.familyId,params.serverMessageId]);
      const current = locked.rows[0];
      if (current && sameMessageClaim(current.author_claim, params.authorClaim)) {
        await client.query('COMMIT');
        return {chat_seq:Number(current.chat_seq),applied:false,edited_at:Number(current.edited_at)};
      }
      if (!current || Number(current.revision)+1 !== params.authorClaim.payload.revision) throw new MessageRevisionConflict();

      const chatSeq = await this.assignChatSeq(client, params.familyId, params.directChatId);
      await client.query(
        `UPDATE messages
         SET ciphertext = '',
             sender_ciphertext = NULL,
             sender_signature = '',
             author_claim = $3::jsonb,
             deleted_at = $4,
             content_updated_at = $4,
             revision = revision + 1,
             chat_seq = $5
         WHERE family_id = $1
           AND server_message_id = $2`,
        [params.familyId, params.serverMessageId, JSON.stringify(params.authorClaim), params.deletedAt, chatSeq]
      );
      await client.query('COMMIT');
      return { chat_seq: chatSeq, applied: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertReadCursor(
    familyId: string,
    readerIdentityId: IdentityId,
    peerIdentityId: IdentityId,
    readThrough: number,
    updatedAt: number
  ): Promise<void> {
    await pool.query(
      `INSERT INTO identity_read_cursors (family_id, reader_identity_id, peer_identity_id, read_through, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (family_id, reader_identity_id, peer_identity_id)
       DO UPDATE SET
         read_through = GREATEST(identity_read_cursors.read_through, EXCLUDED.read_through),
         updated_at = EXCLUDED.updated_at
       WHERE EXCLUDED.read_through > identity_read_cursors.read_through`,
      [familyId, readerIdentityId, peerIdentityId, readThrough, updatedAt]
    );
  }

  async fetchMessagesForReadProof(
    familyId: string,
    senderIdentityId: IdentityId,
    recipientIdentityId: IdentityId,
    serverMessageIds: string[]
  ): Promise<Array<{ server_message_id: string; created_at: number; status: MessageStatus; read_proof: DirectMessageReadProof | null }>> {
    const result = await pool.query<{ server_message_id: string; created_at: string; status: MessageStatus; read_proof: DirectMessageReadProof | null }>(
      `SELECT server_message_id, created_at, status, read_proof
       FROM messages
       WHERE family_id = $1 AND sender_identity_id = $2 AND recipient_identity_id = $3
         AND server_message_id = ANY($4::text[])`,
      [familyId, senderIdentityId, recipientIdentityId, serverMessageIds]
    );
    return result.rows.map((row) => ({ ...row, created_at: Number(row.created_at) }));
  }

  async recordReadProof(
    familyId: string,
    senderIdentityId: IdentityId,
    recipientIdentityId: IdentityId,
    serverMessageId: string,
    proof: DirectMessageReadProof,
    updatedAt: number
  ): Promise<boolean> {
    const result = await pool.query(
      `UPDATE messages
       SET read_proof = $5::jsonb, status = 'read', status_updated_at = $6
       WHERE family_id = $1 AND sender_identity_id = $2 AND recipient_identity_id = $3
         AND server_message_id = $4
         AND (read_proof IS NULL OR (read_proof->'receipt'->>'timestamp')::bigint > $7)`,
      [familyId, senderIdentityId, recipientIdentityId, serverMessageId, JSON.stringify(proof), updatedAt, proof.receipt.timestamp]
    );
    return (result.rowCount || 0) > 0;
  }

  async fetchReadCursors(
    familyId: string,
    readerIdentityId: IdentityId
  ): Promise<Array<{ peer_identity_id: string; read_through: number }>> {
    const result = await pool.query<{ peer_identity_id: string; read_through: string }>(
      `SELECT peer_identity_id, read_through
       FROM identity_read_cursors
       WHERE family_id = $1 AND reader_identity_id = $2`,
      [familyId, readerIdentityId]
    );
    return result.rows.map(row => ({
      peer_identity_id: row.peer_identity_id,
      read_through: Number(row.read_through),
    }));
  }

  async fetchUnreadMessagesFromUpTo(
    familyId: string,
    senderIdentityId: IdentityId,
    recipientIdentityId: IdentityId,
    readThrough: number
  ): Promise<Array<{ server_message_id: string; created_at: number }>> {
    const result = await pool.query<{ server_message_id: string; created_at: string }>(
      `SELECT server_message_id, created_at
       FROM messages
       WHERE family_id = $1
         AND sender_identity_id = $2
         AND recipient_identity_id = $3
         AND created_at <= $4
         AND status <> 'read'`,
      [familyId, senderIdentityId, recipientIdentityId, readThrough]
    );
    return result.rows.map((row) => ({ server_message_id: row.server_message_id, created_at: Number(row.created_at) }));
  }

  async cleanupExpiredMessages(defaultTtlHours: number, nowMs: number = Date.now()): Promise<number> {
    const result = await pool.query(
       `DELETE FROM messages AS m
       USING family_config AS fc
       WHERE m.family_id = fc.family_id
         AND NOT EXISTS (
           SELECT 1
             FROM circle_migrations cm
            WHERE cm.family_id = m.family_id
              AND cm.freeze_started_at IS NOT NULL
              AND cm.status NOT IN ('migrated', 'aborted')
         )
         AND m.created_at < (
           $1::bigint - (COALESCE(fc.message_ttl_hours, $2)::bigint * 60::bigint * 60::bigint * 1000::bigint)
         )`,
       [nowMs, defaultTtlHours]
     );
    return result.rowCount || 0;
  }
}

export const messageRepository = new MessageRepository();
