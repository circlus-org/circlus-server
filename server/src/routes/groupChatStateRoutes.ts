import { Router } from 'express';
import { nanoid } from 'nanoid';
import type {
  ApiResponse,
  ErrorCode,
  GroupLeaveRequestClaim,
  GroupStateTransitionClaim,
  IdentityId,
  PublicKey
} from '../../../shared/types';
import {
  requireActiveIdentity,
  requireFullCircleIdentity,
  verifySignature,
  type AuthRequest
} from '../middleware/auth';
import {
  GroupChatStateConflictError,
  groupChatRepository,
  identityRepository
} from '../db/repositories';
import { requireTrustedGroupDevice } from './groupChatsAccess';
import { isMessageSizeAllowed, isValidEncryptedGroupTitle } from './groupChatsValidation';
import { parseGk2PublisherIdentityId } from './groupChatEpochValidation';
import {
  findCurrentGroupMembershipTransitionId,
  validateGroupLeaveRequest,
  validateGroupStateTransition
} from './groupChatTrustProtocol';
import { sendGroupChatWsEvent } from '../ws/wsGateway';
import { routeLogger } from '../utils/routeLogger';
import { buildSystemMessageRecord } from './groupChatRouteSupport';
import { sendIncomingMessagePush } from '../utils/push';

const router = Router();

const leaveRequestMessageId = (requestId: string) => `gcm_${requestId.slice('glr_'.length)}`;

function parseSystemPayload(message: { system_payload_json: string | null }): Record<string, unknown> | null {
  if (!message.system_payload_json) return null;
  try {
    const parsed = JSON.parse(message.system_payload_json);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

router.post('/:chatId/leave/request', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const actorIdentityId = req.device?.identityId as IdentityId | undefined;
    const chatId = String(req.params.chatId || '').trim();
    const leaveRequest = (req.signedRequest?.payload as { leaveRequest?: GroupLeaveRequestClaim } | undefined)?.leaveRequest;
    if (!familyId || !actorIdentityId || !leaveRequest) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Signed group leave request is required' } } as ApiResponse);
    }
    if (leaveRequest.signerId !== actorIdentityId || leaveRequest.payload.participantIdentityId !== actorIdentityId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'A participant may request only their own departure' } } as ApiResponse);
    }
    const chat = await groupChatRepository.findChat(familyId, chatId);
    const transitions = await groupChatRepository.listStateTransitions(familyId, chatId);
    const participant = await groupChatRepository.findParticipant(familyId, chatId, actorIdentityId);
    const identity = await identityRepository.findByIdentityId(familyId, actorIdentityId);
    if (!chat || chat.protocol_version !== 2 || transitions.length === 0 || !participant?.is_active || !identity) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Active group membership is required' } } as ApiResponse);
    }
    if (chat.owner_identity_id === actorIdentityId) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Transfer ownership before leaving the group' } } as ApiResponse);
    }
    const requestCheck = validateGroupLeaveRequest({
      claim: leaveRequest,
      chatId,
      participantPublicKey: { algorithm: identity.public_key_algorithm, value: identity.public_key_value } as PublicKey,
      transitions: transitions.map((row) => row.signed_transition)
    });
    if (
      !requestCheck.ok
      || findCurrentGroupMembershipTransitionId(
        transitions.map((row) => row.signed_transition),
        actorIdentityId
      ) !== leaveRequest.payload.membershipTransitionId
    ) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: requestCheck.ok ? 'Leave request belongs to an older membership' : requestCheck.message
        }
      } as ApiResponse);
    }

    const messageId = leaveRequestMessageId(leaveRequest.payload.requestId);
    const existing = await groupChatRepository.findMessageById(familyId, chatId, messageId);
    if (existing) {
      const existingRequest = parseSystemPayload(existing)?.leaveRequest as GroupLeaveRequestClaim | undefined;
      if (existing.system_type !== 'participant_leave_requested' || existingRequest?.signature !== leaveRequest.signature) {
        return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Leave request id is already used' } } as ApiResponse);
      }
      return res.json({ status: 'ok', result: { chatId, messageId, leaveRequest, deduplicated: true } } as ApiResponse);
    }

    const createdAt = Date.now();
    const inserted = await groupChatRepository.insertMessage(buildSystemMessageRecord({
      messageId,
      familyId,
      chatId,
      senderIdentityId: actorIdentityId,
      senderDeviceId: req.device?.deviceId || null,
      senderSignature: req.signedRequest?.signature || null,
      createdAt,
      epoch: chat.key_epoch,
      systemType: 'participant_leave_requested',
      systemPayload: { leaveRequest }
    }));
    const systemPayload = { leaveRequest };
    const participants = await groupChatRepository.listActiveParticipants(familyId, chatId);
    sendGroupChatWsEvent({
      familyId,
      participantIdentityIds: participants.map((row) => row.identity_id),
      eventType: 'group:message:deliver',
      payload: {
        chatId,
        messageId,
        senderIdentityId: actorIdentityId,
        ciphertext: '',
        senderSignature: req.signedRequest?.signature || null,
        clientMessageId: leaveRequest.payload.requestId,
        clientCreatedAt: leaveRequest.payload.requestedAt,
        createdAt,
        epoch: chat.key_epoch,
        revision: 1,
        chatSeq: inserted.chat_seq,
        kind: 'system',
        systemType: 'participant_leave_requested',
        systemPayload
      }
    });
    await sendIncomingMessagePush(
      familyId,
      chat.owner_identity_id,
      messageId,
      actorIdentityId,
      actorIdentityId,
      { chatId, dialogId: chatId }
    ).catch((error) => routeLogger.warn('Group leave request push failed:', error));
    return res.json({ status: 'ok', result: { chatId, messageId, leaveRequest, createdAt } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Create group leave request error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Unable to request group departure' } } as ApiResponse);
  }
});

export function normalizeGroupStateEnvelopes(value: unknown): Array<{ identityId: IdentityId; envelopeCiphertext: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = item as { identityId?: unknown; envelopeCiphertext?: unknown };
    return {
      identityId: String(row?.identityId || '').trim() as IdentityId,
      envelopeCiphertext: String(row?.envelopeCiphertext || '')
    };
  }).filter((item) => item.identityId && item.envelopeCiphertext);
}

export function validateGroupEnvelopeSet(params: {
  envelopes: Array<{ identityId: IdentityId; envelopeCiphertext: string }>;
  participantIds: IdentityId[];
  publisherIdentityId: IdentityId;
}): string | null {
  const expected = new Set(params.participantIds);
  const actual = new Set(params.envelopes.map((item) => item.identityId));
  if (actual.size !== expected.size || [...expected].some((identityId) => !actual.has(identityId))) {
    return 'One key envelope is required for every participant';
  }
  for (const envelope of params.envelopes) {
    if (!expected.has(envelope.identityId)) return 'Envelope recipient is not a participant';
    if (!isMessageSizeAllowed(envelope.envelopeCiphertext)) return 'Envelope ciphertext is too large';
    if (parseGk2PublisherIdentityId(envelope.envelopeCiphertext) !== params.publisherIdentityId) {
      return 'Envelope publisher does not match the owner signer';
    }
  }
  return null;
}

router.post('/:chatId/state/list', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const chatId = String(req.params.chatId || '').trim();
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    const chat = await groupChatRepository.findChat(familyId, chatId);
    const participant = await groupChatRepository.findParticipant(familyId, chatId, identityId);
    if (!chat || chat.protocol_version !== 2 || !participant?.is_active) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Group trust protocol v2 is required' } } as ApiResponse);
    }
    const transitions = await groupChatRepository.listStateTransitions(familyId, chatId);
    const identityIds = new Set<string>();
    for (const transition of transitions) {
      identityIds.add(transition.signed_transition.signerId);
      transition.signed_transition.payload.participantIdentityIds.forEach((id) => identityIds.add(id));
    }
    const identities = await identityRepository.findByIdentityIds(familyId, Array.from(identityIds));
    const identityPublicKeys = Object.fromEntries(identities.map((identity) => [
      identity.identity_id,
      { algorithm: identity.public_key_algorithm, value: identity.public_key_value }
    ]));
    return res.json({
      status: 'ok',
      result: {
        chatId,
        transitions: transitions.map((row) => row.signed_transition),
        identityPublicKeys
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List group state transitions error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/state/apply', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const actorIdentityId = req.device?.identityId as IdentityId | undefined;
    const chatId = String(req.params.chatId || '').trim();
    if (!familyId || !actorIdentityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    const chat = await groupChatRepository.findChat(familyId, chatId);
    const previousRow = await groupChatRepository.findCurrentStateTransition(familyId, chatId);
    if (!chat || chat.protocol_version !== 2 || !previousRow) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Group trust protocol v2 is required' } } as ApiResponse);
    }
    const previous = previousRow.signed_transition;
    if (previous.payload.ownerIdentityId !== actorIdentityId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only owner can change group state' } } as ApiResponse);
    }
    const payload = (req.signedRequest?.payload || {}) as {
      transition?: GroupStateTransitionClaim;
      envelopes?: unknown;
      leaveRequest?: GroupLeaveRequestClaim;
    };
    const transition = payload.transition;
    const owner = await identityRepository.findByIdentityId(familyId, actorIdentityId);
    if (!owner) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Owner identity is unavailable' } } as ApiResponse);
    }
    const transitionCheck = validateGroupStateTransition({
      claim: transition,
      chatId,
      previous,
      signerPublicKey: { algorithm: owner.public_key_algorithm, value: owner.public_key_value } as PublicKey
    });
    if (!transitionCheck.ok || !transition) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: transitionCheck.ok ? 'Transition is required' : transitionCheck.message } } as ApiResponse);
    }
    const previousParticipantIds = previous.payload.participantIdentityIds;
    const nextParticipantIds = new Set(transition.payload.participantIdentityIds);
    const removedParticipantIds = previousParticipantIds.filter((identityId) => !nextParticipantIds.has(identityId));
    if (payload.leaveRequest) {
      const leavingIdentityId = payload.leaveRequest.payload.participantIdentityId;
      const leavingIdentity = await identityRepository.findByIdentityId(familyId, leavingIdentityId);
      const transitions = await groupChatRepository.listStateTransitions(familyId, chatId);
      const storedRequestMessage = await groupChatRepository.findMessageById(
        familyId,
        chatId,
        leaveRequestMessageId(payload.leaveRequest.payload.requestId)
      );
      const storedRequest = storedRequestMessage ? parseSystemPayload(storedRequestMessage)?.leaveRequest as GroupLeaveRequestClaim | undefined : undefined;
      const leaveCheck = leavingIdentity && storedRequest?.signature === payload.leaveRequest.signature
        ? validateGroupLeaveRequest({
            claim: payload.leaveRequest,
            chatId,
            participantPublicKey: {
              algorithm: leavingIdentity.public_key_algorithm,
              value: leavingIdentity.public_key_value
            } as PublicKey,
            transitions: transitions.map((row) => row.signed_transition)
          })
        : { ok: false as const, message: 'Stored leave request is unavailable' };
      if (
        !leaveCheck.ok
        || findCurrentGroupMembershipTransitionId(
          transitions.map((row) => row.signed_transition),
          leavingIdentityId
        ) !== payload.leaveRequest.payload.membershipTransitionId
        || transition.payload.action !== 'remove_participants'
        || removedParticipantIds.length !== 1
        || removedParticipantIds[0] !== leavingIdentityId
        || leavingIdentityId === previous.payload.ownerIdentityId
      ) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: leaveCheck.ok ? 'Leave request does not match the state transition' : leaveCheck.message } } as ApiResponse);
      }
    }
    if (!isValidEncryptedGroupTitle(transition.payload.titleCiphertext, transition.payload.epoch)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid encrypted group title' } } as ApiResponse);
    }
    const identities = await identityRepository.findByIdentityIds(familyId, transition.payload.participantIdentityIds);
    const validIds = new Set(identities.filter((identity) => identity.status === 'active' && identity.role !== 'guest').map((identity) => identity.identity_id));
    if (transition.payload.participantIdentityIds.some((id) => !validIds.has(id))) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Group contains an invalid participant' } } as ApiResponse);
    }

    const envelopes = normalizeGroupStateEnvelopes(payload.envelopes);
    const rotatesEpoch = transition.payload.epoch === previous.payload.epoch + 1;
    if (rotatesEpoch) {
      const envelopeError = validateGroupEnvelopeSet({
        envelopes,
        participantIds: transition.payload.participantIdentityIds,
        publisherIdentityId: actorIdentityId
      });
      if (envelopeError) {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: envelopeError } } as ApiResponse);
      }
    } else if (envelopes.length > 0) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Envelopes are allowed only for a new epoch' } } as ApiResponse);
    }

    const completedAt = Date.now();
    const completionMessage = payload.leaveRequest
      ? buildSystemMessageRecord({
          messageId: `gcm_${nanoid(20)}`,
          familyId,
          chatId,
          senderIdentityId: actorIdentityId,
          senderDeviceId: req.device?.deviceId || null,
          senderSignature: req.signedRequest?.signature || null,
          createdAt: completedAt,
          epoch: transition.payload.epoch,
          systemType: 'participant_left',
          systemPayload: {
            identityId: payload.leaveRequest.payload.participantIdentityId,
            requestId: payload.leaveRequest.payload.requestId,
            transitionId: transition.payload.transitionId,
            leaveRequest: payload.leaveRequest
          }
        })
      : undefined;
    const result = await groupChatRepository.applyV2StateTransition({
      familyId,
      chatId,
      transition,
      envelopes,
      createdAt: completedAt,
      systemMessage: completionMessage
    });
    const recipients = Array.from(new Set([
      ...result.previousParticipantIds,
      ...transition.payload.participantIdentityIds
    ]));
    sendGroupChatWsEvent({
      familyId,
      participantIdentityIds: recipients,
      eventType: 'group:chat-updated',
      payload: {
        chatId,
        event: transition.payload.action === 'add_participants'
          ? 'participants_added'
          : transition.payload.action === 'remove_participants'
            ? 'participant_removed'
            : transition.payload.action === 'transfer_owner'
              ? 'owner_transferred'
              : transition.payload.action === 'rename'
                ? 'chat_renamed'
                : 'periodic_rekey',
        ownerIdentityId: transition.payload.ownerIdentityId,
        titleCiphertext: transition.payload.titleCiphertext,
        keyEpoch: transition.payload.epoch,
        rekeyRequired: rotatesEpoch ? false : chat.rekey_required_at != null,
        rekeyRequiredAt: rotatesEpoch ? undefined : chat.rekey_required_at || undefined
      }
    });
    if (completionMessage) {
      sendGroupChatWsEvent({
        familyId,
        participantIdentityIds: recipients,
        eventType: 'group:message:deliver',
        payload: {
          chatId,
          messageId: completionMessage.message_id,
          senderIdentityId: actorIdentityId,
          ciphertext: '',
          senderSignature: completionMessage.sender_signature,
          clientMessageId: payload.leaveRequest!.payload.requestId,
          clientCreatedAt: payload.leaveRequest!.payload.requestedAt,
          createdAt: completedAt,
          epoch: transition.payload.epoch,
          revision: 1,
          chatSeq: result.systemMessageChatSeq || undefined,
          kind: 'system',
          systemType: completionMessage.system_type,
          systemPayload: parseSystemPayload(completionMessage)
        }
      });
    }
    return res.json({ status: 'ok', result: { chatId, transition } } as ApiResponse);
  } catch (error) {
    if (error instanceof GroupChatStateConflictError) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Group state compare-and-swap conflict' } } as ApiResponse);
    }
    routeLogger.error('Apply group state transition error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

export default router;
