import type { WebSocket } from 'ws';
import type {
  DeviceId,
  WebSocketMessage,
  WSSystemSyncAckData,
  WSSystemSyncData,
  WSSystemSyncResultData
} from '@shared/types';
import type { AuthenticatedActor } from '../services/authenticatedActor';

export type SystemEventWsHandlerDependencies = {
  requireActor: (ws: WebSocket, deviceId?: DeviceId | string) => AuthenticatedActor | null;
  sendMessage: (ws: WebSocket, message: WebSocketMessage) => void;
  sendServiceError: (ws: WebSocket, error: unknown, fallbackMessage: string) => void;
  syncBatchLimit: number;
  listSystemEvents: (
    actor: AuthenticatedActor,
    payload: { since?: number; limit?: number }
  ) => Promise<WSSystemSyncResultData>;
  ackSystemEvents: (
    actor: AuthenticatedActor,
    payload: WSSystemSyncAckData['payload']
  ) => Promise<void>;
  now?: () => number;
};

export class SystemEventWsHandlers {
  private readonly now: () => number;

  constructor(private readonly dependencies: SystemEventWsHandlerDependencies) {
    this.now = dependencies.now || Date.now;
  }

  async handleSync(ws: WebSocket, data: WSSystemSyncData): Promise<void> {
    const actor = this.dependencies.requireActor(ws, data.deviceId);
    if (!actor) return;
    try {
      const result = await this.dependencies.listSystemEvents(actor, {
        since: data.payload?.since,
        limit: this.dependencies.syncBatchLimit
      });
      this.dependencies.sendMessage(ws, {
        type: 'system:sync-result',
        data: result,
        timestamp: this.now()
      });
    } catch (error) {
      this.dependencies.sendServiceError(ws, error, 'Failed to sync system events');
    }
  }

  async handleSyncAck(ws: WebSocket, data: WSSystemSyncAckData): Promise<void> {
    const actor = this.dependencies.requireActor(ws, data.deviceId);
    if (!actor) return;
    try {
      await this.dependencies.ackSystemEvents(actor, data.payload || {});
    } catch (error) {
      this.dependencies.sendServiceError(ws, error, 'Failed to ack system events');
    }
  }
}
