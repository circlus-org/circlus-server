import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import { verifySignature, requireActiveIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import { groupChatRepository, temporaryDeviceRepository } from '../db/repositories';
import { forbidGuestIdentity } from './temporaryAccessRouteSupport';
import { storeTemporaryDeviceChatKeyEnvelopes } from '../services/temporaryChatKeyService';

const router = Router();
router.post('/chat-keys', verifySignature, requireActiveIdentity, async (req: AuthRequest<{
  groupChatIds?: string[];
  directChatIds?: string[];
}> & TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (forbidGuestIdentity(req, res)) {
      return;
    }
    if (req.device?.accessLevel !== 'temporary') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only temporary devices can fetch chat keys' } } as ApiResponse);
    }
    const { groupChatIds = [], directChatIds = [] } = getSignedPayload<{ groupChatIds?: string[]; directChatIds?: string[] }>(req);
    const temporaryDeviceId = req.device.deviceId;

    const groupEnvelopes = await temporaryDeviceRepository.findGroupChatKeyEnvelopes(familyId, temporaryDeviceId, groupChatIds);
    const directEnvelopes = await temporaryDeviceRepository.findDirectChatKeyEnvelopes(familyId, temporaryDeviceId, directChatIds);

    const groupChats = await groupChatRepository.findChatsByIds(
      familyId,
      [...new Set(groupEnvelopes.map((envelope) => envelope.chat_id))]
    );
    const groupChatsById = new Map(groupChats.map((chat) => [chat.chat_id, chat]));
    const groupChatsWithTitle = groupEnvelopes.map((e) => {
      const chat = groupChatsById.get(e.chat_id);
      return {
        chatId: e.chat_id,
        chatTitle: chat?.title_ciphertext ?? e.chat_id,
        epoch: e.epoch,
        envelopeCiphertext: e.envelope_ciphertext,
        publisherIdentityId: e.publisher_identity_id,
        publisherEncPublicKey: { algorithm: e.publisher_enc_public_key_algo, value: e.publisher_enc_public_key_value }
      };
    });

    return res.json({
      status: 'ok',
      result: {
        groupChats: groupChatsWithTitle,
        directChats: directEnvelopes.map((e) => ({
          directChatId: e.direct_chat_id,
          epoch: e.epoch,
          envelopeCiphertext: e.envelope_ciphertext,
          publisherIdentityId: e.publisher_identity_id,
          publisherEncPublicKey: { algorithm: e.publisher_enc_public_key_algo, value: e.publisher_enc_public_key_value }
        }))
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Fetch temp device chat keys error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to fetch chat keys' } } as ApiResponse);
  }
});

// Returns active temp devices approved by the calling device for a given chat.
// The caller (trusted device) uses this to know who to re-key on epoch rotation.
router.post('/chat-keys/approved-devices', verifySignature, requireActiveIdentity, async (req: AuthRequest<{
  chatId?: string;
  chatType?: 'group' | 'direct';
}> & TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (forbidGuestIdentity(req, res)) {
      return;
    }
    if (req.device?.accessLevel !== 'trusted') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only trusted devices can query approved temp devices' } } as ApiResponse);
    }
    const { chatId, chatType = 'group' } = getSignedPayload<{ chatId?: string; chatType?: 'group' | 'direct' }>(req);
    if (!chatId || (chatType !== 'group' && chatType !== 'direct')) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'chatId and chatType are required' } } as ApiResponse);
    }

    const devices = await temporaryDeviceRepository.findApprovedTempDevicesForChat(familyId, req.device.deviceId, chatId, chatType);
    return res.json({
      status: 'ok',
      result: {
        devices: devices.map((d) => ({
          deviceId: d.device_id,
          encryptionPublicKey: d.encryption_public_key_value
            ? { algorithm: d.encryption_public_key_algorithm!, value: d.encryption_public_key_value }
            : null,
          approvalAttestation: d.approval_attestation_payload && d.approval_attestation_signature && d.approving_device_public_key
            ? {
                payload: d.approval_attestation_payload,
                signature: d.approval_attestation_signature,
                approvingDevicePublicKey: d.approving_device_public_key
              }
            : null
        }))
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Approved temp devices for chat error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to fetch approved devices' } } as ApiResponse);
  }
});

// Trusted device publishes new epoch envelopes for temp devices it originally approved.
router.post('/chat-keys/update', verifySignature, requireActiveIdentity, async (req: AuthRequest<{
  chatId?: string;
  chatType?: 'group' | 'direct';
  epoch?: number;
  envelopes?: Array<{
    temporaryDeviceId: string;
    envelopeCiphertext: string;
    publisherEncPublicKeyAlgo: string;
    publisherEncPublicKeyValue: string;
  }>;
}> & TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (forbidGuestIdentity(req, res)) {
      return;
    }
    if (req.device?.accessLevel !== 'trusted') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only trusted devices can update temp device envelopes' } } as ApiResponse);
    }

    const { chatId, chatType = 'group', epoch, envelopes } = getSignedPayload<{
      chatId?: string;
      chatType?: 'group' | 'direct';
      epoch?: number;
      envelopes?: Array<{
        temporaryDeviceId: string;
        envelopeCiphertext: string;
        publisherEncPublicKeyAlgo: string;
        publisherEncPublicKeyValue: string;
      }>;
    }>(req);

    if (
      !chatId
      || (chatType !== 'group' && chatType !== 'direct')
      || typeof epoch !== 'number'
      || !Array.isArray(envelopes)
      || envelopes.length === 0
      || envelopes.length > 500
      || envelopes.some((envelope) => (
        !String(envelope?.temporaryDeviceId || '').trim()
        || !String(envelope?.envelopeCiphertext || '').trim()
        || String(envelope.envelopeCiphertext).length > 64_000
        || !String(envelope?.publisherEncPublicKeyAlgo || '').trim()
        || !String(envelope?.publisherEncPublicKeyValue || '').trim()
      ))
    ) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'chatId, chatType, epoch and envelopes are required' } } as ApiResponse);
    }

    const stored = await storeTemporaryDeviceChatKeyEnvelopes({
      familyId,
      publisherDeviceId: req.device.deviceId,
      publisherIdentityId: req.device.identityId,
      chatId,
      chatType,
      epoch,
      envelopes
    });

    return res.json({ status: 'ok', result: { stored } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Update temp device chat keys error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to update chat keys' } } as ApiResponse);
  }
});


export default router;
