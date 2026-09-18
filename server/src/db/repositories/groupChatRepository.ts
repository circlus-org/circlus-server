import { rememberMessageSend } from '../../services/messageSendReceipt';
import { MessageRevisionConflict, sameMessageClaim } from '../../services/messageRevision';
import { transaction, pool } from '../index';
import type { PoolClient } from 'pg';
import type {
  DeviceId,
  GroupEpochTransitionClaim,
  GroupMessageAuthorClaim,
  GroupStateTransitionClaim,
  IdentityId,
  TemporaryIdentityDelegationCredential
} from '@shared/types';
import type {
  FindGroupChatResult,
  FindGroupChatParticipantResult,
  FindGroupChatKeyEnvelopeForIdentityResult,
  FindGroupChatEpochKeyResult,
  ListGroupChatMessagesResult,
} from './groupChatRepository.queries';
import {
  createGroupChat,
  insertGroupChatParticipant,
  ensureGroupChatReadState,
  findGroupChat,
  findGroupChatParticipant,
  listActiveGroupChatParticipants,
  setGroupChatParticipantMuted,
  renameGroupChat,
  reactivateGroupChatParticipant,
  removeGroupChatParticipant,
  setGroupChatOwner,
  bumpGroupChatKeyEpoch,
  findNextGroupChatOwner,
  updateGroupChatPreview,
  upsertGroupChatRead,
  upsertGroupChatKeyEnvelope,
  findGroupChatKeyEnvelopeForIdentity,
  findGroupChatEpochKeyCommitment,
  claimGroupChatEpochKey,
  findGroupChatEpochKey,
} from './groupChatRepository.queries';

export type GroupChatRecord = {
  chat_id: string;
  family_id: string;
  title_ciphertext: string;
  owner_identity_id: IdentityId;
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
  last_message_preview: string | null;
  key_epoch: number;
  protocol_version: number;
  state_sequence: number | null;
  state_transition_id: string | null;
  rekey_required_at: number | null;
  rekey_required_reason: 'device_revoked' | 'device_added' | null;
  rekey_required_identity_id: IdentityId | null;
};

export type GroupChatParticipantRecord = {
  chat_id: string;
  family_id: string;
  identity_id: IdentityId;
  added_by_identity_id: IdentityId;
  joined_at: number;
  left_at: number | null;
  is_active: boolean;
  join_order: number;
  muted: boolean;
};

export type GroupChatMessageRecord = {
  message_id: string;
  family_id: string;
  chat_id: string;
  chat_seq: number;
  sender_identity_id: IdentityId | null;
  sender_device_id: DeviceId | null;
  kind: 'user' | 'system';
  ciphertext: string | null;
  notification_preview_ciphertext: string | null;
  sender_signature: string | null;
  author_claim?: GroupMessageAuthorClaim | null;
  temporary_identity_delegation: TemporaryIdentityDelegationCredential | null;
  client_message_id: string | null;
  client_created_at: number | null;
  created_at: number;
  content_updated_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  revision: number;
  system_type: string | null;
  system_payload_json: string | null;
  epoch: number;
  read_by_identity_ids?: IdentityId[];
};



export type GroupChatKeyEnvelopeRecord = {
  chat_id: string;
  family_id: string;
  epoch: number;
  identity_id: IdentityId;
  envelope_ciphertext: string;
  publisher_identity_id: IdentityId;
  created_at: number;
};

export type GroupChatEpochKeyRecord = {
  chat_id: string;
  family_id: string;
  epoch: number;
  key_commitment: string;
  proposer_identity_id: IdentityId;
  proposer_device_id: DeviceId | null;
  signed_epoch_transition: GroupEpochTransitionClaim | null;
  created_at: number;
  state_transition_id?: string | null;
  signed_state_transition?: GroupStateTransitionClaim | null;
};

export type GroupChatStateTransitionRecord = {
  family_id: string;
  chat_id: string;
  sequence: number;
  transition_id: string;
  previous_transition_id: string | null;
  signed_transition: GroupStateTransitionClaim;
  created_at: number;
};

export class GroupChatStateConflictError extends Error {
  constructor() {
    super('group_state_conflict');
  }
}

function mapGroupChat(row: FindGroupChatResult): GroupChatRecord {
  const rowAny = row as FindGroupChatResult & {
    protocol_version?: number | null;
    state_sequence?: number | null;
    state_transition_id?: string | null;
    rekey_required_at?: number | string | null;
    rekey_required_reason?: 'device_revoked' | 'device_added' | null;
    rekey_required_identity_id?: string | null;
  };
  return {
    ...row,
    owner_identity_id: row.owner_identity_id as IdentityId,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_message_at: row.last_message_at === null ? null : Number(row.last_message_at),
    protocol_version: Number(rowAny.protocol_version || 1),
    state_sequence: rowAny.state_sequence == null ? null : Number(rowAny.state_sequence),
    state_transition_id: rowAny.state_transition_id || null,
    rekey_required_at: rowAny.rekey_required_at == null ? null : Number(rowAny.rekey_required_at),
    rekey_required_reason: rowAny.rekey_required_reason || null,
    rekey_required_identity_id: (rowAny.rekey_required_identity_id as IdentityId | null | undefined) || null,
  };
}

function mapGroupChatParticipant(row: FindGroupChatParticipantResult): GroupChatParticipantRecord {
  return {
    ...row,
    identity_id: row.identity_id as IdentityId,
    added_by_identity_id: row.added_by_identity_id as IdentityId,
    joined_at: Number(row.joined_at),
    left_at: row.left_at === null ? null : Number(row.left_at),
  };
}

function mapGroupChatMessage(row: ListGroupChatMessagesResult): GroupChatMessageRecord {
  const rowAny = row as ListGroupChatMessagesResult & {
    chat_seq?: string | number | null;
    content_updated_at?: string | number | null;
    edited_at?: string | number | null;
    deleted_at?: string | number | null;
    revision?: number | null;
    temporary_identity_delegation?: TemporaryIdentityDelegationCredential | string | null;
    read_by_identity_ids?: IdentityId[] | string | null;
    notification_preview_ciphertext?: string | null;
    author_claim?: GroupMessageAuthorClaim | string | null;
  };
  const readByIdentityIds = Array.isArray(rowAny.read_by_identity_ids)
    ? rowAny.read_by_identity_ids
    : typeof rowAny.read_by_identity_ids === 'string'
      ? rowAny.read_by_identity_ids.replace(/[{}]/g, '').split(',').map((id) => id.trim()).filter(Boolean)
      : undefined;
  return {
    ...row,
    chat_seq: rowAny.chat_seq == null ? 0 : Number(rowAny.chat_seq),
    sender_identity_id: row.sender_identity_id as IdentityId | null,
    sender_device_id: row.sender_device_id as DeviceId | null,
    kind: row.kind as GroupChatMessageRecord['kind'],
    notification_preview_ciphertext: rowAny.notification_preview_ciphertext ?? null,
    author_claim: parseJsonField<GroupMessageAuthorClaim>(rowAny.author_claim),
    temporary_identity_delegation: parseJsonField<TemporaryIdentityDelegationCredential>(rowAny.temporary_identity_delegation),
    client_created_at: row.client_created_at === null ? null : Number(row.client_created_at),
    created_at: Number(row.created_at),
    content_updated_at: Number(rowAny.content_updated_at ?? row.created_at),
    edited_at: rowAny.edited_at == null ? null : Number(rowAny.edited_at),
    deleted_at: rowAny.deleted_at == null ? null : Number(rowAny.deleted_at),
    revision: Number(rowAny.revision ?? 1),
    read_by_identity_ids: readByIdentityIds as IdentityId[] | undefined,
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

function mapGroupChatKeyEnvelope(row: FindGroupChatKeyEnvelopeForIdentityResult): GroupChatKeyEnvelopeRecord {
  return {
    ...row,
    identity_id: row.identity_id as IdentityId,
    publisher_identity_id: row.publisher_identity_id as IdentityId,
    created_at: Number(row.created_at),
  };
}

function mapGroupChatStateTransition(row: {
  family_id: string;
  chat_id: string;
  sequence: number | string;
  transition_id: string;
  previous_transition_id: string | null;
  signed_transition: GroupStateTransitionClaim | string;
  created_at: number | string;
}): GroupChatStateTransitionRecord {
  return {
    ...row,
    sequence: Number(row.sequence),
    signed_transition: typeof row.signed_transition === 'string'
      ? JSON.parse(row.signed_transition) as GroupStateTransitionClaim
      : row.signed_transition,
    created_at: Number(row.created_at)
  };
}

function mapGroupChatEpochKey(row: FindGroupChatEpochKeyResult): GroupChatEpochKeyRecord {
  const rowAny = row as FindGroupChatEpochKeyResult & {
    proposer_device_id?: string | null;
    signed_epoch_transition?: GroupEpochTransitionClaim | string | null;
  };
  const signed = rowAny.signed_epoch_transition;
  return {
    ...row,
    proposer_identity_id: row.proposer_identity_id as IdentityId,
    proposer_device_id: (rowAny.proposer_device_id as DeviceId | null) ?? null,
    signed_epoch_transition: typeof signed === 'string'
      ? JSON.parse(signed) as GroupEpochTransitionClaim
      : (signed ?? null),
    created_at: Number(row.created_at),
  };
}

export class GroupChatRepository {
  async createChat(params: {
    chatId: string;
    familyId: string;
    titleCiphertext: string;
    ownerIdentityId: IdentityId;
    participantIds: IdentityId[];
    createdAt: number;
  }): Promise<void> {
    await transaction(async (client) => {
      await createGroupChat.run({
        chatId: params.chatId,
        familyId: params.familyId,
        titleCiphertext: params.titleCiphertext,
        ownerIdentityId: params.ownerIdentityId,
        createdAt: params.createdAt,
        updatedAt: params.createdAt,
      }, client);

      const ordered = Array.from(new Set([params.ownerIdentityId, ...params.participantIds]));
      for (let i = 0; i < ordered.length; i += 1) {
        const identityId = ordered[i];
        await insertGroupChatParticipant.run({
          chatId: params.chatId,
          familyId: params.familyId,
          identityId,
          addedByIdentityId: params.ownerIdentityId,
          joinedAt: params.createdAt,
          joinOrder: i + 1
        }, client);

        await ensureGroupChatReadState.run({
          chatId: params.chatId,
          familyId: params.familyId,
          identityId,
          lastReadAt: 0,
        }, client);
      }
    });
  }

  async createV2Chat(params: {
    chatId: string;
    familyId: string;
    titleCiphertext: string;
    ownerIdentityId: IdentityId;
    participantIds: IdentityId[];
    transition: GroupStateTransitionClaim;
    keyCommitment: string;
    envelopes: Array<{ identityId: IdentityId; envelopeCiphertext: string }>;
    createdAt: number;
  }): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO group_chats
          (chat_id, family_id, title_ciphertext, owner_identity_id, created_at, updated_at, key_epoch,
           key_epoch_updated_at, protocol_version, state_sequence, state_transition_id)
         VALUES ($1, $2, $3, $4, $5, $5, 1, $5, 2, 1, $6)`,
        [params.chatId, params.familyId, params.titleCiphertext, params.ownerIdentityId, params.createdAt, params.transition.payload.transitionId]
      );
      for (let index = 0; index < params.participantIds.length; index += 1) {
        const identityId = params.participantIds[index]!;
        await insertGroupChatParticipant.run({
          chatId: params.chatId,
          familyId: params.familyId,
          identityId,
          addedByIdentityId: params.ownerIdentityId,
          joinedAt: params.createdAt,
          joinOrder: index + 1
        }, client);
        await ensureGroupChatReadState.run({
          chatId: params.chatId,
          familyId: params.familyId,
          identityId,
          lastReadAt: 0
        }, client);
      }
      await client.query(
        `INSERT INTO group_chat_state_transitions
          (family_id, chat_id, sequence, transition_id, previous_transition_id, signed_transition, created_at)
         VALUES ($1, $2, 1, $3, NULL, $4::jsonb, $5)`,
        [params.familyId, params.chatId, params.transition.payload.transitionId, JSON.stringify(params.transition), params.createdAt]
      );
      await client.query(
        `INSERT INTO group_chat_epoch_keys
          (chat_id, family_id, epoch, key_commitment, proposer_identity_id, proposer_device_id,
           signed_epoch_transition, state_transition_id, signed_state_transition, created_at)
         VALUES ($1, $2, 1, $3, $4, NULL, NULL, $5, $6::jsonb, $7)`,
        [params.chatId, params.familyId, params.keyCommitment, params.ownerIdentityId, params.transition.payload.transitionId, JSON.stringify(params.transition), params.createdAt]
      );
      await this.upsertKeyEnvelopes({
        familyId: params.familyId,
        chatId: params.chatId,
        epoch: 1,
        createdAt: params.createdAt,
        envelopes: params.envelopes.map((envelope) => ({
          ...envelope,
          publisherIdentityId: params.ownerIdentityId
        }))
      }, client);
    });
  }

  async findChat(familyId: string, chatId: string, client?: PoolClient): Promise<GroupChatRecord | null> {
    const results = await findGroupChat.run({ familyId, chatId }, client || pool);
    return results[0] ? mapGroupChat(results[0]) : null;
  }

  async findChatsByIds(familyId: string, chatIds: string[]): Promise<GroupChatRecord[]> {
    if (chatIds.length === 0) return [];

    const result = await pool.query<FindGroupChatResult>(
      `SELECT *
       FROM group_chats
       WHERE family_id = $1
         AND chat_id = ANY($2::text[])`,
      [familyId, chatIds]
    );
    return result.rows.map(mapGroupChat);
  }

  async findParticipant(
    familyId: string,
    chatId: string,
    identityId: IdentityId,
    client?: PoolClient
  ): Promise<GroupChatParticipantRecord | null> {
    const results = await findGroupChatParticipant.run({ familyId, chatId, identityId }, client || pool);
    return results[0] ? mapGroupChatParticipant(results[0]) : null;
  }

  async listActiveParticipants(
    familyId: string,
    chatId: string,
    client?: PoolClient
  ): Promise<GroupChatParticipantRecord[]> {
    const results = await listActiveGroupChatParticipants.run({ familyId, chatId }, client || pool);
    return results.map(mapGroupChatParticipant);
  }

  async listChatsForIdentity(familyId: string, identityId: IdentityId): Promise<Array<GroupChatRecord & { participant_count: number; unread_count: number; muted: boolean }>> {
    const result = await pool.query<GroupChatRecord & { participant_count: string; unread_count: string; muted: boolean }>(
      `SELECT c.*, 
              p.muted,
              (SELECT COUNT(*)::text FROM group_chat_participants p2 WHERE p2.family_id = c.family_id AND p2.chat_id = c.chat_id AND p2.is_active = TRUE) AS participant_count,
              (
                SELECT COUNT(*)::text
                FROM group_chat_messages m
                LEFT JOIN group_chat_reads r
                  ON r.chat_id = c.chat_id AND r.family_id = c.family_id AND r.identity_id = $2
                WHERE m.family_id = c.family_id
                  AND m.chat_id = c.chat_id
                  AND m.created_at > COALESCE(r.last_read_at, 0)
                  AND m.kind = 'user'
                  AND m.sender_identity_id IS DISTINCT FROM $2
              ) AS unread_count
       FROM group_chats c
       JOIN group_chat_participants p
         ON p.family_id = c.family_id AND p.chat_id = c.chat_id
       WHERE c.family_id = $1
         AND p.identity_id = $2
         AND p.is_active = TRUE
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      [familyId, identityId]
    );

    return result.rows.map((row) => ({
      ...row,
      owner_identity_id: row.owner_identity_id as IdentityId,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      last_message_at: row.last_message_at === null ? null : Number(row.last_message_at),
      rekey_required_at: row.rekey_required_at == null ? null : Number(row.rekey_required_at),
      participant_count: Number(row.participant_count ?? '0'),
      unread_count: Number(row.unread_count ?? '0'),
    }));
  }

  async setMuted(
    familyId: string,
    chatId: string,
    identityId: IdentityId,
    muted: boolean
  ): Promise<void> {
    await setGroupChatParticipantMuted.run({ familyId, chatId, identityId, muted }, pool);
  }

  async renameChat(
    familyId: string,
    chatId: string,
    titleCiphertext: string,
    updatedAt: number,
    client?: PoolClient
  ): Promise<void> {
    await renameGroupChat.run({ familyId, chatId, titleCiphertext, updatedAt }, client || pool);
  }

  async addParticipants(
    familyId: string,
    chatId: string,
    addedByIdentityId: IdentityId,
    participantIds: IdentityId[],
    joinedAt: number,
    client?: PoolClient
  ): Promise<IdentityId[]> {
    const db = client || pool;
    const current = await this.listActiveParticipants(familyId, chatId, client);
    let nextOrder = current.length + 1;
    const added: IdentityId[] = [];

    for (const identityId of participantIds) {
      const existing = await this.findParticipant(familyId, chatId, identityId, client);
      if (existing?.is_active) continue;

      if (!existing) {
        await insertGroupChatParticipant.run({
          chatId,
          familyId,
          identityId,
          addedByIdentityId,
          joinedAt,
          joinOrder: nextOrder
        }, db);
      } else {
        await reactivateGroupChatParticipant.run({
          joinedAt,
          addedByIdentityId,
          joinOrder: nextOrder,
          familyId,
          chatId,
          identityId,
        }, db);
      }

      await ensureGroupChatReadState.run({ chatId, familyId, identityId, lastReadAt: 0 }, db);

      added.push(identityId);
      nextOrder += 1;
    }

    return added;
  }

  async removeParticipant(
    familyId: string,
    chatId: string,
    identityId: IdentityId,
    leftAt: number,
    client?: PoolClient
  ): Promise<void> {
    await removeGroupChatParticipant.run({ leftAt, familyId, chatId, identityId }, client || pool);
  }

  async setOwner(
    familyId: string,
    chatId: string,
    ownerIdentityId: IdentityId,
    updatedAt: number,
    client?: PoolClient
  ): Promise<void> {
    await setGroupChatOwner.run({ ownerIdentityId, updatedAt, familyId, chatId }, client || pool);
  }



  async bumpKeyEpoch(familyId: string, chatId: string, client?: PoolClient): Promise<number> {
    const results = await bumpGroupChatKeyEpoch.run({ updatedAt: Date.now(), familyId, chatId }, client || pool);
    return results[0]?.key_epoch || 1;
  }

  async bumpKeyEpochIfStale(familyId: string, chatId: string, maxAgeMs: number): Promise<{ bumped: boolean; keyEpoch: number }> {
    const now = Date.now();
    const result = await pool.query<{ key_epoch: number }>(
      `UPDATE group_chats
       SET key_epoch = key_epoch + 1,
           key_epoch_updated_at = $4,
           updated_at = $4
       WHERE family_id = $1
         AND chat_id = $2
         AND COALESCE(key_epoch_updated_at, updated_at, created_at, 0) <= $3
       RETURNING key_epoch`,
      [familyId, chatId, now - maxAgeMs, now]
    );
    if (result.rows[0]) return { bumped: true, keyEpoch: Number(result.rows[0].key_epoch) };
    const chat = await this.findChat(familyId, chatId);
    return { bumped: false, keyEpoch: chat?.key_epoch || 1 };
  }

  async findNextOwner(familyId: string, chatId: string, client?: PoolClient): Promise<IdentityId | null> {
    const results = await findNextGroupChatOwner.run({ familyId, chatId }, client || pool);
    return (results[0]?.identity_id as IdentityId | undefined) || null;
  }

  async findByClientMessageId(
    familyId: string,
    chatId: string,
    senderDeviceId: DeviceId,
    clientMessageId: string
  ): Promise<Pick<GroupChatMessageRecord, 'message_id' | 'created_at'> | null> {
    const receipt = await pool.query(`SELECT message_id,created_at FROM message_send_receipts WHERE family_id=$1 AND scope=$2 AND device_id=$3 AND client_message_id=$4`,[familyId,'group:'+chatId,senderDeviceId,clientMessageId]);
    return receipt.rows[0] || null;
  }

  private async assignGroupChatSeq(
    client: PoolClient,
    familyId: string,
    chatId: string
  ): Promise<number> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1 || $2))', [familyId, chatId]);
    const result = await client.query<{ last_seq: string }>(
      `INSERT INTO group_chat_seq (family_id, chat_id, last_seq)
       VALUES ($1, $2, 1)
       ON CONFLICT (family_id, chat_id)
       DO UPDATE SET last_seq = group_chat_seq.last_seq + 1
       RETURNING last_seq`,
      [familyId, chatId]
    );
    return Number(result.rows[0].last_seq);
  }

  async insertMessage(record: GroupChatMessageRecord, externalClient?: PoolClient): Promise<{ chat_seq: number }> {
    const client = externalClient || await pool.connect();
    const ownsTransaction = !externalClient;
    let chatSeq = 0;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      if (record.kind === 'user' && record.sender_device_id && record.client_message_id) {
        await rememberMessageSend(client, record.family_id, 'group:'+record.chat_id, record.sender_device_id, record.client_message_id, record.message_id, record.created_at);
      }

      chatSeq = await this.assignGroupChatSeq(client, record.family_id, record.chat_id);
      await client.query(
        `INSERT INTO group_chat_messages
          (message_id, family_id, chat_id, chat_seq, sender_identity_id, sender_device_id, kind, ciphertext, notification_preview_ciphertext, sender_signature, author_claim, temporary_identity_delegation, client_message_id, client_created_at, created_at, content_updated_at, revision, system_type, system_payload_json, epoch)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $15, 1, $16, $17, $18)`,
        [
          record.message_id,
          record.family_id,
          record.chat_id,
          chatSeq,
          record.sender_identity_id,
          record.sender_device_id,
          record.kind,
          record.ciphertext,
          record.notification_preview_ciphertext,
          record.sender_signature,
          record.author_claim ? JSON.stringify(record.author_claim) : null,
          record.temporary_identity_delegation ? JSON.stringify(record.temporary_identity_delegation) : null,
          record.client_message_id,
          record.client_created_at,
          record.created_at,
          record.system_type,
          record.system_payload_json,
          record.epoch ?? 1,
        ]
      );
      const preview = record.kind === 'user' ? '[encrypted]' : `[${record.system_type || 'system'}]`;
      await updateGroupChatPreview.run({
        createdAt: record.created_at,
        preview,
        familyId: record.family_id,
        chatId: record.chat_id,
      }, client);
      if (ownsTransaction) await client.query('COMMIT');
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
    return { chat_seq: chatSeq };
  }

  async findMessageById(
    familyId: string,
    chatId: string,
    messageId: string
  ): Promise<GroupChatMessageRecord | null> {
    const result = await pool.query<ListGroupChatMessagesResult>(
      `SELECT *
       FROM group_chat_messages
       WHERE family_id = $1
         AND chat_id = $2
         AND message_id = $3
       LIMIT 1`,
      [familyId, chatId, messageId]
    );
    return result.rows[0] ? mapGroupChatMessage(result.rows[0]) : null;
  }

  async findLatestSystemMessageBySenderAndType(
    familyId: string,
    chatId: string,
    senderIdentityId: IdentityId,
    systemType: string
  ): Promise<GroupChatMessageRecord | null> {
    const result = await pool.query<ListGroupChatMessagesResult>(
      `SELECT *
       FROM group_chat_messages
       WHERE family_id = $1
         AND chat_id = $2
         AND sender_identity_id = $3
         AND kind = 'system'
         AND system_type = $4
       ORDER BY chat_seq DESC
       LIMIT 1`,
      [familyId, chatId, senderIdentityId, systemType]
    );
    return result.rows[0] ? mapGroupChatMessage(result.rows[0]) : null;
  }

  async listMessages(
    familyId: string,
    chatId: string,
    since: number,
    limit: number
  ): Promise<GroupChatMessageRecord[]> {
    const results = await pool.query<ListGroupChatMessagesResult>(
      `SELECT m.*,
              COALESCE(
                ARRAY(
                  SELECT r.identity_id
                  FROM group_chat_reads r
                  JOIN group_chat_participants p
                    ON p.family_id = r.family_id
                   AND p.chat_id = r.chat_id
                   AND p.identity_id = r.identity_id
                   AND p.is_active = TRUE
                  WHERE r.family_id = m.family_id
                    AND r.chat_id = m.chat_id
                    AND r.last_read_at >= m.created_at
                    AND r.identity_id IS DISTINCT FROM m.sender_identity_id
                  ORDER BY p.join_order ASC
                ),
                ARRAY[]::text[]
              ) AS read_by_identity_ids
       FROM group_chat_messages m
       WHERE m.family_id = $1
         AND m.chat_id = $2
         AND m.chat_seq > $3
       ORDER BY chat_seq ASC
       LIMIT $4`,
      [familyId, chatId, since, limit]
    );
    return results.rows.map(mapGroupChatMessage);
  }

  async listMessageReaders(
    familyId: string,
    chatId: string,
    messageId: string
  ): Promise<IdentityId[]> {
    const result = await pool.query<{ identity_id: IdentityId }>(
      `SELECT r.identity_id
       FROM group_chat_messages m
       JOIN group_chat_reads r
         ON r.family_id = m.family_id
        AND r.chat_id = m.chat_id
        AND r.last_read_at >= m.created_at
       JOIN group_chat_participants p
         ON p.family_id = r.family_id
        AND p.chat_id = r.chat_id
        AND p.identity_id = r.identity_id
        AND p.is_active = TRUE
       WHERE m.family_id = $1
         AND m.chat_id = $2
         AND m.message_id = $3
         AND r.identity_id IS DISTINCT FROM m.sender_identity_id
       ORDER BY p.join_order ASC`,
      [familyId, chatId, messageId]
    );
    return result.rows.map((row) => row.identity_id as IdentityId);
  }

  async deleteChatMessages(familyId: string, chatId: string, clearThroughSequence: number): Promise<number> {
    const result = await pool.query(
      `DELETE FROM group_chat_messages
       WHERE family_id = $1
         AND chat_id = $2 AND chat_seq <= $3`,
      [familyId, chatId, clearThroughSequence]
    );
    await pool.query(
      `UPDATE group_chats
       SET last_message_at = NULL,
           last_message_preview = NULL,
           updated_at = $3
       WHERE family_id = $1
         AND chat_id = $2 AND NOT EXISTS (SELECT 1 FROM group_chat_messages m WHERE m.family_id=$1 AND m.chat_id=$2)`,
      [familyId, chatId, Date.now()]
    );
    return result.rowCount || 0;
  }

  async editMessage(params: {
    familyId: string;
    chatId: string;
    messageId: string;
    ciphertext: string;
    senderSignature: string;
    authorClaim: GroupMessageAuthorClaim;
    editedAt: number;
  }): Promise<{ chat_seq: number; applied?: boolean; edited_at?: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT author_claim,revision,chat_seq,edited_at FROM group_chat_messages WHERE family_id=$1 AND message_id=$2 FOR UPDATE`, [params.familyId,params.messageId]);
      const current = locked.rows[0];
      if (current && sameMessageClaim(current.author_claim, params.authorClaim)) {
        await client.query('COMMIT');
        return {chat_seq:Number(current.chat_seq),applied:false,edited_at:Number(current.edited_at)};
      }
      if (!current || Number(current.revision)+1 !== params.authorClaim.payload.revision) throw new MessageRevisionConflict();

      const chatSeq = await this.assignGroupChatSeq(client, params.familyId, params.chatId);
      await client.query(
        `UPDATE group_chat_messages
         SET ciphertext = $4,
             sender_signature = $5,
             author_claim = $6::jsonb,
             edited_at = $7,
             content_updated_at = $7,
             revision = revision + 1,
             chat_seq = $8
         WHERE family_id = $1
           AND chat_id = $2
           AND message_id = $3`,
        [params.familyId, params.chatId, params.messageId, params.ciphertext, params.senderSignature, JSON.stringify(params.authorClaim), params.editedAt, chatSeq]
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

  async softDeleteMessage(params: {
    familyId: string;
    chatId: string;
    messageId: string;
    deletedAt: number;
    authorClaim: GroupMessageAuthorClaim;
  }): Promise<{ chat_seq: number; applied?: boolean; edited_at?: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT author_claim,revision,chat_seq,edited_at FROM group_chat_messages WHERE family_id=$1 AND message_id=$2 FOR UPDATE`, [params.familyId,params.messageId]);
      const current = locked.rows[0];
      if (current && sameMessageClaim(current.author_claim, params.authorClaim)) {
        await client.query('COMMIT');
        return {chat_seq:Number(current.chat_seq),applied:false,edited_at:Number(current.edited_at)};
      }
      if (!current || Number(current.revision)+1 !== params.authorClaim.payload.revision) throw new MessageRevisionConflict();

      const chatSeq = await this.assignGroupChatSeq(client, params.familyId, params.chatId);
      await client.query(
        `UPDATE group_chat_messages
         SET ciphertext = '',
             sender_signature = NULL,
             author_claim = $4::jsonb,
             deleted_at = $5,
             content_updated_at = $5,
             revision = revision + 1,
             chat_seq = $6
         WHERE family_id = $1
           AND chat_id = $2
           AND message_id = $3`,
        [params.familyId, params.chatId, params.messageId, JSON.stringify(params.authorClaim), params.deletedAt, chatSeq]
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

  async markRead(familyId: string, chatId: string, identityId: IdentityId, readAt: number): Promise<void> {
    await upsertGroupChatRead.run({ chatId, familyId, identityId, readAt }, pool);
  }

  async upsertKeyEnvelopes(params: {
    familyId: string;
    chatId: string;
    epoch: number;
    createdAt: number;
    envelopes: Array<{ identityId: IdentityId; envelopeCiphertext: string; publisherIdentityId: IdentityId }>;
  }, client?: PoolClient): Promise<void> {
    if (params.envelopes.length === 0) return;

    for (const envelope of params.envelopes) {
      await upsertGroupChatKeyEnvelope.run({
        chatId: params.chatId,
        familyId: params.familyId,
        epoch: params.epoch,
        identityId: envelope.identityId,
        envelopeCiphertext: envelope.envelopeCiphertext,
        publisherIdentityId: envelope.publisherIdentityId,
        createdAt: params.createdAt,
      }, client || pool);
    }
  }

  async findKeyEnvelopeForIdentity(
    familyId: string,
    chatId: string,
    epoch: number,
    identityId: IdentityId
  ): Promise<GroupChatKeyEnvelopeRecord | null> {
    const results = await findGroupChatKeyEnvelopeForIdentity.run({ familyId, chatId, epoch, identityId }, pool);
    return results[0] ? mapGroupChatKeyEnvelope(results[0]) : null;
  }

  async listKeyEnvelopeIdentityIds(
    familyId: string,
    chatId: string,
    epoch: number,
    identityIds: IdentityId[]
  ): Promise<IdentityId[]> {
    if (identityIds.length === 0) return [];

    const result = await pool.query<{ identity_id: string }>(
      `SELECT identity_id
       FROM group_chat_key_envelopes
       WHERE family_id = $1
         AND chat_id = $2
         AND epoch = $3
         AND identity_id = ANY($4::text[])`,
      [familyId, chatId, epoch, identityIds]
    );
    return result.rows.map((row) => row.identity_id as IdentityId);
  }

  async findEpochKeyCommitment(
    familyId: string,
    chatId: string,
    epoch: number
  ): Promise<string | null> {
    const results = await findGroupChatEpochKeyCommitment.run({ chatId, familyId, epoch }, pool);
    return results[0]?.key_commitment || null;
  }

  async findEpochKey(
    familyId: string,
    chatId: string,
    epoch: number
  ): Promise<GroupChatEpochKeyRecord | null> {
    const results = await findGroupChatEpochKey.run({ chatId, familyId, epoch }, pool);
    return results[0] ? mapGroupChatEpochKey(results[0]) : null;
  }

  async listActiveParticipantsWithIdentityKeys(
    familyId: string,
    chatId: string
  ): Promise<Array<Pick<GroupChatParticipantRecord, 'identity_id' | 'join_order' | 'joined_at'> & { public_key_algorithm: 'ed25519' | 'x25519'; public_key_value: string }>> {
    const result = await pool.query<{
      identity_id: string;
      join_order: number;
      joined_at: number | string;
      public_key_algorithm: 'ed25519' | 'x25519';
      public_key_value: string;
    }>(
      `SELECT p.identity_id, p.join_order, p.joined_at, i.public_key_algorithm, i.public_key_value
       FROM group_chat_participants p
       JOIN identities i
         ON i.identity_id = p.identity_id
        AND i.family_id::text = p.family_id::text
       WHERE p.family_id = $1
         AND p.chat_id = $2
         AND p.is_active = TRUE
       ORDER BY p.join_order ASC`,
      [familyId, chatId]
    );
    return result.rows.map((row) => ({
      identity_id: row.identity_id as IdentityId,
      join_order: row.join_order,
      joined_at: Number(row.joined_at),
      public_key_algorithm: row.public_key_algorithm as 'ed25519' | 'x25519',
      public_key_value: row.public_key_value,
    }));
  }

  async claimEpochKey(params: {
    familyId: string;
    chatId: string;
    epoch: number;
    keyCommitment: string;
    proposerIdentityId: IdentityId;
    proposerDeviceId: DeviceId;
    signedEpochTransition: GroupEpochTransitionClaim;
    createdAt: number;
  }, client?: PoolClient): Promise<{ won: boolean; existing: GroupChatEpochKeyRecord | null }> {
    const db = client || pool;
    const inserted = await claimGroupChatEpochKey.run({
      chatId: params.chatId,
      familyId: params.familyId,
      epoch: params.epoch,
      keyCommitment: params.keyCommitment,
      proposerIdentityId: params.proposerIdentityId,
      proposerDeviceId: params.proposerDeviceId,
      signedEpochTransition: params.signedEpochTransition as any,
      createdAt: params.createdAt,
    }, db);

    if (inserted[0]) {
      return { won: true, existing: mapGroupChatEpochKey(inserted[0]) };
    }

    const existingResult = await findGroupChatEpochKey.run({
      chatId: params.chatId,
      familyId: params.familyId,
      epoch: params.epoch,
    }, db);

    return { won: false, existing: existingResult[0] ? mapGroupChatEpochKey(existingResult[0]) : null };
  }

  async listStateTransitions(familyId: string, chatId: string): Promise<GroupChatStateTransitionRecord[]> {
    const result = await pool.query<{
      family_id: string;
      chat_id: string;
      sequence: number | string;
      transition_id: string;
      previous_transition_id: string | null;
      signed_transition: GroupStateTransitionClaim | string;
      created_at: number | string;
    }>(
      `SELECT family_id::text, chat_id, sequence, transition_id, previous_transition_id, signed_transition, created_at
       FROM group_chat_state_transitions
       WHERE family_id = $1 AND chat_id = $2
       ORDER BY sequence ASC`,
      [familyId, chatId]
    );
    return result.rows.map(mapGroupChatStateTransition);
  }

  async findCurrentStateTransition(
    familyId: string,
    chatId: string,
    client?: PoolClient
  ): Promise<GroupChatStateTransitionRecord | null> {
    const result = await (client || pool).query<{
      family_id: string;
      chat_id: string;
      sequence: number | string;
      transition_id: string;
      previous_transition_id: string | null;
      signed_transition: GroupStateTransitionClaim | string;
      created_at: number | string;
    }>(
      `SELECT family_id::text, chat_id, sequence, transition_id, previous_transition_id, signed_transition, created_at
       FROM group_chat_state_transitions
       WHERE family_id = $1 AND chat_id = $2
       ORDER BY sequence DESC
       LIMIT 1`,
      [familyId, chatId]
    );
    return result.rows[0] ? mapGroupChatStateTransition(result.rows[0]) : null;
  }

  async applyV2StateTransition(params: {
    familyId: string;
    chatId: string;
    transition: GroupStateTransitionClaim;
    envelopes: Array<{ identityId: IdentityId; envelopeCiphertext: string }>;
    createdAt: number;
    systemMessage?: GroupChatMessageRecord;
  }): Promise<{ previousParticipantIds: IdentityId[]; systemMessageChatSeq: number | null }> {
    return transaction(async (client) => {
      const locked = await client.query<{
        protocol_version: number;
        state_sequence: number | null;
        state_transition_id: string | null;
      }>(
        `SELECT protocol_version, state_sequence, state_transition_id
         FROM group_chats
         WHERE family_id = $1 AND chat_id = $2
         FOR UPDATE`,
        [params.familyId, params.chatId]
      );
      const chat = locked.rows[0];
      const payload = params.transition.payload;
      if (
        !chat
        || Number(chat.protocol_version) !== 2
        || Number(chat.state_sequence) + 1 !== payload.sequence
        || chat.state_transition_id !== payload.previousTransitionId
      ) throw new GroupChatStateConflictError();

      const previousRows = await this.listActiveParticipants(params.familyId, params.chatId, client);
      const previousParticipantIds = previousRows.map((row) => row.identity_id);
      const nextIds = new Set(payload.participantIdentityIds);
      for (const row of previousRows) {
        if (!nextIds.has(row.identity_id)) {
          await removeGroupChatParticipant.run({
            familyId: params.familyId,
            chatId: params.chatId,
            identityId: row.identity_id,
            leftAt: params.createdAt
          }, client);
        }
      }
      for (let index = 0; index < payload.participantIdentityIds.length; index += 1) {
        const identityId = payload.participantIdentityIds[index]!;
        const existing = await this.findParticipant(params.familyId, params.chatId, identityId, client);
        if (!existing) {
          await insertGroupChatParticipant.run({
            familyId: params.familyId,
            chatId: params.chatId,
            identityId,
            addedByIdentityId: params.transition.signerId,
            joinedAt: params.createdAt,
            joinOrder: index + 1
          }, client);
        } else if (!existing.is_active) {
          await reactivateGroupChatParticipant.run({
            familyId: params.familyId,
            chatId: params.chatId,
            identityId,
            addedByIdentityId: params.transition.signerId,
            joinedAt: params.createdAt,
            joinOrder: index + 1
          }, client);
        }
        await ensureGroupChatReadState.run({
          familyId: params.familyId,
          chatId: params.chatId,
          identityId,
          lastReadAt: 0
        }, client);
      }

      await client.query(
        `INSERT INTO group_chat_state_transitions
          (family_id, chat_id, sequence, transition_id, previous_transition_id, signed_transition, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          params.familyId,
          params.chatId,
          payload.sequence,
          payload.transitionId,
          payload.previousTransitionId,
          JSON.stringify(params.transition),
          params.createdAt
        ]
      );
      await client.query(
        `UPDATE group_chats
         SET owner_identity_id = $3,
             title_ciphertext = $4,
             key_epoch = $5,
             key_epoch_updated_at = CASE WHEN key_epoch <> $5 THEN $6 ELSE key_epoch_updated_at END,
             updated_at = $6,
             state_sequence = $7,
             state_transition_id = $8,
             rekey_required_at = CASE WHEN key_epoch <> $5 THEN NULL ELSE rekey_required_at END,
             rekey_required_reason = CASE WHEN key_epoch <> $5 THEN NULL ELSE rekey_required_reason END,
             rekey_required_identity_id = CASE WHEN key_epoch <> $5 THEN NULL ELSE rekey_required_identity_id END
         WHERE family_id = $1 AND chat_id = $2`,
        [
          params.familyId,
          params.chatId,
          payload.ownerIdentityId,
          payload.titleCiphertext,
          payload.epoch,
          params.createdAt,
          payload.sequence,
          payload.transitionId
        ]
      );

      if (params.envelopes.length > 0) {
        await client.query(
          `INSERT INTO group_chat_epoch_keys
            (chat_id, family_id, epoch, key_commitment, proposer_identity_id, proposer_device_id,
             signed_epoch_transition, state_transition_id, signed_state_transition, created_at)
           VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7::jsonb, $8)`,
          [
            params.chatId,
            params.familyId,
            payload.epoch,
            payload.keyCommitment,
            params.transition.signerId,
            payload.transitionId,
            JSON.stringify(params.transition),
            params.createdAt
          ]
        );
        await this.upsertKeyEnvelopes({
          familyId: params.familyId,
          chatId: params.chatId,
          epoch: payload.epoch,
          createdAt: params.createdAt,
          envelopes: params.envelopes.map((envelope) => ({
            ...envelope,
            publisherIdentityId: params.transition.signerId
          }))
        }, client);
      }
      const systemMessageChatSeq = params.systemMessage
        ? (await this.insertMessage(params.systemMessage, client)).chat_seq
        : null;
      return { previousParticipantIds, systemMessageChatSeq };
    });
  }

}

export const groupChatRepository = new GroupChatRepository();
