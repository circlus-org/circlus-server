import { groupChatRepository, temporaryDeviceRepository } from '../db/repositories';
import { notifyTemporaryDeviceExpired, sendGroupChatWsEvent } from '../ws/wsGateway';
import { sendTemporaryDeviceExpiredPush } from '../utils/push';
import { getRequestLogger } from '../middleware/requestContext';

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
