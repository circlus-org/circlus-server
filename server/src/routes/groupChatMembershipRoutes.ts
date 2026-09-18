import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  requireActiveIdentity,
  requireFullCircleIdentity,
  verifySignature,
  type AuthRequest
} from '../middleware/auth';
import {
  deviceRepository,
  groupChatRepository,
  identityRepository
} from '../db/repositories';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import {
  GROUP_CHAT_LIMITS,
  normalizeParticipantIds
} from './groupChatsValidation';
import {
  requireGroupChatOwner,
  requireTrustedGroupDevice
} from './groupChatsAccess';
import {
  addGroupChatParticipants,
  leaveGroupChat,
  removeGroupChatParticipant,
  transferGroupChatOwnership
} from '../services/groupChatMembershipService';

const router = Router();

function parseRegistrationAttestation(value: unknown): unknown | null {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

router.post('/:chatId/participants\\:add', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const ownerCheck = await requireGroupChatOwner(req, chatId);
    if (!ownerCheck.ok) return res.status(ownerCheck.status).json(ownerCheck.body);

    const familyId = req.familyId!;
    const ownerIdentityId = req.device!.identityId;
    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (chat?.protocol_version === 2) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Use an owner-signed group state transition to change membership' } } as ApiResponse);
    }
    const payload = (req.signedRequest?.payload || {}) as { participantIds?: string[] };
    const uniqueParticipantIds = normalizeParticipantIds(payload.participantIds);

    if (uniqueParticipantIds.length === 0) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'participantIds is required' } } as ApiResponse);
    }

    if (uniqueParticipantIds.length > GROUP_CHAT_LIMITS.addParticipantsBatchMax) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: `too many participants in one request (max ${GROUP_CHAT_LIMITS.addParticipantsBatchMax})` } } as ApiResponse);
    }
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

    const { added, keyEpoch } = await addGroupChatParticipants({
        familyId,
        chatId,
        actorIdentityId: ownerIdentityId,
        actorDeviceId: req.device?.deviceId || null,
        actorSignature: req.signedRequest?.signature || null,
        participantIds: uniqueParticipantIds
    });

    return res.json({ status: 'ok', result: { chatId, addedParticipantIds: added, keyEpoch } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Add group participants error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/participants\\:remove', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const ownerCheck = await requireGroupChatOwner(req, chatId);
    if (!ownerCheck.ok) return res.status(ownerCheck.status).json(ownerCheck.body);

    const familyId = req.familyId!;
    const ownerIdentityId = req.device!.identityId;
    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (chat?.protocol_version === 2) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Use an owner-signed group state transition to change membership' } } as ApiResponse);
    }
    const payload = (req.signedRequest?.payload || {}) as { participantId?: string };
    const participantId = String(payload.participantId || '').trim();
    if (!participantId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'participantId is required' } } as ApiResponse);
    }
    if (participantId === ownerIdentityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Owner cannot be removed from the group chat' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, participantId);
    if (!participant || !participant.is_active) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Participant is not active in chat' } } as ApiResponse);
    }

    const { keyEpoch } = await removeGroupChatParticipant({
        familyId,
        chatId,
        actorIdentityId: ownerIdentityId,
        actorDeviceId: req.device?.deviceId || null,
        actorSignature: req.signedRequest?.signature || null,
        participantId
    });

    return res.json({ status: 'ok', result: { chatId, removedParticipantId: participantId, keyEpochRotated: true, keyEpoch } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Remove group participant error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/owner\\:transfer', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const ownerCheck = await requireGroupChatOwner(req, chatId);
    if (!ownerCheck.ok) return res.status(ownerCheck.status).json(ownerCheck.body);

    const familyId = req.familyId!;
    const ownerIdentityId = req.device!.identityId;
    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (chat?.protocol_version === 2) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Use an owner-signed group state transition to transfer ownership' } } as ApiResponse);
    }
    const payload = (req.signedRequest?.payload || {}) as { newOwnerIdentityId?: string };
    const newOwnerIdentityId = String(payload.newOwnerIdentityId || '').trim();
    if (!newOwnerIdentityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'newOwnerIdentityId is required' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, newOwnerIdentityId);
    if (!participant || !participant.is_active) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'new owner must be active chat participant' } } as ApiResponse);
    }

    await transferGroupChatOwnership({
        familyId,
        chatId,
        actorIdentityId: ownerIdentityId,
        actorDeviceId: req.device?.deviceId || null,
        actorSignature: req.signedRequest?.signature || null,
        newOwnerIdentityId
    });

    return res.json({ status: 'ok', result: { chatId, ownerIdentityId: newOwnerIdentityId } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Transfer group owner error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});



router.post('/:chatId/leave-check', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (!chat) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Group chat not found' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, identityId);
    if (!participant || !participant.is_active) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'You are not active participant' } } as ApiResponse);
    }

    if (chat.protocol_version === 2) {
      return res.json({ status: 'ok', result: { canLeaveNow: false, requiresOwnerTransfer: false } } as ApiResponse);
    }

    if (chat.owner_identity_id !== identityId) {
      return res.json({ status: 'ok', result: { canLeaveNow: true, requiresOwnerTransfer: false } } as ApiResponse);
    }

    const participants = await groupChatRepository.listActiveParticipants(familyId, chatId);
    const nextOwnerCandidateIdentityId = participants.find((p) => p.identity_id !== identityId)?.identity_id || null;
    return res.json({
      status: 'ok',
      result: {
        canLeaveNow: true,
        requiresOwnerTransfer: nextOwnerCandidateIdentityId !== null,
        nextOwnerCandidateIdentityId
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Leave-check group chat error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/leave', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.params;
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }

    const chat = await groupChatRepository.findChat(familyId, chatId);
    if (!chat) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Group chat not found' } } as ApiResponse);
    }

    const participant = await groupChatRepository.findParticipant(familyId, chatId, identityId);
    if (!participant || !participant.is_active) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'You are not active participant' } } as ApiResponse);
    }

    if (chat.protocol_version === 2) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Only the owner may remove a participant through a signed group state transition' } } as ApiResponse);
    }

    const { keyEpoch, ownerIdentityId } = await leaveGroupChat({
        familyId,
        chatId,
        actorIdentityId: identityId,
        actorDeviceId: req.device?.deviceId || null,
        actorSignature: req.signedRequest?.signature || null,
        currentOwnerIdentityId: chat.owner_identity_id
    });

    return res.json({ status: 'ok', result: { chatId, leftIdentityId: identityId, ownerIdentityId, keyEpochRotated: true, keyEpoch } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Leave group chat error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:chatId/participants/list', verifySignature, requireActiveIdentity, requireFullCircleIdentity, requireTrustedGroupDevice, async (req: AuthRequest, res) => {
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

    const participants = await groupChatRepository.listActiveParticipantsWithIdentityKeys(familyId, chatId);
    const devices = await deviceRepository.findActiveByIdentityIds(
      familyId,
      participants.map((participantRow) => participantRow.identity_id)
    );
    const devicesByIdentityId = new Map<string, typeof devices>();
    for (const device of devices) {
      const identityDevices = devicesByIdentityId.get(device.identity_id) || [];
      identityDevices.push(device);
      devicesByIdentityId.set(device.identity_id, identityDevices);
    }
    return res.json({
      status: 'ok',
      result: {
        chatId,
        participants: participants.map((p) => ({
          identityId: p.identity_id,
          publicKey: { algorithm: p.public_key_algorithm, value: p.public_key_value },
          devices: (devicesByIdentityId.get(p.identity_id) || []).map((device) => ({
            deviceId: device.device_id,
            identityId: device.identity_id,
            publicKey: {
              algorithm: device.public_key_algorithm,
              value: device.public_key_value
            },
            encryptionPublicKey: (device as any).encryption_public_key_value
              ? {
                  algorithm: (device as any).encryption_public_key_algorithm,
                  value: (device as any).encryption_public_key_value
                }
              : null,
            registrationAttestation: parseRegistrationAttestation((device as any).registration_attestation),
            createdAt: device.created_at.toISOString(),
            status: device.status
          })),
          joinOrder: p.join_order,
          joinedAt: p.joined_at
        }))
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List group chat participants error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

export default router;
