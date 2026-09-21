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
  groupChatRepository
} from '../db/repositories';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import { requireTrustedGroupDevice } from './groupChatsAccess';

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
