import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { query, transaction } from '../db';
import { groupChatRepository, identityRepository, messageRepository } from '../db/repositories';
import { resolveDirectCommunicationAccess } from '../services/directGuestAccessService';
import { hasPendingGroupLeaveRequest } from './groupChatsAccess';
import { verifySignedRequest } from '../utils/crypto';
import { sendDirectChatWsEvent, sendGroupChatWsEvent } from '../ws/wsGateway';
import { MAX_REACTION_MESSAGES, validReactionPayload, type ReactionClaim, type ReactionRecord, type ReactionScope } from '../../../shared/messageReactions';
import type { PublicKey } from '../../../shared/types';

class ReactionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function messageReactionsHandler(scope: ReactionScope, write: boolean) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const familyId = req.familyId!;
      const actor = req.device!.identityId;
      const input = req.signedRequest?.payload as { peerIdentityId?: string; messageIds?: string[]; claim?: ReactionClaim };
      const peer = typeof input?.peerIdentityId === 'string' ? input.peerIdentityId : '';
      const chatId = scope === 'group' ? req.params.chatId : [actor, peer].sort().join('::');
      if (!chatId || (scope === 'direct' && !peer)) throw new ReactionError(400, 'INVALID_REQUEST');
      let participants: string[];
      let groupEpoch: number | undefined;
      if (scope === 'group') {
        const participant = await groupChatRepository.findParticipant(familyId, chatId, actor);
        if (!participant?.is_active) throw new ReactionError(403, 'FORBIDDEN');
        if (write && await hasPendingGroupLeaveRequest(familyId, chatId, actor)) throw new ReactionError(403, 'FORBIDDEN');
        const chat = await groupChatRepository.findChat(familyId, chatId);
        if (!chat) throw new ReactionError(404, 'NOT_FOUND');
        if (write && (chat.protocol_version !== 2 || chat.rekey_required_at != null)) throw new ReactionError(409, 'INVALID_STATE');
        groupEpoch = chat.key_epoch;
        participants = (await groupChatRepository.listActiveParticipants(familyId, chatId)).map(p => p.identity_id);
      } else {
        const access = await resolveDirectCommunicationAccess(familyId, actor, peer, 'messages');
        if (!access.allowed) throw new ReactionError(403, 'FORBIDDEN');
        participants = [...new Set([actor, peer])];
      }
      const claim = input?.claim;
      const p = claim?.payload;
      const messageIds = write && p ? [p.messageId] : input?.messageIds;
      if (!Array.isArray(messageIds) || messageIds.length > MAX_REACTION_MESSAGES
        || messageIds.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new ReactionError(400, 'INVALID_REQUEST');
      if (write) {
        if (!claim || !validReactionPayload(p) || claim.type !== 'message:reaction-author'
          || claim.signerId !== actor || p.actorIdentityId !== actor || p.scope !== scope || p.chatId !== chatId) {
          throw new ReactionError(400, 'INVALID_REQUEST');
        }
        const identity = await identityRepository.findByIdentityId(familyId, actor);
        if (!identity || !verifySignedRequest(claim, { algorithm: identity.public_key_algorithm, value: identity.public_key_value } as PublicKey)) {
          throw new ReactionError(403, 'INVALID_SIGNATURE');
        }
        const message = scope === 'group'
          ? await groupChatRepository.findMessageById(familyId, chatId, p.messageId)
          : await messageRepository.findMessageById(familyId, p.messageId);
        if (!message || message.deleted_at != null) throw new ReactionError(404, 'NOT_FOUND');
        if (scope === 'group' && ('kind' in message && message.kind !== 'user')) throw new ReactionError(403, 'FORBIDDEN');
        if (scope === 'direct' && (!('recipient_identity_id' in message)
          || [message.sender_identity_id, message.recipient_identity_id].sort().join('::') !== chatId)) throw new ReactionError(403, 'FORBIDDEN');
        if (scope === 'group' && p.epoch !== groupEpoch) throw new ReactionError(409, 'INVALID_STATE');
        if (scope === 'direct') {
          const epoch = await query('SELECT current_epoch FROM direct_chat_epoch_state WHERE family_id=$1 AND direct_chat_id=$2', [familyId, chatId]);
          if (Number(epoch.rows[0]?.current_epoch) !== p.epoch) throw new ReactionError(409, 'INVALID_STATE');
        }
        await transaction(async client => {
          // Serialize updates of this author's set; revisions are compare-and-set.
          // Lock the target against concurrent deletion until this mutation commits.
          const targetTable = scope === 'direct' ? 'messages' : 'group_chat_messages';
          const targetColumn = scope === 'direct' ? 'server_message_id' : 'message_id';
          const target = await client.query(`SELECT deleted_at FROM ${targetTable} WHERE ${targetColumn}=$1 FOR SHARE`, [p.messageId]);
          if (!target.rows[0] || target.rows[0].deleted_at != null) throw new ReactionError(404, 'NOT_FOUND');
          const key = [familyId, scope, chatId, p.messageId, actor];
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(key)]);
          const current = await client.query('SELECT revision, claim FROM message_reaction_states WHERE family_id=$1 AND scope=$2 AND chat_id=$3 AND message_id=$4 AND actor_identity_id=$5', key);
          const row = current.rows[0];
          if (row && Number(row.revision) === p.revision && row.claim.signature === claim.signature) return;
          if (p.revision !== Number(row?.revision || 0) + 1) throw new ReactionError(409, 'REACTION_CONFLICT');
          await client.query(`INSERT INTO message_reaction_states
            (family_id,scope,chat_id,message_id,actor_identity_id,revision,claim,direct_message_id,group_message_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (family_id,scope,chat_id,message_id,actor_identity_id)
            DO UPDATE SET revision=EXCLUDED.revision, claim=EXCLUDED.claim`,
          [...key, p.revision, JSON.stringify(claim), scope === 'direct' ? p.messageId : null, scope === 'group' ? p.messageId : null]);
        });
        // Hints contain no emoji or ciphertext and do not affect unread/message previews.
        const hint = { scope, chatId, messageId: p.messageId };
        if (scope === 'group') {
          sendGroupChatWsEvent({ familyId, participantIdentityIds: participants, eventType: 'message:reactions-updated', payload: hint });
        } else {
          for (const identityId of participants) sendDirectChatWsEvent(familyId, identityId, chatId, {
            type: 'message:reactions-updated', data: hint
          });
        }
      }
      const result = await query(`SELECT r.claim, i.public_key_algorithm, i.public_key_value
        FROM message_reaction_states r
        JOIN identities i ON i.family_id=r.family_id AND i.identity_id=r.actor_identity_id
        LEFT JOIN messages d ON d.server_message_id=r.direct_message_id
        LEFT JOIN group_chat_messages g ON g.message_id=r.group_message_id
        WHERE r.family_id=$1 AND r.scope=$2 AND r.chat_id=$3 AND r.message_id=ANY($4::text[])
          AND ((r.scope='direct' AND d.deleted_at IS NULL AND d.server_message_id IS NOT NULL)
            OR (r.scope='group' AND g.deleted_at IS NULL AND g.message_id IS NOT NULL))`, [familyId, scope, chatId, messageIds]);
      const records: ReactionRecord[] = result.rows.map(row => ({ claim: row.claim,
        publicKey: { algorithm: row.public_key_algorithm, value: row.public_key_value } }));
      const available = scope === 'direct'
        ? await query(`SELECT server_message_id AS id FROM messages WHERE family_id=$1 AND server_message_id=ANY($2::text[])
          AND deleted_at IS NULL AND ((sender_identity_id=$3 AND recipient_identity_id=$4) OR (sender_identity_id=$4 AND recipient_identity_id=$3))`, [familyId, messageIds, actor, peer])
        : await query(`SELECT message_id AS id FROM group_chat_messages WHERE family_id=$1 AND chat_id=$2
          AND message_id=ANY($3::text[]) AND deleted_at IS NULL AND kind='user'`, [familyId, chatId, messageIds]);
      const availableIds = new Set(available.rows.map(row => row.id));
      res.json({ status: 'ok', result: { records, unavailableMessageIds: messageIds.filter(id => !availableIds.has(id)) } });
    } catch (error) {
      if (error instanceof ReactionError) res.status(error.status).json({ status: 'error', error: { code: error.code, message: error.code } });
      else next(error);
    }
  };
}
