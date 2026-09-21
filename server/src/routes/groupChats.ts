import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity } from '../middleware/auth';
import type { AuthRequest } from '../middleware/auth';
import { groupChatRepository, identityRepository } from '../db/repositories';
import { GROUP_CHAT_LIMITS, isValidEncryptedGroupTitle } from './groupChatsValidation';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import type { ApiResponse, ErrorCode, GroupStateTransitionClaim, IdentityId, PublicKey } from '../../../shared/types';
import { getRateLimitRuntimeConfig } from '../config/serverRuntimeConfig';
import { requireTrustedGroupDevice } from './groupChatsAccess';
import groupChatKeyRoutes from './groupChatKeyRoutes';
import groupChatMembershipRoutes from './groupChatMembershipRoutes';
import groupChatMessageRoutes from './groupChatMessageRoutes';
import groupChatStateRoutes from './groupChatStateRoutes';
import { normalizeGroupStateEnvelopes, validateGroupEnvelopeSet } from './groupChatStateRoutes';
import { validateGroupStateTransition } from './groupChatTrustProtocol';
import { fanoutGroupChatEvent } from './groupChatRouteSupport';

const router = Router();
const groupChatRateLimits = getRateLimitRuntimeConfig().groupChats;

const groupChatsLimiter = createRateLimiter({
  name: 'api:group-chats',
  windowMs: groupChatRateLimits.windowMs,
  max: groupChatRateLimits.max,
  keyFn: ipFamilyKey
});

router.use(groupChatsLimiter);

router.post('/create', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const ownerIdentityId = req.device?.identityId;
    if (!familyId || !ownerIdentityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as {
      chatId?: string;
      transition?: GroupStateTransitionClaim;
      envelopes?: unknown;
    };
    const chatId = String(payload.chatId || '').trim();
    const transition = payload.transition;
    if (!/^gc_[A-Za-z0-9_-]{16,}$/.test(chatId) || !transition) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'A client-generated chatId and owner-signed genesis are required' } } as ApiResponse);
    }
    const ownerIdentity = await identityRepository.findByIdentityId(familyId, ownerIdentityId);
    if (!ownerIdentity) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Owner identity is unavailable' } } as ApiResponse);
    }
    const transitionCheck = validateGroupStateTransition({
      claim: transition,
      chatId,
      previous: null,
      signerPublicKey: {
        algorithm: ownerIdentity.public_key_algorithm,
        value: ownerIdentity.public_key_value
      } as PublicKey
    });
    if (!transitionCheck.ok || transition.signerId !== ownerIdentityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: transitionCheck.ok ? 'Genesis owner mismatch' : transitionCheck.message } } as ApiResponse);
    }
    const titleCiphertext = transition.payload.titleCiphertext;
    if (!isValidEncryptedGroupTitle(titleCiphertext, 1)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'titleCiphertext must be an encrypted gct1 title for epoch 1' } } as ApiResponse);
    }

    const orderedParticipantIds = transition.payload.participantIdentityIds as IdentityId[];
    const participantIds = orderedParticipantIds.filter((id) => id !== ownerIdentityId);
    if (participantIds.length > GROUP_CHAT_LIMITS.createParticipantsMax) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: `too many participants (max ${GROUP_CHAT_LIMITS.createParticipantsMax})` } } as ApiResponse);
    }

    const uniqueParticipantIds = participantIds;
    const participantIdentities = await identityRepository.findByIdentityIds(familyId, uniqueParticipantIds);
    const validParticipantIds = new Set(
      participantIdentities
        .filter((identity) => identity.status === 'active' && identity.role !== 'guest')
        .map((identity) => identity.identity_id)
    );
    for (const participantId of uniqueParticipantIds) {
      if (!validParticipantIds.has(participantId)) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: `Participant is invalid: ${participantId}` }
        } as ApiResponse);
      }
    }

    const envelopes = normalizeGroupStateEnvelopes(payload.envelopes);
    const envelopeError = validateGroupEnvelopeSet({
      envelopes,
      participantIds: orderedParticipantIds,
      publisherIdentityId: ownerIdentityId
    });
    if (envelopeError) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: envelopeError } } as ApiResponse);
    }
    const now = Date.now();
    await groupChatRepository.createV2Chat({
      chatId,
      familyId,
      titleCiphertext,
      ownerIdentityId,
      participantIds: orderedParticipantIds,
      transition,
      keyCommitment: transition.payload.keyCommitment,
      envelopes,
      createdAt: now
    });

    const participants = await groupChatRepository.listActiveParticipants(familyId, chatId);
    fanoutGroupChatEvent({
      familyId,
      participantIdentityIds: participants.map((p) => p.identity_id),
      eventType: 'group:chat-updated',
      payload: { chatId, event: 'chat_created' }
    });

    return res.json({
      status: 'ok',
      result: {
        chatId,
        titleCiphertext,
        ownerIdentityId,
        keyEpoch: 1,
        participants: participants.map((p) => ({ identityId: p.identity_id, joinOrder: p.join_order, joinedAt: p.joined_at })),
        transition
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Create group chat error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/list', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const chats = await groupChatRepository.listChatsForIdentity(familyId, identityId);
    return res.json({
      status: 'ok',
      result: {
        chats: chats.map((chat) => ({
          chatId: chat.chat_id,
          title: '',
          titleCiphertext: chat.title_ciphertext,
          ownerIdentityId: chat.owner_identity_id,
          createdAt: chat.created_at,
          updatedAt: chat.updated_at,
          lastMessageAt: chat.last_message_at,
          lastMessagePreview: chat.last_message_preview,
          participantCount: chat.participant_count,
          unreadCount: chat.unread_count,
          muted: chat.muted,
          keyEpoch: chat.key_epoch,
          protocolVersion: chat.protocol_version,
          rekeyRequired: chat.rekey_required_at != null,
          rekeyRequiredAt: chat.rekey_required_at,
          rekeyRequiredReason: chat.rekey_required_reason,
          rekeyRequiredIdentityId: chat.rekey_required_identity_id
        }))
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List group chats error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.use(groupChatMembershipRoutes);

router.use(groupChatStateRoutes);



router.use(groupChatKeyRoutes);




router.use(groupChatMessageRoutes);


router.post('/:chatId/settings', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
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

    const payload = (req.signedRequest?.payload || {}) as { muted?: boolean };
    const muted = payload.muted === true;
    await groupChatRepository.setMuted(familyId, chatId, identityId, muted);

    fanoutGroupChatEvent({
      familyId,
      participantIdentityIds: [identityId],
      eventType: 'group:chat-updated',
      payload: { chatId, event: 'settings_updated', muted }
    });

    return res.json({ status: 'ok', result: { chatId, muted } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Update group chat settings error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

export default router;
