import type { WebSocket } from 'ws';
import type {
  DeviceId,
  WebSocketMessage,
  WSCallConnectedData,
  WSCallFinalizedData,
  WSCallHeartbeatData,
  WSCallHistoryMarkMissedSeenData,
  WSCallHistorySyncAckData,
  WSCallHistorySyncData,
  WSCallHistorySyncResultData
} from '@shared/types';
import type { AuthenticatedActor } from '../services/authenticatedActor';

export type CallLifecycleWsHandlerDependencies = {
  requireActor: (ws: WebSocket, deviceId?: DeviceId | string) => AuthenticatedActor | null;
  assertRuntimeScope: (ws: WebSocket, callSessionId?: string) => boolean;
  sendMessage: (ws: WebSocket, message: WebSocketMessage) => void;
  sendServiceError: (ws: WebSocket, error: unknown, fallbackMessage: string) => void;
  callHistoryBatchLimit: number;
  listCallHistory: (
    actor: AuthenticatedActor,
    payload: { since?: number; limit?: number }
  ) => Promise<WSCallHistorySyncResultData>;
  ackCallHistory: (
    actor: AuthenticatedActor,
    payload: { syncedThrough?: number }
  ) => Promise<void>;
  markMissedCallsSeen: (
    actor: AuthenticatedActor,
    payload: { callSessionIds?: string[]; peerIdentityId?: string; seenAt?: number }
  ) => Promise<void>;
  markCallConnected: (
    actor: AuthenticatedActor,
    payload: WSCallConnectedData['payload']
  ) => Promise<void>;
  markCallHeartbeat: (
    actor: AuthenticatedActor,
    payload: WSCallHeartbeatData['payload']
  ) => Promise<void>;
  finalizeCall: (
    actor: AuthenticatedActor,
    payload: WSCallFinalizedData['payload']
  ) => Promise<void>;
  now?: () => number;
};

export class CallLifecycleWsHandlers {
  private readonly now: () => number;

  constructor(private readonly dependencies: CallLifecycleWsHandlerDependencies) {
    this.now = dependencies.now || Date.now;
  }

  async handleHistorySync(ws: WebSocket, data: WSCallHistorySyncData): Promise<void> {
    const actor = this.dependencies.requireActor(ws, data.deviceId);
    if (!actor) return;
    try {
      const result = await this.dependencies.listCallHistory(actor, {
        since: data.payload?.since,
        limit: this.dependencies.callHistoryBatchLimit
      });
      this.dependencies.sendMessage(ws, {
        type: 'call-history:sync-result',
        data: result,
        timestamp: this.now()
      });
    } catch (error) {
      this.dependencies.sendServiceError(ws, error, 'Failed to sync call history');
    }
  }

  async handleHistorySyncAck(ws: WebSocket, data: WSCallHistorySyncAckData): Promise<void> {
    const actor = this.dependencies.requireActor(ws, data.deviceId);
    if (!actor) return;
    try {
      await this.dependencies.ackCallHistory(actor, data.payload || {});
    } catch (error) {
      this.dependencies.sendServiceError(ws, error, 'Failed to ack call history');
    }
  }

  async handleHistoryMarkMissedSeen(
    ws: WebSocket,
    data: WSCallHistoryMarkMissedSeenData
  ): Promise<void> {
    const actor = this.dependencies.requireActor(ws, data.deviceId);
    if (!actor) return;
    try {
      await this.dependencies.markMissedCallsSeen(actor, data.payload || {});
    } catch (error) {
      this.dependencies.sendServiceError(ws, error, 'Failed to mark missed calls seen');
    }
  }

  async handleConnected(ws: WebSocket, data: WSCallConnectedData): Promise<void> {
    await this.handleScopedLifecycleReport(
      ws,
      data,
      'Failed to mark call connected',
      this.dependencies.markCallConnected
    );
  }

  async handleHeartbeat(ws: WebSocket, data: WSCallHeartbeatData): Promise<void> {
    await this.handleScopedLifecycleReport(
      ws,
      data,
      'Failed to mark call heartbeat',
      this.dependencies.markCallHeartbeat
    );
  }

  async handleFinalized(ws: WebSocket, data: WSCallFinalizedData): Promise<void> {
    await this.handleScopedLifecycleReport(
      ws,
      data,
      'Failed to finalize call',
      this.dependencies.finalizeCall
    );
  }

  private async handleScopedLifecycleReport<TData extends {
    deviceId?: DeviceId;
    payload?: { callSessionId?: string };
  }>(
    ws: WebSocket,
    data: TData,
    fallbackMessage: string,
    operation: (actor: AuthenticatedActor, payload: NonNullable<TData['payload']>) => Promise<void>
  ): Promise<void> {
    const actor = this.dependencies.requireActor(ws, data.deviceId);
    if (!actor) return;
    if (!this.dependencies.assertRuntimeScope(ws, data.payload?.callSessionId)) return;
    try {
      await operation(actor, (data.payload || {}) as NonNullable<TData['payload']>);
    } catch (error) {
      this.dependencies.sendServiceError(ws, error, fallbackMessage);
    }
  }
}
