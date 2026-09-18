import { WebSocket } from 'ws';
import type { DeviceId, IdentityId } from '@shared/types';
import type { AuthenticatedActor } from '../services/authenticatedActor';

export type WsActorConnectionInfo = {
  actorType: 'local' | 'external';
  familyId: string;
  identityId: IdentityId;
  deviceId: DeviceId;
};

export type WsErrorSender = (ws: WebSocket, code: string, message: string) => void;

export function actorFromWsConnectionInfo(info: WsActorConnectionInfo): AuthenticatedActor {
  return {
    familyId: info.familyId,
    identityId: info.identityId,
    deviceId: info.deviceId,
    accessLevel: info.actorType === 'local' ? 'trusted' : 'temporary'
  };
}

export function requireWsActor(
  ws: WebSocket,
  getConnectionInfo: (ws: WebSocket) => WsActorConnectionInfo | undefined,
  sendError: WsErrorSender,
  dataDeviceId?: DeviceId | string
): AuthenticatedActor | null {
  const info = getConnectionInfo(ws);
  if (!info) {
    sendError(ws, 'UNAUTHORIZED', 'Not authenticated');
    return null;
  }

  if (dataDeviceId && dataDeviceId !== info.deviceId) {
    sendError(ws, 'FORBIDDEN', 'Device mismatch');
    return null;
  }

  return actorFromWsConnectionInfo(info);
}
