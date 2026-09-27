import { DEFAULT_WS_MAX_PAYLOAD_BYTES } from '../utils/wsTransportConfig';
import {
  booleanSetting,
  integerSetting,
  webSocketPath
} from './runtimeConfigParsing';

export type WebSocketResourceLimits = {
  maxUnregisteredConnections: number;
  maxConnections: number;
  softMaxConnections?: number;
  maxConnectionsPerIp: number;
  handshakeTimeoutMs: number;
  registrationTimeoutMs: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  maxUnregisteredMessages: number;
  maxUnregisteredBytes: number;
  maxGlobalQueuedMessages: number;
  maxGlobalQueuedBytes: number;
  maxOutgoingBytes: number;
  maxOutgoingMessages: number;
  maxGlobalOutgoingMessages: number;

  maxGlobalOutgoingBytes: number;
};

export type WebSocketRuntimeConfig = {
  limits: WebSocketResourceLimits;
  path: string;
  heartbeatIntervalMs: number;
  maxPayloadBytes: number;
  maxSyncBatch: number;
  callHistorySyncBatch: number;
  systemEventSyncBatch: number;
  presenceTouchIntervalMs: number;
  rateLimit: { general: number; callSignaling: number; callEnd: number };
};

export type CallRuntimeConfig = {
  ringTimeoutMs: number;
  signalingRecoveryGraceMs: number;
  cancellationDeliveredGraceMs: number;
  cancellationNoDeliveryFallbackMs: number;
  pushRepeatIntervalMs: number;
  pushRepeatMaxAttempts: number;
  signalingDiagnostics: boolean;
  iceDiagnostics: boolean;
  httpSignaling: { sessionTtlMs: number; maxPollMs: number; maxQueue: number; maxSessions: number; maxSessionsPerIp: number; maxQueueBytes: number; maxGlobalBytes: number };
};

export type CallRuntimeConfigBundle = {
  webSocket: WebSocketRuntimeConfig;
  calls: CallRuntimeConfig;
};

export function loadCallRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): CallRuntimeConfigBundle {
  return {
    webSocket: {
      limits: {
        maxOutgoingMessages: integerSetting({ environment, key: 'WS_MAX_OUTGOING_MESSAGES', defaultValue: 256, min: 1, max: 4096 }),
        maxGlobalOutgoingMessages: integerSetting({ environment, key: 'WS_MAX_GLOBAL_OUTGOING_MESSAGES', defaultValue: 8192, min: 1, max: 65536 }),

        maxUnregisteredConnections: integerSetting({ environment, key: 'WS_MAX_UNREGISTERED_CONNECTIONS', defaultValue: 64, min: 1, max: 10000 }),
        softMaxConnections: integerSetting({ environment, key: 'WS_SOFT_MAX_CONNECTIONS', defaultValue: 192, min: 1, max: 100000 }),
        maxConnections: integerSetting({ environment, key: 'WS_MAX_CONNECTIONS', defaultValue: 256, min: 1, max: 100000 }),
        maxConnectionsPerIp: integerSetting({ environment, key: 'WS_MAX_CONNECTIONS_PER_IP', defaultValue: 128, min: 1, max: 100000 }),
        handshakeTimeoutMs: integerSetting({ environment, key: 'WS_HANDSHAKE_TIMEOUT_MS', defaultValue: 10000, min: 1000, max: 60000 }),
        registrationTimeoutMs: integerSetting({ environment, key: 'WS_REGISTRATION_TIMEOUT_MS', defaultValue: 30000, min: 1000, max: 120000 }),
        maxQueuedMessages: integerSetting({ environment, key: 'WS_MAX_QUEUED_MESSAGES', defaultValue: 128, min: 1, max: 4096 }),
        maxQueuedBytes: integerSetting({ environment, key: 'WS_MAX_QUEUED_BYTES', defaultValue: 4194304, min: 1024, max: 67108864 }),
        maxUnregisteredMessages: integerSetting({ environment, key: 'WS_MAX_UNREGISTERED_MESSAGES', defaultValue: 8, min: 1, max: 128 }),
        maxUnregisteredBytes: integerSetting({ environment, key: 'WS_MAX_UNREGISTERED_BYTES', defaultValue: 262144, min: 1024, max: 1048576 }),
        maxGlobalQueuedMessages: integerSetting({ environment, key: 'WS_MAX_GLOBAL_QUEUED_MESSAGES', defaultValue: 4096, min: 1, max: 65536 }),
        maxGlobalQueuedBytes: integerSetting({ environment, key: 'WS_MAX_GLOBAL_QUEUED_BYTES', defaultValue: 33554432, min: 1024, max: 536870912 }),
        maxOutgoingBytes: integerSetting({ environment, key: 'WS_MAX_OUTGOING_BYTES', defaultValue: 8388608, min: 1024, max: 67108864 }),
        maxGlobalOutgoingBytes: integerSetting({ environment, key: 'WS_MAX_GLOBAL_OUTGOING_BYTES', defaultValue: 67108864, min: 1024, max: 536870912 })
      },
      path: webSocketPath(environment),
      heartbeatIntervalMs: integerSetting({
        environment, key: 'WS_HEARTBEAT_INTERVAL_MS', defaultValue: 30_000, min: 1_000, max: 300_000
      }),
      maxPayloadBytes: integerSetting({
        environment,
        key: 'WS_MAX_PAYLOAD_BYTES',
        defaultValue: DEFAULT_WS_MAX_PAYLOAD_BYTES,
        min: 1_024,
        max: 64 * 1024 * 1024
      }),
      maxSyncBatch: integerSetting({
        environment, key: 'MAX_SYNC_BATCH', defaultValue: 100, min: 1, max: 10_000
      }),
      callHistorySyncBatch: integerSetting({
        environment, key: 'MAX_CALL_HISTORY_SYNC_BATCH', defaultValue: 200, min: 1, max: 10_000
      }),
      systemEventSyncBatch: integerSetting({
        environment, key: 'MAX_SYSTEM_SYNC_BATCH', defaultValue: 200, min: 1, max: 10_000
      }),
      presenceTouchIntervalMs: integerSetting({
        environment,
        key: 'PRESENCE_WS_TOUCH_INTERVAL_MS',
        defaultValue: 30_000,
        min: 15_000,
        max: 120_000
      }),
      rateLimit: {
        general: integerSetting({
          environment, key: 'MAX_WS_RATE', defaultValue: 50, min: 1, max: 1_000_000
        }),
        callSignaling: integerSetting({
          environment, key: 'MAX_WS_CALL_RATE', defaultValue: 200, min: 1, max: 1_000_000
        }),
        callEnd: integerSetting({
          environment, key: 'MAX_WS_CALL_END_RATE', defaultValue: 300, min: 1, max: 1_000_000
        })
      }
    },
    calls: {
      signalingRecoveryGraceMs: integerSetting({
        environment, key: 'CALL_SIGNALING_RECOVERY_GRACE_MS', defaultValue: 120_000, min: 10_000, max: 300_000
      }),
      ringTimeoutMs: integerSetting({
        environment, key: 'CALL_RING_TIMEOUT_MS', defaultValue: 65_000, min: 1_000, max: 10 * 60 * 1000
      }),
      cancellationDeliveredGraceMs: integerSetting({
        environment, key: 'CALL_CANCEL_DELIVERED_GRACE_MS', defaultValue: 3_000, min: 0, max: 10 * 60 * 1000
      }),
      cancellationNoDeliveryFallbackMs: integerSetting({
        environment, key: 'CALL_CANCEL_NO_DELIVERY_FALLBACK_MS', defaultValue: 10_000, min: 0, max: 10 * 60 * 1000
      }),
      pushRepeatIntervalMs: integerSetting({
        environment, key: 'CALL_PUSH_REPEAT_INTERVAL_MS', defaultValue: 5_000, min: 100, max: 10 * 60 * 1000
      }),
      pushRepeatMaxAttempts: integerSetting({
        environment, key: 'CALL_PUSH_REPEAT_MAX_ATTEMPTS', defaultValue: 1, min: 1, max: 100
      }),
      signalingDiagnostics: booleanSetting({
        environment, key: 'CALL_SIGNALING_DIAGNOSTICS', defaultValue: false
      }),
      iceDiagnostics: booleanSetting({
        environment, key: 'CALL_ICE_DIAGNOSTICS', defaultValue: false
      }),
      httpSignaling: {
        maxSessions: integerSetting({ environment, key: 'HTTP_SIGNALING_MAX_SESSIONS', defaultValue: 512, min: 1, max: 100000 }),
        maxSessionsPerIp: integerSetting({ environment, key: 'HTTP_SIGNALING_MAX_SESSIONS_PER_IP', defaultValue: 128, min: 1, max: 100000 }),
        maxQueueBytes: integerSetting({ environment, key: 'HTTP_SIGNALING_MAX_QUEUE_BYTES', defaultValue: 4194304, min: 1024, max: 67108864 }),
        maxGlobalBytes: integerSetting({ environment, key: 'HTTP_SIGNALING_MAX_GLOBAL_BYTES', defaultValue: 33554432, min: 1024, max: 536870912 }),
        sessionTtlMs: integerSetting({
          environment,
          key: 'HTTP_CALL_SIGNALING_SESSION_TTL_MS',
          defaultValue: 15 * 60 * 1000,
          min: 60_000,
          max: 30 * 60 * 1000
        }),
        maxPollMs: integerSetting({
          environment, key: 'HTTP_CALL_SIGNALING_MAX_POLL_MS', defaultValue: 10_000, min: 1_000, max: 25_000
        }),
        maxQueue: integerSetting({
          environment, key: 'HTTP_CALL_SIGNALING_MAX_QUEUE', defaultValue: 500, min: 50, max: 2_000
        })
      }
    }
  };
}
