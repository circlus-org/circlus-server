import type { IdentityId } from '@shared/types';
import { groupChatRepository, messageRepository, temporaryDeviceRepository } from '../db/repositories';
import { notifyTemporaryDeviceExpired, sendGroupChatWsEvent } from '../ws/wsGateway';
import { sendTemporaryDeviceExpiredPush } from '../utils/push';
import { getRequestLogger } from '../middleware/requestContext';

export async function bumpChatEpochsForIdentity(params: {
  familyId: string;
  identityId: IdentityId;
  reason: 'device_revoked' | 'device_added' | 'periodic';
}): Promise<{ rotatedGroupChats: number; rotatedDirectChats: number }> {
  const affectedGroupChats = await groupChatRepository.listChatsForIdentity(params.familyId, params.identityId);
  for (const chat of affectedGroupChats) {
    const keyEpoch = await groupChatRepository.bumpKeyEpoch(params.familyId, chat.chat_id);
    const participants = await groupChatRepository.listActiveParticipants(params.familyId, chat.chat_id);
    sendGroupChatWsEvent({
      familyId: params.familyId,
      participantIdentityIds: participants.map((participant) => participant.identity_id),
      eventType: 'group:chat-updated',
      payload: {
        chatId: chat.chat_id,
        event: params.reason === 'device_revoked'
          ? 'device_revoked'
          : params.reason === 'device_added'
            ? 'device_added'
            : 'periodic_rekey',
        identityId: params.identityId,
        keyEpoch
      }
    });
  }

  const affectedDirectChatIds = await messageRepository.listDirectChatIdsForIdentity(params.familyId, params.identityId);
  for (const directChatId of affectedDirectChatIds) {
    await messageRepository.bumpDirectEpoch(params.familyId, directChatId);
  }

  return {
    rotatedGroupChats: affectedGroupChats.length,
    rotatedDirectChats: affectedDirectChatIds.length
  };
}

export async function bumpChatEpochsForTemporaryDevice(params: {
  familyId: string;
  temporaryDeviceId: string;
  reason: 'device_revoked' | 'device_expired';
}): Promise<void> {
  const temporaryDevice = await temporaryDeviceRepository.findByDeviceId(params.familyId, params.temporaryDeviceId);
  const rotatedGroups = await temporaryDeviceRepository.terminateAccessAndRotateEpochs(
    params.familyId,
    params.temporaryDeviceId,
    params.reason === 'device_revoked' ? 'revoked' : 'expired'
  );
  for (const chat of rotatedGroups) {
    const participants = await groupChatRepository.listActiveParticipants(params.familyId, chat.chat_id);
    sendGroupChatWsEvent({
      familyId: params.familyId,
      participantIdentityIds: participants.map((p) => p.identity_id),
      eventType: 'group:chat-updated',
      payload: {
        chatId: chat.chat_id,
        event: params.reason === 'device_revoked' ? 'device_revoked' : 'periodic_rekey',
        keyEpoch: chat.key_epoch
      }
    });
  }
  if (params.reason === 'device_expired' && temporaryDevice) {
    notifyTemporaryDeviceExpired(temporaryDevice.device_id, temporaryDevice.identity_id);
    void sendTemporaryDeviceExpiredPush(
      params.familyId,
      temporaryDevice.identity_id,
      temporaryDevice.device_id
    ).catch((error) => {
      getRequestLogger({ subsystem: 'chat_epoch_rotation' }).warn(
        'temporary_device_expiry_push_failed',
        { temporaryDeviceId: temporaryDevice.device_id, error }
      );
    });
  }
}
