import { messageReactionsHandler } from './messageReactions';
import { MessageAlreadyAccepted } from '../services/messageSendReceipt';
import { query as replayQuery } from '../db';
import { MessageRevisionConflict, sameMessageClaim } from '../services/messageRevision';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { nanoid } from 'nanoid';
import {
  requireActiveIdentity,
  requireFullCircleIdentity,
  verifySignature,
  type AuthRequest
} from '../middleware/auth';
import { groupChatRepository, identityRepository } from '../db/repositories';
import { sendGroupChatWsEvent } from '../ws/wsGateway';
import { sendIncomingMessagePush, sendMessagesReadPush } from '../utils/push';
import { getGroupPushSenderName, getPushRecipients } from './groupChatsPush';
import { senderEnvelopePrecondition } from './groupChatsGuards';
import {
  GROUP_CHAT_LIMITS,
  isLikelyEncryptedCiphertext,
  isMessageSizeAllowed
} from './groupChatsValidation';
import { configService } from '../services/configService';
import type {
  ApiResponse,
  ErrorCode,
  GroupMessageAuthorClaim,
  PublicKey,
  TemporaryIdentityDelegationCredential,
  WSGroupChatUpdatedData,
  WSGroupMessageDeliverData,
  WSGroupMessageUpdatedData
} from '../../../shared/types';
import {
  hasPendingGroupLeaveRequest,
  requireTrustedGroupDevice,
  requireGroupChatOwner
} from './groupChatsAccess';
import { validateGroupMessageAuthorClaim } from './groupChatTrustProtocol';
import { recordForegroundMessageActivity } from '../services/foregroundPresenceActivity';

const router = Router();
router.post('/:chatId/reactions/list', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, messageReactionsHandler('group', false));
router.post('/:chatId/reactions/set', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, messageReactionsHandler('group', true));

function fanoutGroupChatEvent(params: {
  familyId: string;
  participantIdentityIds: string[];
  eventType: 'group:chat-updated' | 'group:message:deliver' | 'group:message:updated';
  payload: WSGroupChatUpdatedData | WSGroupMessageDeliverData | WSGroupMessageUpdatedData;
}): void {
  sendGroupChatWsEvent(params);
}

router.post('/:chatId/messages/send', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const deviceId = req.device?.deviceId;
    if (!familyId || !identityId || !deviceId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, identityId);
    if (!participant || !participant.is_active) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Not active group participant' } } as ApiResponse);
    }
    if (await hasPendingGroupLeaveRequest(familyId, chatId, identityId)) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Participant is leaving the group' } } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as {
      ciphertext?: string;
      notificationPreviewCiphertext?: string;
      senderSignature?: string;
      authorClaim?: GroupMessageAuthorClaim;
      clientMessageId?: string;
      clientCreatedAt?: number;
      epoch?: number;
      temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
    };
    const ciphertext = String(payload.ciphertext || '');
    const notificationPreviewCiphertext = typeof payload.notificationPreviewCiphertext === 'string'
      ? payload.notificationPreviewCiphertext
      : null;
    const clientMessageId = String(payload.clientMessageId || '').trim();
    const clientCreatedAt = typeof payload.clientCreatedAt === 'number' ? payload.clientCreatedAt : null;
    const epoch = typeof payload.epoch === 'number' ? payload.epoch : null;
    if (!ciphertext || !clientMessageId || clientCreatedAt === null) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'ciphertext, clientMessageId and clientCreatedAt are required' } } as ApiResponse);
    }

    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (!chat) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Group chat not found' } } as ApiResponse);
    }
    if (chat.protocol_version !== 2) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Group trust protocol v2 is required' } } as ApiResponse);
    }

    if (chat.rekey_required_at != null) {
      return res.status(409).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Group is waiting for an owner-signed rekey transition'
        }
      } as ApiResponse);
    }

    if (epoch === null || epoch !== chat.key_epoch) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Group key epoch mismatch' } } as ApiResponse);
    }

    const senderEnvelope = await groupChatRepository.findKeyEnvelopeForIdentity(familyId, chatId, epoch, identityId);
    const senderEnvelopeCheck = senderEnvelopePrecondition(Boolean(senderEnvelope));
    if (!senderEnvelopeCheck.ok) {
      return res.status(senderEnvelopeCheck.status).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: senderEnvelopeCheck.message }
      } as ApiResponse);
    }

    if (!isMessageSizeAllowed(ciphertext) || (notificationPreviewCiphertext && !isMessageSizeAllowed(notificationPreviewCiphertext))) {
      return res.status(400).json({ status: 'error', error: { code: 'MESSAGE_TOO_LARGE' as ErrorCode, message: 'Ciphertext exceeds group message size limit' } } as ApiResponse);
    }

    if (!isLikelyEncryptedCiphertext(ciphertext)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'ciphertext must use gcm1 format' }
      } as ApiResponse);
    }

    const senderIdentity = await identityRepository.findByIdentityId(familyId, identityId);
    if (!senderIdentity || !validateGroupMessageAuthorClaim({
      claim: payload.authorClaim,
      action: 'create',
      chatId,
      senderIdentityId: identityId,
      clientMessageId,
      clientCreatedAt,
      epoch,
      revision: 1,
      ciphertext,
      senderPublicKey: {
        algorithm: senderIdentity.public_key_algorithm,
        value: senderIdentity.public_key_value
      } as PublicKey
    })) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid group message author claim' } } as ApiResponse);
    }

    await recordForegroundMessageActivity({
      familyId,
      identityId,
      activityAt: payload.authorClaim?.payload?.foregroundActivityAt
    });

    const existing = await groupChatRepository.findByClientMessageId(familyId, chatId, deviceId, clientMessageId);
    if (existing) {
      return res.json({
        status: 'ok',
        result: { messageId: existing.message_id, createdAt: existing.created_at, deduplicated: true }
      } as ApiResponse);
    }

    const now = Date.now();
    const messageId = `gcm_${nanoid(20)}`;
    let insertResult: { chat_seq: number };
    try {
    insertResult = await groupChatRepository.insertMessage({
      message_id: messageId,
      family_id: familyId,
      chat_id: chatId,
      chat_seq: 0,
      sender_identity_id: identityId,
      sender_device_id: deviceId,
      kind: 'user',
      ciphertext,
      notification_preview_ciphertext: notificationPreviewCiphertext,
      sender_signature: payload.senderSignature || req.signedRequest?.signature || null,
      author_claim: payload.authorClaim,
      temporary_identity_delegation: payload.temporaryIdentityDelegation ?? null,
      client_message_id: clientMessageId,
      client_created_at: clientCreatedAt,
      created_at: now,
      content_updated_at: now,
      edited_at: null,
      deleted_at: null,
      revision: 1,
      system_type: null,
      system_payload_json: null,
      epoch
    });
    } catch (error) {
      if (!(error instanceof MessageAlreadyAccepted)) throw error;
      return res.json({ status: 'ok', result: { messageId: error.messageId, createdAt: error.createdAt, deduplicated: true } });
    }
    const chatSeq = insertResult?.chat_seq;

    const participants = await groupChatRepository.listActiveParticipants(familyId, chatId);
    const participantIds = participants.map((p) => p.identity_id);
    fanoutGroupChatEvent({
      familyId,
      participantIdentityIds: participantIds,
      eventType: 'group:message:deliver',
      payload: {
        chatId,
        messageId,
        senderIdentityId: identityId,
        ciphertext,
        senderSignature: payload.senderSignature || req.signedRequest?.signature || null,
        authorClaim: payload.authorClaim,
        temporaryIdentityDelegation: payload.temporaryIdentityDelegation,
        clientMessageId,
        clientCreatedAt,
        createdAt: now,
        epoch,
        editedAt: null,
        deletedAt: null,
        contentUpdatedAt: now,
        revision: 1,
        chatSeq
      }
    });

    const noNamesOnServer = await configService.getNoNamesOnServer(familyId);
    const senderName = getGroupPushSenderName(senderIdentity, noNamesOnServer);
    const pushRecipients = getPushRecipients(participants, identityId);
    for (const participantIdentityId of pushRecipients) {
      await sendIncomingMessagePush(familyId, participantIdentityId, messageId, identityId, senderName, {
        chatId,
        dialogId: chatId,
        messageCreatedAt: now,
        notificationPreview: notificationPreviewCiphertext && epoch
          ? {
              version: 1,
              scope: 'group',
              chatId,
              epoch,
              ciphertext: notificationPreviewCiphertext,
            }
          : undefined,
      });
    }

    return res.json({ status: 'ok', result: { messageId, createdAt: now } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Send group message error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/messages/list', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, identityId);
    if (!participant || !participant.is_active) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Not active group participant' } } as ApiResponse);
    }
    const payload = (req.signedRequest?.payload || {}) as { since?: number; limit?: number };
    const since = typeof payload.since === 'number' ? payload.since : 0;
    const limitRaw = typeof payload.limit === 'number' ? payload.limit : GROUP_CHAT_LIMITS.messagesListMaxLimit;
    const limit = Math.max(1, Math.floor(limitRaw));

    const rows = await groupChatRepository.listMessages(familyId, chatId, since, limit + 1);
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (!chat || chat.protocol_version !== 2) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Group trust protocol v2 is required' } } as ApiResponse);
    }
    return res.json({
      status: 'ok',
      result: {
        chatId,
        messages: messages.map((m) => ({
          messageId: m.message_id,
          chatId: m.chat_id,
          kind: m.kind,
          senderIdentityId: m.sender_identity_id,
          ciphertext: m.ciphertext,
          senderSignature: m.sender_signature,
          authorClaim: m.author_claim,
          temporaryIdentityDelegation: m.temporary_identity_delegation ?? undefined,
          clientMessageId: m.client_message_id,
          clientCreatedAt: m.client_created_at,
          createdAt: m.created_at,
          editedAt: m.edited_at,
          deletedAt: m.deleted_at,
          contentUpdatedAt: m.content_updated_at,
          revision: m.revision,
          chatSeq: m.chat_seq,
          systemType: m.system_type,
          systemPayload: m.system_payload_json ? JSON.parse(m.system_payload_json) : null,
          epoch: m.epoch,
          readByIdentityIds: m.read_by_identity_ids || []
        })),
        syncedThrough: (messages.length > 0 ? messages[messages.length - 1].chat_seq : since),
        keyEpoch: chat?.key_epoch || 1,
        hasMore
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List group messages error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/messages/:messageId/readers', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId, messageId } = req.params;
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, identityId);
    if (!participant || !participant.is_active) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Not active group participant' } } as ApiResponse);
    }
    const message = await groupChatRepository.findMessageById(familyId, chatId, messageId);
    if (!message) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Message not found' } } as ApiResponse);
    }
    if (message.sender_identity_id !== identityId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only author can inspect readers' } } as ApiResponse);
    }

    const readers = await groupChatRepository.listMessageReaders(familyId, chatId, messageId);
    return res.json({
      status: 'ok',
      result: {
        chatId,
        messageId,
        readByIdentityIds: readers
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List group message readers error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/messages/:messageId/edit', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId, messageId } = req.params;
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, identityId);
    if (!participant || !participant.is_active) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Not active group participant' } } as ApiResponse);
    }
    if (await hasPendingGroupLeaveRequest(familyId, chatId, identityId)) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Participant is leaving the group' } } as ApiResponse);
    }

    const message = await groupChatRepository.findMessageById(familyId, chatId, messageId);
    if (!message) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Message not found' } } as ApiResponse);
    }
    if (message.kind !== 'user') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'System message cannot be edited' } } as ApiResponse);
    }
    if (message.sender_identity_id !== identityId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only author can edit message' } } as ApiResponse);
    }
    if (message.deleted_at !== null) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Deleted message cannot be edited' } } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as { ciphertext?: string; epoch?: number; authorClaim?: GroupMessageAuthorClaim };
    const ciphertext = String(payload.ciphertext || '');
    const epoch = typeof payload.epoch === 'number' ? payload.epoch : null;
    if (!ciphertext || epoch === null) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'ciphertext and epoch are required' } } as ApiResponse);
    }
    if (epoch !== message.epoch) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Group message can be edited only in the same epoch' } } as ApiResponse);
    }
    if (!isMessageSizeAllowed(ciphertext) || !isLikelyEncryptedCiphertext(ciphertext)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'ciphertext must be a valid encrypted payload' } } as ApiResponse);
    }

    const senderIdentity = await identityRepository.findByIdentityId(familyId, identityId);
    if (!senderIdentity || message.client_created_at === null || !message.client_message_id || !validateGroupMessageAuthorClaim({
      claim: payload.authorClaim,
      action: 'edit',
      chatId,
      senderIdentityId: identityId,
      clientMessageId: message.client_message_id,
      clientCreatedAt: message.client_created_at,
      epoch,
      revision: sameMessageClaim(message.author_claim, payload.authorClaim) ? message.revision : message.revision + 1,
      ciphertext,
      senderPublicKey: {
        algorithm: senderIdentity.public_key_algorithm,
        value: senderIdentity.public_key_value
      } as PublicKey
    })) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid group message edit claim' } } as ApiResponse);
    }

    let editedAt = sameMessageClaim(message.author_claim, payload.authorClaim) ? message.edited_at! : Date.now();
    const editResult = await groupChatRepository.editMessage({
      familyId,
      chatId,
      messageId,
      ciphertext,
      senderSignature: req.signedRequest?.signature || '',
      authorClaim: payload.authorClaim!,
      editedAt
    });
    if (editResult?.applied === false && editResult.edited_at !== undefined) editedAt = editResult.edited_at;
    const chatSeq = editResult?.chat_seq;

    const participants = await groupChatRepository.listActiveParticipants(familyId, chatId);
    if (editResult?.applied !== false) fanoutGroupChatEvent({
      familyId,
      participantIdentityIds: participants.map((p) => p.identity_id),
      eventType: 'group:message:updated',
      payload: {
        chatId,
        messageId,
        senderIdentityId: identityId,
        ciphertext,
        senderSignature: req.signedRequest?.signature || null,
        authorClaim: payload.authorClaim,
        clientMessageId: message.client_message_id || '',
        clientCreatedAt: message.client_created_at,
        createdAt: message.created_at,
        epoch: message.epoch,
        editedAt,
        deletedAt: null,
        contentUpdatedAt: editedAt,
        revision: sameMessageClaim(message.author_claim, payload.authorClaim) ? message.revision : message.revision + 1,
        chatSeq
      }
    });

    return res.json({ status: 'ok', result: { chatId, messageId, editedAt, revision: sameMessageClaim(message.author_claim, payload.authorClaim) ? message.revision : message.revision + 1 } } as ApiResponse);
  } catch (error) {
    if (error instanceof MessageRevisionConflict) return res.status(409).json({status:'error',error:{code:'CONFLICT',message:error.message}});
    routeLogger.error('Edit group message error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/messages/:messageId/delete', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId, messageId } = req.params;
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, identityId);
    if (!participant || !participant.is_active) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Not active group participant' } } as ApiResponse);
    }
    if (await hasPendingGroupLeaveRequest(familyId, chatId, identityId)) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Participant is leaving the group' } } as ApiResponse);
    }

    const message = await groupChatRepository.findMessageById(familyId, chatId, messageId);
    if (!message) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Message not found' } } as ApiResponse);
    }
    if (message.kind !== 'user') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'System message cannot be deleted' } } as ApiResponse);
    }
    if (message.sender_identity_id !== identityId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only author can delete message' } } as ApiResponse);
    }
    if (message.deleted_at !== null) {
      return res.json({ status: 'ok', result: { chatId, messageId, deletedAt: message.deleted_at, revision: message.revision } } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as { authorClaim?: GroupMessageAuthorClaim };
    const senderIdentity = await identityRepository.findByIdentityId(familyId, identityId);
    if (!senderIdentity || message.client_created_at === null || !message.client_message_id || !validateGroupMessageAuthorClaim({
      claim: payload.authorClaim,
      action: 'delete',
      chatId,
      senderIdentityId: identityId,
      clientMessageId: message.client_message_id,
      clientCreatedAt: message.client_created_at,
      epoch: message.epoch,
      revision: message.revision + 1,
      ciphertext: '',
      senderPublicKey: {
        algorithm: senderIdentity.public_key_algorithm,
        value: senderIdentity.public_key_value
      } as PublicKey
    })) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid group message delete claim' } } as ApiResponse);
    }
    const deletedAt = Date.now();
    const deleteResult = await groupChatRepository.softDeleteMessage({
      familyId,
      chatId,
      messageId,
      authorClaim: payload.authorClaim!,
      deletedAt
    });
    const chatSeq = deleteResult?.chat_seq;

    const participants = await groupChatRepository.listActiveParticipants(familyId, chatId);
    fanoutGroupChatEvent({
      familyId,
      participantIdentityIds: participants.map((p) => p.identity_id),
      eventType: 'group:message:updated',
      payload: {
        chatId,
        messageId,
        senderIdentityId: identityId,
        ciphertext: '',
        senderSignature: null,
        authorClaim: payload.authorClaim,
        clientMessageId: message.client_message_id || '',
        clientCreatedAt: message.client_created_at,
        createdAt: message.created_at,
        epoch: message.epoch,
        editedAt: message.edited_at,
        deletedAt,
        contentUpdatedAt: deletedAt,
        revision: message.revision + 1,
        chatSeq
      }
    });

    return res.json({ status: 'ok', result: { chatId, messageId, deletedAt, revision: message.revision + 1 } } as ApiResponse);
  } catch (error) {
    if (error instanceof MessageRevisionConflict) return res.status(409).json({status:'error',error:{code:'CONFLICT',message:error.message}});
    routeLogger.error('Delete group message error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/messages/clear-boundary', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res, next) => {
  try {
  const check = await requireGroupChatOwner(req,req.params.chatId);
  if (!check.ok) return res.status(check.status).json(check.body);
  const result = await replayQuery(`SELECT COALESCE(MAX(chat_seq),0) AS boundary FROM group_chat_messages WHERE family_id=$1 AND chat_id=$2`,[req.familyId,req.params.chatId]);
  return res.json({status:'ok',result:{clearThroughSequence:Number(result.rows[0].boundary)}});
  } catch (error) { next(error); }
});

router.post('/:chatId/messages/clear', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const ownerCheck = await requireGroupChatOwner(req, chatId);
    if (!ownerCheck.ok) {
      return res.status(ownerCheck.status).json(ownerCheck.body);
    }

    const boundary = (req.signedRequest?.payload as {clearThroughSequence?:number})?.clearThroughSequence;
    if (!Number.isSafeInteger(boundary) || Number(boundary) < 0) return res.status(400).json({status:'error',error:{code:'INVALID_REQUEST',message:'clearThroughSequence is required'}});
    const deletedCount = await groupChatRepository.deleteChatMessages(familyId, chatId, boundary!);
    return res.json({ status: 'ok', result: { chatId, deletedCount } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Clear group messages error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/messages/read', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, identityId);
    if (!participant || !participant.is_active) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Not active group participant' } } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as { readAt?: number };
    const readAt = typeof payload.readAt === 'number' ? payload.readAt : Date.now();
    await groupChatRepository.markRead(familyId, chatId, identityId, readAt);
    void sendMessagesReadPush(familyId, identityId, { dialogId: chatId, chatId, readThrough: readAt });
    return res.json({ status: 'ok', result: { chatId, readAt } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Mark group messages read error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

export default router;
