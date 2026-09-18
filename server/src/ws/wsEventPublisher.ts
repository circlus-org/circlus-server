import type { WSMessageReactionsUpdated } from '@shared/messageReactions';
import type { WebSocket } from 'ws';
import type {
  CallDeliveryStatus,
  CallSessionId,
  DeviceLocalCircleDataDeletionAuthorization,
  IdentityId,
  WebSocketMessage,
  WSAttachmentMetadataUpdatedData,
  WSGroupChatUpdatedData,
  WSGroupMessageDeliverData
} from '@shared/types';
import type { WsConnectionRegistry } from './wsConnectionRegistry';
import { serverLogger, type Logger } from '../utils/logger';

export type WsEventPublisherDependencies = {
  registry: WsConnectionRegistry;
  sendMessage: (ws: WebSocket, message: WebSocketMessage) => void;
  sendToSet: (sockets: Set<WebSocket> | undefined, message: WebSocketMessage) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
  hasTemporaryChatAccess: (
    familyId: string,
    deviceId: string,
    chatId: string,
    chatType: 'direct' | 'group'
  ) => Promise<boolean>;
  logger?: Logger;
  now?: () => number;
};

export class WsEventPublisher {
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly dependencies: WsEventPublisherDependencies) {
    this.now = dependencies.now || Date.now;
    this.logger = dependencies.logger || serverLogger.child({ subsystem: 'ws_event_publisher' });
  }

  sendToDevice(deviceId: string, message: WebSocketMessage): void {
    this.dependencies.sendToSet(this.dependencies.registry.getDeviceSockets(deviceId), message);
  }

  sendToIdentity(
    familyId: string,
    identityId: IdentityId,
    message: WebSocketMessage
  ): void {
    this.dependencies.sendToSet(
      this.dependencies.registry.getIdentitySockets(familyId, identityId),
      message
    );
  }

  sendCallDeliveryStatus(params: {
    familyId: string;
    callerIdentityId: IdentityId;
    callSessionId: CallSessionId;
    status: CallDeliveryStatus;
    reason?: string | null;
    occurredAt: number;
  }): void {
    this.sendToIdentity(params.familyId, params.callerIdentityId, {
      type: 'call:delivery-status',
      data: {
        callSessionId: params.callSessionId,
        status: params.status,
        reason: params.reason || undefined,
        occurredAt: params.occurredAt
      },
      timestamp: this.now()
    });
  }

  notifyDeviceRevoked(
    deviceId: string,
    identityId: IdentityId,
    localDeletionAuthorization?: DeviceLocalCircleDataDeletionAuthorization
  ): void {
    for (const ws of this.dependencies.registry.getDeviceSockets(deviceId) || []) {
      if (localDeletionAuthorization) {
        this.dependencies.sendMessage(ws, {
          type: 'device:delete-local-circle-data',
          data: { identityId, localDeletionAuthorization },
          timestamp: this.now()
        });
      } else {
        this.dependencies.sendError(ws, 'DEVICE_REVOKED', 'Device has been revoked');
      }
      ws.close(4001, 'Device revoked');
    }
  }

  notifyTemporaryDeviceExpired(deviceId: string, identityId: IdentityId): void {
    for (const ws of this.dependencies.registry.getDeviceSockets(deviceId) || []) {
      this.dependencies.sendMessage(ws, {
        type: 'temporary-device:expired-delete-local-data',
        data: { identityId, temporaryDeviceId: deviceId },
        timestamp: this.now()
      });
      ws.close(4001, 'Temporary device expired');
    }
  }

  notifyIdentitySuspended(familyId: string, identityId: IdentityId): void {
    for (const ws of this.dependencies.registry.getIdentitySockets(familyId, identityId) || []) {
      this.dependencies.sendError(ws, 'IDENTITY_SUSPENDED', 'Identity is suspended');
      ws.close(4003, 'Identity suspended');
    }
  }

  notifyCircleSuspended(familyId: string): void {
    for (const [ws] of this.dependencies.registry.getFamilySocketEntries(familyId)) {
      this.dependencies.sendError(ws, 'CIRCLE_SUSPENDED', 'Circle is suspended');
      ws.close(4004, 'Circle suspended');
    }
  }

  notifyIdentityServerDataDeleted(
    familyId: string,
    identityId: IdentityId,
    exceptDeviceId?: string
  ): void {
    const sockets = this.dependencies.registry.getIdentitySockets(familyId, identityId);
    for (const ws of sockets || []) {
      const info = this.dependencies.registry.getInfo(ws);
      if (exceptDeviceId && info?.deviceId === exceptDeviceId) continue;
      this.dependencies.sendMessage(ws, {
        type: 'identity:server-data-deleted',
        data: { identityId, scope: 'identity' },
        timestamp: this.now()
      });
      ws.close(4001, 'Circle server data deleted');
    }
  }

  notifyCircleServerDataDeleted(familyId: string, exceptDeviceId?: string): void {
    for (const [ws] of this.dependencies.registry.getFamilySocketEntries(familyId)) {
      const info = this.dependencies.registry.getInfo(ws);
      if (!info) continue;
      if (exceptDeviceId && info.deviceId === exceptDeviceId) continue;
      this.dependencies.sendMessage(ws, {
        type: 'identity:server-data-deleted',
        data: { identityId: info.identityId, scope: 'circle' },
        timestamp: this.now()
      });
      ws.close(4001, 'Circle server data deleted');
    }
  }

  sendDirectChatEvent(
    familyId: string,
    identityId: IdentityId,
    directChatId: string,
    message: WebSocketMessage
  ): void {
    this.sendChatScopedEvent({
      familyId,
      identityId,
      chatId: directChatId,
      chatType: 'direct',
      message
    });
  }

  hasIdentityConnections(familyId: string, identityId: IdentityId): boolean {
    return (this.dependencies.registry.getIdentitySockets(familyId, identityId)?.size || 0) > 0;
  }

  sendGroupChatEvent(params: {
    familyId: string;
    participantIdentityIds: IdentityId[];
    eventType: 'group:chat-updated' | 'group:message:deliver' | 'group:message:updated' | 'attachment:metadata-updated' | 'message:reactions-updated';
    payload: WSGroupChatUpdatedData | WSGroupMessageDeliverData | WSAttachmentMetadataUpdatedData | WSMessageReactionsUpdated;
  }): void {
    const identityIds = new Set(
      params.participantIdentityIds
        .map((identityId) => String(identityId || '').trim())
        .filter(Boolean)
    );
    const chatId = String(params.payload.chatId || '').trim();
    const message: WebSocketMessage = {
      type: params.eventType,
      data: params.payload,
      timestamp: this.now()
    };
    for (const identityId of identityIds) {
      this.sendChatScopedEvent({
        familyId: params.familyId,
        identityId: identityId as IdentityId,
        chatId,
        chatType: 'group',
        message
      });
    }
  }

  private sendChatScopedEvent(params: {
    familyId: string;
    identityId: IdentityId;
    chatId: string;
    chatType: 'direct' | 'group';
    message: WebSocketMessage;
  }): void {
    const sockets = this.dependencies.registry.getIdentitySockets(
      params.familyId,
      params.identityId
    );
    for (const ws of sockets || []) {
      const info = this.dependencies.registry.getInfo(ws);
      if (info?.actorType !== 'local' || !info.isTemporaryDevice) {
        this.dependencies.sendMessage(ws, params.message);
        continue;
      }
      void this.dependencies.hasTemporaryChatAccess(
        params.familyId,
        info.deviceId,
        params.chatId,
        params.chatType
      ).then((allowed) => {
        if (allowed) this.dependencies.sendMessage(ws, params.message);
      }).catch((error) => {
        this.logger.warn('ws_temporary_chat_access_check_failed', {
          familyId: params.familyId,
          identityId: params.identityId,
          deviceId: info.deviceId,
          chatId: params.chatId,
          chatType: params.chatType,
          messageType: params.message.type,
          error
        });
      });
    }
  }
}
