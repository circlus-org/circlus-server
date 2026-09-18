import type {
  WSGroupChatUpdatedData,
  WSGroupMessageDeliverData,
  WSGroupMessageUpdatedData
} from '../../../shared/types';
import type { GroupChatMessageRecord } from '../db/repositories/groupChatRepository';
import { sendGroupChatWsEvent } from '../ws/wsGateway';

export function fanoutGroupChatEvent(params: {
  familyId: string;
  participantIdentityIds: string[];
  eventType: 'group:chat-updated' | 'group:message:deliver' | 'group:message:updated';
  payload: WSGroupChatUpdatedData | WSGroupMessageDeliverData | WSGroupMessageUpdatedData;
}): void {
  sendGroupChatWsEvent(params);
}

export function buildSystemMessageRecord(params: {
  messageId: string;
  familyId: string;
  chatId: string;
  senderIdentityId: string;
  senderDeviceId: string | null;
  senderSignature: string | null;
  createdAt: number;
  epoch: number;
  systemType: string;
  systemPayload: unknown;
}): GroupChatMessageRecord {
  return {
    message_id: params.messageId,
    family_id: params.familyId,
    chat_id: params.chatId,
    chat_seq: 0,
    sender_identity_id: params.senderIdentityId,
    sender_device_id: params.senderDeviceId,
    kind: 'system',
    ciphertext: null,
    notification_preview_ciphertext: null,
    sender_signature: params.senderSignature,
    temporary_identity_delegation: null,
    client_message_id: null,
    client_created_at: null,
    created_at: params.createdAt,
    content_updated_at: params.createdAt,
    edited_at: null,
    deleted_at: null,
    revision: 1,
    system_type: params.systemType,
    system_payload_json: JSON.stringify(params.systemPayload || {}),
    epoch: params.epoch
  };
}
