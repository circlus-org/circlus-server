import type { IdentityId } from '../../../shared/types';
import { transaction } from '../db';
import { temporaryDeviceRepository } from '../db/repositories';

type TemporaryChatKeyEnvelope = {
  temporaryDeviceId: string;
  envelopeCiphertext: string;
  publisherEncPublicKeyAlgo: string;
  publisherEncPublicKeyValue: string;
};

export async function storeTemporaryDeviceChatKeyEnvelopes(params: {
  familyId: string;
  publisherDeviceId: string;
  publisherIdentityId: IdentityId;
  chatId: string;
  chatType: 'group' | 'direct';
  epoch: number;
  envelopes: TemporaryChatKeyEnvelope[];
}) {
  const approvedDeviceIds = new Set(
    (await temporaryDeviceRepository.findApprovedTempDevicesForChat(
      params.familyId,
      params.publisherDeviceId,
      params.chatId,
      params.chatType
    )).map((device) => device.device_id)
  );

  return transaction(async (client) => {
    let stored = 0;
    for (const envelope of params.envelopes) {
      if (!approvedDeviceIds.has(envelope.temporaryDeviceId)) continue;
      if (params.chatType === 'group') {
        await temporaryDeviceRepository.upsertGroupChatKeyEnvelope({
          temporaryDeviceId: envelope.temporaryDeviceId,
          familyId: params.familyId,
          chatId: params.chatId,
          epoch: params.epoch,
          envelopeCiphertext: envelope.envelopeCiphertext,
          publisherIdentityId: params.publisherIdentityId,
          publisherEncPublicKeyAlgo: envelope.publisherEncPublicKeyAlgo,
          publisherEncPublicKeyValue: envelope.publisherEncPublicKeyValue
        }, client);
      } else {
        await temporaryDeviceRepository.upsertDirectChatKeyEnvelope({
          temporaryDeviceId: envelope.temporaryDeviceId,
          familyId: params.familyId,
          directChatId: params.chatId,
          epoch: params.epoch,
          envelopeCiphertext: envelope.envelopeCiphertext,
          publisherIdentityId: params.publisherIdentityId,
          publisherEncPublicKeyAlgo: envelope.publisherEncPublicKeyAlgo,
          publisherEncPublicKeyValue: envelope.publisherEncPublicKeyValue
        }, client);
      }
      stored++;
    }
    return stored;
  });
}
