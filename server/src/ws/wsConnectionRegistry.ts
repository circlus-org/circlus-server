import type { WebSocket } from 'ws';
import type { IdentityId } from '@shared/types';
import type { ConnectionInfo } from './wsConnectionContext';

type ConnectionKey = string;

function connectionKey(familyId: string, identityId: IdentityId): ConnectionKey {
  return `${familyId}:${identityId}`;
}

export class WsConnectionRegistry {
  private readonly identitySockets = new Map<ConnectionKey, Set<WebSocket>>();
  private readonly deviceSockets = new Map<string, Set<WebSocket>>();
  private readonly connectionInfo = new Map<WebSocket, ConnectionInfo>();
  private readonly socketFamilyContext = new Map<WebSocket, string>();
  private readonly socketCircleContext = new Map<WebSocket, string>();
  private readonly lastSeenTouchBySocket = new Map<WebSocket, number>();

  register(
    ws: WebSocket,
    info: ConnectionInfo,
    options: { trackDevice?: boolean } = {}
  ): void {
    this.addToIndex(this.identitySockets, connectionKey(info.familyId, info.identityId), ws);
    if (options.trackDevice) {
      this.addToIndex(this.deviceSockets, info.deviceId, ws);
    }
    this.connectionInfo.set(ws, info);
  }

  getInfo(ws: WebSocket): ConnectionInfo | undefined {
    return this.connectionInfo.get(ws);
  }

  hasInfo(ws: WebSocket): boolean {
    return this.connectionInfo.has(ws);
  }

  getIdentitySockets(
    familyId: string,
    identityId: IdentityId
  ): Set<WebSocket> | undefined {
    return this.identitySockets.get(connectionKey(familyId, identityId));
  }

  getDeviceSockets(deviceId: string): Set<WebSocket> | undefined {
    return this.deviceSockets.get(deviceId);
  }

  setFamilyContext(ws: WebSocket, familyId: string): void {
    this.socketFamilyContext.set(ws, familyId);
  }

  getFamilyContext(ws: WebSocket): string | undefined {
    return this.socketFamilyContext.get(ws);
  }

  setCircleContext(ws: WebSocket, circleId: string): void {
    this.socketCircleContext.set(ws, circleId);
  }

  getCircleContext(ws: WebSocket): string | undefined {
    return this.socketCircleContext.get(ws);
  }

  getFamilySocketEntries(familyId: string): Array<[WebSocket, string]> {
    return Array.from(this.socketFamilyContext.entries())
      .filter(([, socketFamilyId]) => socketFamilyId === familyId);
  }

  hasFamilySockets(familyId: string): boolean {
    for (const socketFamilyId of this.socketFamilyContext.values()) {
      if (socketFamilyId === familyId) return true;
    }
    return false;
  }

  getLastSeenTouch(ws: WebSocket): number | undefined {
    return this.lastSeenTouchBySocket.get(ws);
  }

  setLastSeenTouch(ws: WebSocket, timestamp: number): void {
    this.lastSeenTouchBySocket.set(ws, timestamp);
  }

  remove(ws: WebSocket): ConnectionInfo | undefined {
    const info = this.connectionInfo.get(ws);
    this.socketFamilyContext.delete(ws);
    this.socketCircleContext.delete(ws);
    this.lastSeenTouchBySocket.delete(ws);
    this.connectionInfo.delete(ws);
    if (!info) return undefined;

    this.removeFromIndex(
      this.identitySockets,
      connectionKey(info.familyId, info.identityId),
      ws
    );
    this.removeFromIndex(this.deviceSockets, info.deviceId, ws);
    return info;
  }

  getActiveCount(): number {
    let total = 0;
    for (const sockets of this.identitySockets.values()) total += sockets.size;
    return total;
  }

  private addToIndex(
    index: Map<string, Set<WebSocket>>,
    key: string,
    ws: WebSocket
  ): void {
    const sockets = index.get(key) || new Set<WebSocket>();
    sockets.add(ws);
    index.set(key, sockets);
  }

  private removeFromIndex(
    index: Map<string, Set<WebSocket>>,
    key: string,
    ws: WebSocket
  ): void {
    const sockets = index.get(key);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) index.delete(key);
  }
}
