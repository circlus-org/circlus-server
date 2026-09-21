import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  requireActiveIdentity,
  requireFullCircleIdentity,
  verifySignature,
  type AuthRequest
} from '../middleware/auth';
import { groupChatRepository } from '../db/repositories';
import type {
  ApiResponse,
  ErrorCode,
  GroupEpochTransitionClaim
} from '../../../shared/types';
import { buildEnvelopeCoverage } from './groupChatsGuards';
import { isMessageSizeAllowed } from './groupChatsValidation';
import {
  isSha256Hex,
  parseGk2PublisherIdentityId
} from './groupChatEpochValidation';
import {
  requireGroupChatOwner,
  requireTrustedGroupDevice
} from './groupChatsAccess';

const router = Router();

router.post('/:chatId/keys/publish', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const familyId = req.familyId;
    const publisherIdentityId = req.device?.identityId;
    if (!familyId || !publisherIdentityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, publisherIdentityId);
    if (!participant || !participant.is_active) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Not active group participant' } } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as {
      epoch?: number;
      keyCommitment?: string;
      signedEpochTransition?: GroupEpochTransitionClaim;
      envelopes?: Array<{ identityId?: string; envelopeCiphertext?: string }>;
    };

    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (!chat) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Group chat not found' } } as ApiResponse);
    }
    if (chat.protocol_version === 2 && chat.owner_identity_id !== publisherIdentityId) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only the owner can publish group key envelopes' } } as ApiResponse);
    }

    const epoch = typeof payload.epoch === 'number' ? payload.epoch : chat.key_epoch;
    if (epoch !== chat.key_epoch) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Can publish only current chat key epoch' } } as ApiResponse);
    }
    const keyCommitment = String(payload.keyCommitment || '').trim().toLowerCase();
    if (!isSha256Hex(keyCommitment)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'keyCommitment is required (sha256 hex)' } } as ApiResponse);
    }

    const existingCommitment = await groupChatRepository.findEpochKeyCommitment(familyId, chatId, epoch);
    if (!existingCommitment) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Epoch key is not initialized yet' } } as ApiResponse);
    }
    if (existingCommitment !== keyCommitment) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'keyCommitment mismatch for this epoch' } } as ApiResponse);
    }

    const rawEnvelopes = Array.isArray(payload.envelopes) ? payload.envelopes : [];
    const envelopes = rawEnvelopes
      .map((item) => ({
        identityId: String(item?.identityId || '').trim(),
        envelopeCiphertext: String(item?.envelopeCiphertext || '')
      }))
      .filter((item) => item.identityId.length > 0 && item.envelopeCiphertext.length > 0);

    if (envelopes.length === 0) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'envelopes are required' } } as ApiResponse);
    }

    const activeParticipants = await groupChatRepository.listActiveParticipants(familyId, chatId);
    const allowedIds = new Set(activeParticipants.map((p) => p.identity_id));
  for (const envelope of envelopes) {
    if (!allowedIds.has(envelope.identityId)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: `Identity is not active participant: ${envelope.identityId}` } } as ApiResponse);
    }
    if (!isMessageSizeAllowed(envelope.envelopeCiphertext)) {
      return res.status(400).json({ status: 'error', error: { code: 'MESSAGE_TOO_LARGE' as ErrorCode, message: 'Envelope ciphertext is too large' } } as ApiResponse);
    }
    const parsedPublisherId = parseGk2PublisherIdentityId(envelope.envelopeCiphertext);
    if (!parsedPublisherId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Envelope ciphertext must be gk2' } } as ApiResponse);
    }
    if (parsedPublisherId !== publisherIdentityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Envelope publisherIdentityId mismatch' } } as ApiResponse);
    }
  }

    await groupChatRepository.upsertKeyEnvelopes({
      familyId,
      chatId,
      epoch,
      createdAt: Date.now(),
      envelopes: envelopes.map((item) => ({ identityId: item.identityId, envelopeCiphertext: item.envelopeCiphertext, publisherIdentityId }))
    });

    return res.json({ status: 'ok', result: { chatId, epoch, updated: envelopes.length } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Publish group key envelopes error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/keys/fetch', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
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

    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (!chat) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Group chat not found' } } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as { epoch?: number };
    const epoch = typeof payload.epoch === 'number' ? payload.epoch : chat.key_epoch;
    const envelope = await groupChatRepository.findKeyEnvelopeForIdentity(familyId, chatId, epoch, identityId);
    const epochKey = await groupChatRepository.findEpochKey(familyId, chatId, epoch);
    const keyCommitment = epochKey?.key_commitment || null;

    return res.json({
      status: 'ok',
      result: {
        chatId,
        epoch,
        keyCommitment,
        signedEpochTransition: epochKey?.signed_epoch_transition || null,
        proposerIdentityId: epochKey?.proposer_identity_id || null,
        proposerDeviceId: epochKey?.proposer_device_id || null,
        envelopeCiphertext: envelope?.envelope_ciphertext || null,
        publisherIdentityId: envelope?.publisher_identity_id || null,
        hasEnvelope: Boolean(envelope)
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Fetch group key envelope error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});


router.post('/:chatId/keys/coverage', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const ownerCheck = await requireGroupChatOwner(req, chatId);
    if (!ownerCheck.ok) return res.status(ownerCheck.status).json(ownerCheck.body);

    const familyId = req.familyId!;
    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (!chat) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Group chat not found' } } as ApiResponse);
    }

    const payload = (req.signedRequest?.payload || {}) as { epoch?: number };
    const epoch = typeof payload.epoch === 'number' ? payload.epoch : chat.key_epoch;
    const participants = await groupChatRepository.listActiveParticipants(familyId, chatId);

    const envelopeIdentityIds = new Set(await groupChatRepository.listKeyEnvelopeIdentityIds(
      familyId,
      chatId,
      epoch,
      participants.map((participant) => participant.identity_id)
    ));
    const hasEnvelopeByIdentityId = Object.fromEntries(
      participants.map((participant) => [participant.identity_id, envelopeIdentityIds.has(participant.identity_id)])
    );
    const { coverage, missingIdentityIds } = buildEnvelopeCoverage(participants.map((p) => p.identity_id), hasEnvelopeByIdentityId);

    return res.json({
      status: 'ok',
      result: {
        chatId,
        epoch,
        coverage,
        missingIdentityIds
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Group key coverage error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

export default router;
