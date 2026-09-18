import type { WSMessageReactionsUpdated } from '@shared/messageReactions';
import type { HttpCallRuntimeSessionManager } from './httpCallRuntimeSessionManager';
import type {
  CallDeliveryStatus,
  CallSessionId,
  DeviceLocalCircleDataDeletionAuthorization,
  IdentityId,
  WebSocketMessage,
  WSGroupChatUpdatedData,
  WSGroupMessageDeliverData,
  WSAttachmentMetadataUpdatedData
} from '@shared/types';

export type WsGatewayImplementation = {
  drainFamilySocketsForMigration: (
    familyId: string,
    details: { migrationId: string; targetPublicBaseUrl: string }
  ) => Promise<number>;
  declineCallViaMobileAction: (params: {
    familyId: string;
    callSessionId: CallSessionId;
    targetIdentityId: IdentityId;
  }) => Promise<{ status: 'declined' | 'not_found' | 'forbidden' | 'noop' }>;
  sendToDevice: (deviceId: string, message: WebSocketMessage) => void;
  sendToIdentity: (
    familyId: string,
    identityId: IdentityId,
    message: WebSocketMessage
  ) => void;
  sendCallDeliveryStatus: (params: {
    familyId: string;
    callerIdentityId: IdentityId;
    callSessionId: CallSessionId;
    status: CallDeliveryStatus;
    reason?: string | null;
    occurredAt: number;
  }) => void;
  notifyDeviceRevoked: (
    deviceId: string,
    identityId: IdentityId,
    localDeletionAuthorization?: DeviceLocalCircleDataDeletionAuthorization
  ) => void;
  notifyTemporaryDeviceExpired: (deviceId: string, identityId: IdentityId) => void;
  suspendIdentityAccess: (familyId: string, identityId: IdentityId) => Promise<void>;
  suspendCircleAccess: (familyId: string) => Promise<void>;
  notifyIdentityServerDataDeleted: (
    familyId: string,
    identityId: IdentityId,
    exceptDeviceId?: string
  ) => void;
  notifyCircleServerDataDeleted: (
    familyId: string,
    exceptDeviceId?: string
  ) => void;
  sendDirectChatEvent: (
    familyId: string,
    identityId: IdentityId,
    directChatId: string,
    message: WebSocketMessage
  ) => void;
  hasIdentityConnections: (familyId: string, identityId: IdentityId) => boolean;
  sendGroupChatEvent: (params: {
    familyId: string;
    participantIdentityIds: IdentityId[];
    eventType: 'group:chat-updated' | 'group:message:deliver' | 'group:message:updated' | 'attachment:metadata-updated' | 'message:reactions-updated';
    payload: WSGroupChatUpdatedData | WSGroupMessageDeliverData | WSAttachmentMetadataUpdatedData | WSMessageReactionsUpdated;
  }) => void;
  createHttpCallRuntimeSession: HttpCallRuntimeSessionManager['create'];
  sendHttpCallRuntimeMessage: HttpCallRuntimeSessionManager['send'];
  pollHttpCallRuntimeMessages: HttpCallRuntimeSessionManager['poll'];
  closeHttpCallRuntimeSession: HttpCallRuntimeSessionManager['close'];
};

export class WsGateway {
  private implementation: WsGatewayImplementation | null = null;

  configure(implementation: WsGatewayImplementation): void {
    if (this.implementation) {
      throw new Error('WebSocket gateway is already configured');
    }
    this.implementation = implementation;
  }

  get(): WsGatewayImplementation {
    if (!this.implementation) {
      throw new Error('WebSocket gateway is not configured');
    }
    return this.implementation;
  }
}

const gateway = new WsGateway();

export function configureWsGateway(implementation: WsGatewayImplementation): void {
  gateway.configure(implementation);
}

export function drainFamilySocketsForMigration(
  familyId: string,
  details: { migrationId: string; targetPublicBaseUrl: string }
): Promise<number> {
  return gateway.get().drainFamilySocketsForMigration(familyId, details);
}

export function declineCallViaMobileAction(params: {
  familyId: string;
  callSessionId: CallSessionId;
  targetIdentityId: IdentityId;
}): Promise<{ status: 'declined' | 'not_found' | 'forbidden' | 'noop' }> {
  return gateway.get().declineCallViaMobileAction(params);
}

export function sendToDeviceWs(deviceId: string, message: WebSocketMessage): void {
  gateway.get().sendToDevice(deviceId, message);
}

export function sendToIdentityWs(
  familyId: string,
  identityId: IdentityId,
  message: WebSocketMessage
): void {
  gateway.get().sendToIdentity(familyId, identityId, message);
}

export function sendCallDeliveryStatusWs(
  params: Parameters<WsGatewayImplementation['sendCallDeliveryStatus']>[0]
): void {
  gateway.get().sendCallDeliveryStatus(params);
}

export function notifyDeviceRevoked(
  deviceId: string,
  identityId: IdentityId,
  localDeletionAuthorization?: DeviceLocalCircleDataDeletionAuthorization
): void {
  gateway.get().notifyDeviceRevoked(deviceId, identityId, localDeletionAuthorization);
}

export function notifyTemporaryDeviceExpired(deviceId: string, identityId: IdentityId): void {
  gateway.get().notifyTemporaryDeviceExpired(deviceId, identityId);
}

export function suspendIdentityWsAccess(familyId: string, identityId: IdentityId): Promise<void> {
  return gateway.get().suspendIdentityAccess(familyId, identityId);
}

export function suspendCircleWsAccess(familyId: string): Promise<void> {
  return gateway.get().suspendCircleAccess(familyId);
}

export function notifyIdentityServerDataDeleted(
  familyId: string,
  identityId: IdentityId,
  exceptDeviceId?: string
): void {
  gateway.get().notifyIdentityServerDataDeleted(familyId, identityId, exceptDeviceId);
}

export function notifyCircleServerDataDeleted(
  familyId: string,
  exceptDeviceId?: string
): void {
  gateway.get().notifyCircleServerDataDeleted(familyId, exceptDeviceId);
}

export function sendDirectChatWsEvent(
  familyId: string,
  identityId: IdentityId,
  directChatId: string,
  message: WebSocketMessage
): void {
  gateway.get().sendDirectChatEvent(familyId, identityId, directChatId, message);
}

export function hasIdentityWsConnections(familyId: string, identityId: IdentityId): boolean {
  return gateway.get().hasIdentityConnections(familyId, identityId);
}

export function sendGroupChatWsEvent(
  params: Parameters<WsGatewayImplementation['sendGroupChatEvent']>[0]
): void {
  gateway.get().sendGroupChatEvent(params);
}

export function createHttpCallRuntimeSession(
  params: Parameters<WsGatewayImplementation['createHttpCallRuntimeSession']>[0]
): ReturnType<WsGatewayImplementation['createHttpCallRuntimeSession']> {
  return gateway.get().createHttpCallRuntimeSession(params);
}

export function sendHttpCallRuntimeMessage(
  params: Parameters<WsGatewayImplementation['sendHttpCallRuntimeMessage']>[0]
): ReturnType<WsGatewayImplementation['sendHttpCallRuntimeMessage']> {
  return gateway.get().sendHttpCallRuntimeMessage(params);
}

export function pollHttpCallRuntimeMessages(
  params: Parameters<WsGatewayImplementation['pollHttpCallRuntimeMessages']>[0]
): ReturnType<WsGatewayImplementation['pollHttpCallRuntimeMessages']> {
  return gateway.get().pollHttpCallRuntimeMessages(params);
}

export function closeHttpCallRuntimeSession(...params: Parameters<HttpCallRuntimeSessionManager['close']>): void {
  gateway.get().closeHttpCallRuntimeSession(...params);
}
