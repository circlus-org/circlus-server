import { WebSocket } from 'ws';
import {
  callSessionRepository,
  callHistoryRepository,
  deviceRepository,
  identityRepository,
  temporaryDeviceRepository
} from '../db/repositories';
import { MAX_CALL_HISTORY_SYNC_BATCH } from '../db/repositories/callHistoryRepository';
import { MAX_SYSTEM_SYNC_BATCH } from '../db/repositories/systemEventRepository';
import { verifySignedRequest } from '../utils/crypto';
import { sendIncomingCallPush, sendCallStatusPush } from '../utils/push';
import { issueMobileCallBootstrapToken } from '../utils/mobileCallBootstrapToken';
import { CallRingingService } from '../services/callRingingService';
import { CallExpirationService } from '../services/callExpirationService';
import { CallSessionRoutingRegistry } from '../services/callSessionRoutingRegistry';
import { CallSignalingRecovery } from '../services/callSignalingRecovery';
import { readEndedCallForResume } from '../services/endedCallResume';
import { DirectFileTransferSignalingService } from '../services/directFileTransferSignalingService';
import {
  CallLifecycleServiceError,
  finalizeCallForActor,
  markCallConnectedForActor,
  markCallHeartbeatForActor
} from '../services/callLifecycleService';
import { getCircleFreezeState } from '../middleware/circleMigrationFreeze';
import {
  ackCallHistorySyncForActor,
  CallHistoryServiceError,
  listCallHistoryForActor,
  markMissedCallsSeenForActor
} from '../services/callHistoryService';
import {
  SystemEventsServiceError,
  ackSystemEventsForActor,
  listSystemEventsForActor
} from '../services/systemEventsService';
import { requireWsActor as requireAuthenticatedWsActor } from './wsActor';
import { createWsMessageDispatcher, type WsMessageHandlerMap } from './wsMessageDispatcher';
import { createWsTransport } from './wsTransport';
import {
  isMessageAllowedForConnection,
  isOutboundMessageAllowedForConnection,
  type LocalConnectionInfo
} from './wsConnectionContext';
import { CallLifecycleWsHandlers } from './callLifecycleWsHandlers';
import { DirectMessageWsHandlers } from './directMessageWsHandlers';
import {
  WsRegistrationHandlers,
  type ExternalRegisterPayload
} from './wsRegistrationHandlers';
import { CallSignalingWsHandlers } from './callSignalingWsHandlers';
import { CallTerminationWsHandlers } from './callTerminationWsHandlers';
import { WsConnectionRegistry } from './wsConnectionRegistry';
import { HttpCallRuntimeSessionManager } from './httpCallRuntimeSessionManager';
import { WsEventPublisher } from './wsEventPublisher';
import { SystemEventWsHandlers } from './systemEventWsHandlers';
import { configureWsGateway } from './wsGateway';
import { WsRateLimiter } from './wsRateLimiter';
import { getCallRuntimeConfig } from '../config/serverRuntimeConfig';
import { EarlyEndedCallSessionRegistry } from '../services/earlyEndedCallSessionRegistry';
import { serverLogger } from '../utils/logger';
import type {
  WebSocketMessage,
  SignedRequest,
  CallSessionId,
  IdentityId,
  DeviceId,
  WSRegisterCallRuntimeData,
  WSRegisterDirectFileTransferRuntimeData,
  WSSystemSyncData,
  WSSystemSyncAckData,
  WSCallHistorySyncData,
  WSCallHistorySyncAckData,
  WSCallHistoryMarkMissedSeenData,
  WSCallConnectedData,
  WSCallHeartbeatData,
  WSCallResumeData,
  WSCallFinalizedData,
  WSCallVideoStateData,
  WSMessageSendData,
  WSMessageStatusData,
  WSMessageEditData,
  WSMessageDeleteData,
  WSMessageSyncData,
  WSMessageSyncStatusData,
  WSMessageSyncAckData,
  WSMessageSyncStatusAckData,
  WSDirectFileTransferOfferData,
  WSDirectFileTransferBootstrapData,
  WSDirectFileTransferAcceptData,
  WSDirectFileTransferRejectData,
  WSDirectFileTransferIceCandidateData,
  WSDirectFileTransferCompletedData,
  WSDirectFileTransferEndedData,
  WSMarkReadData,
  TemporaryIdentityDelegationCredential,
} from '@shared/types';

const logger = serverLogger.child({ component: 'websocket' });

// Tracks the concrete sockets selected for each call, including multi-device answers.
const callSessionRouting = new CallSessionRoutingRegistry();
const connectionRegistry = new WsConnectionRegistry();

export function setSocketFamilyContext(ws: WebSocket, familyId: string, circleId?: string) {
  connectionRegistry.setFamilyContext(ws, familyId);
  if (circleId) connectionRegistry.setCircleContext(ws, circleId);
}

function closeFamilySocketsForMigration(
  familyId: string,
  details: { migrationId: string; targetPublicBaseUrl: string }
): number {
  let closed = 0;
  for (const [ws] of connectionRegistry.getFamilySocketEntries(familyId)) {
    if (ws.readyState >= WebSocket.CLOSING) continue;
    try {
      ws.send(JSON.stringify({
        type: 'circle:migration:freezing',
        data: details,
        timestamp: Date.now()
      }));
    } catch {
      // Best-effort notice; close still enforces the barrier.
    }
    ws.close(1012, 'CIRCLE_MIGRATING');
    closed += 1;
  }
  return closed;
}

async function drainFamilySocketsForMigrationInternal(
  familyId: string,
  details: { migrationId: string; targetPublicBaseUrl: string }
): Promise<number> {
  const closed = closeFamilySocketsForMigration(familyId, details);
  const deadline = Date.now() + 5000;
  while (
    connectionRegistry.hasFamilySockets(familyId)
    && Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const [ws] of connectionRegistry.getFamilySocketEntries(familyId)) {
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  }
  return closed;
}

const callRuntimeConfig = getCallRuntimeConfig();
const MAX_SYNC_BATCH = callRuntimeConfig.webSocket.maxSyncBatch;
const MAX_WS_RATE = callRuntimeConfig.webSocket.rateLimit.general;
const MAX_WS_CALL_RATE = callRuntimeConfig.webSocket.rateLimit.callSignaling;
const MAX_WS_CALL_END_RATE = callRuntimeConfig.webSocket.rateLimit.callEnd;
const CALL_RING_TIMEOUT_MS = callRuntimeConfig.calls.ringTimeoutMs;
const CALL_CANCEL_DELIVERED_GRACE_MS = callRuntimeConfig.calls.cancellationDeliveredGraceMs;
const CALL_CANCEL_NO_DELIVERY_FALLBACK_MS = (
  callRuntimeConfig.calls.cancellationNoDeliveryFallbackMs
);
const CALL_PUSH_REPEAT_INTERVAL_MS = callRuntimeConfig.calls.pushRepeatIntervalMs;
// Max attempts INCLUDING the initial push. Set to 1 to disable repeats.
const CALL_PUSH_REPEAT_MAX_ATTEMPTS = callRuntimeConfig.calls.pushRepeatMaxAttempts;
const CALL_SIGNALING_DIAGNOSTICS = callRuntimeConfig.calls.signalingDiagnostics;
const CALL_ICE_DIAGNOSTICS = callRuntimeConfig.calls.iceDiagnostics;
const PRESENCE_WS_TOUCH_INTERVAL_MS = callRuntimeConfig.webSocket.presenceTouchIntervalMs;

const wsRateLimiter = new WsRateLimiter<WebSocket>({
  general: MAX_WS_RATE,
  'call:signaling': MAX_WS_CALL_RATE,
  'call:termination': MAX_WS_CALL_END_RATE
});

const EARLY_ENDED_CALL_SESSION_TTL_MS = 2 * 60 * 1000;
const earlyEndedCallSessionRegistry = new EarlyEndedCallSessionRegistry(
  EARLY_ENDED_CALL_SESSION_TTL_MS
);
const HTTP_CALL_SIGNALING_SESSION_TTL_MS = callRuntimeConfig.calls.httpSignaling.sessionTtlMs;
const HTTP_CALL_SIGNALING_MAX_POLL_MS = callRuntimeConfig.calls.httpSignaling.maxPollMs;
const HTTP_CALL_SIGNALING_MAX_QUEUE = callRuntimeConfig.calls.httpSignaling.maxQueue;

async function touchConnectionLastSeen(ws: WebSocket, force = false): Promise<void> {
  const info = connectionRegistry.getInfo(ws);
  if (!info) return;

  const now = Date.now();
  const lastTouchedAt = connectionRegistry.getLastSeenTouch(ws) || 0;
  if (!force && now - lastTouchedAt < PRESENCE_WS_TOUCH_INTERVAL_MS) {
    return;
  }

  // Transport liveness is deliberately separate from user-visible presence.
  connectionRegistry.setLastSeenTouch(ws, now);
  try {
    if (info.actorType === 'local' && !info.isTemporaryDevice) {
      await deviceRepository.updateLastSeen(info.familyId, info.deviceId);
    } else {
      await temporaryDeviceRepository.updateLastSeen(info.familyId, info.deviceId);
    }
  } catch (error) {
    logger.warn('ws_presence_touch_failed', {
      familyId: info.familyId,
      identityId: info.identityId,
      deviceId: info.deviceId,
      error
    });
  }
}

const callExpirationService = new CallExpirationService({
  logger: logger.child({ subsystem: 'call_expiration' }),
  getInitiatorSocket: (callSessionId) => callSessionRouting.get(callSessionId)?.initiatorWs,
  getTargetSockets: (familyId, targetIdentityId) => (
    connectionRegistry.getIdentitySockets(familyId, targetIdentityId)
  ),
  sendMessage: (ws, message) => sendMessage(ws, message),
  sendToConnectionSet: (sockets, message) => sendToConnectionSet(sockets, message),
  resolvePublishedIdentityName,
  removeRoute: (callSessionId) => {
    callSessionRouting.remove(callSessionId);
  }
});

const callRingingService = new CallRingingService({
  logger: logger.child({ subsystem: 'call_ringing' }),
  findCallSession: (familyId, callSessionId) => (
    callSessionRepository.findByCallSessionId(familyId, callSessionId)
  ),
  isTargetOnline: (familyId, targetIdentityId) => {
    const sockets = connectionRegistry.getIdentitySockets(familyId, targetIdentityId);
    return !!sockets && sockets.size > 0;
  },
  issueBootstrapToken: ({ familyId, callSessionId, targetIdentityId, expiresAt }) => (
    issueMobileCallBootstrapToken({
      familyId,
      callSessionId,
      targetIdentityId,
      exp: expiresAt
    })
  ),
  sendIncomingPush: ({
    familyId,
    targetIdentityId,
    callSessionId,
    initiatorIdentityId,
    fromIdentityName,
    isTemporaryLinkCall,
    callLinkTitle,
    bootstrapToken
  }) => sendIncomingCallPush(
    familyId,
    targetIdentityId,
    callSessionId,
    initiatorIdentityId,
    fromIdentityName,
    { bootstrapToken, isTemporaryLinkCall, callLinkTitle }
  ),
  sendCallStatusPush: ({ familyId, targetIdentityId, ...params }) => (
    sendCallStatusPush(familyId, targetIdentityId, params)
  ),
  expireCall: (params) => callExpirationService.expire(params)
}, {
  ringTimeoutMs: CALL_RING_TIMEOUT_MS,
  pushRepeatIntervalMs: CALL_PUSH_REPEAT_INTERVAL_MS,
  pushRepeatMaxAttempts: CALL_PUSH_REPEAT_MAX_ATTEMPTS
});

export function stopCallRingingTimers(): void {
  callRingingService.stopAll();
}

type StoredCallIceCandidate = {
  from: string;
  candidate: any;
};

function getStoredCallIceCandidates(callSession: { ice_candidates?: any } | null | undefined): StoredCallIceCandidate[] {
  const raw = callSession?.ice_candidates;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const from = String((entry as any).from || '').trim();
      const candidate = (entry as any).candidate;
      if (!from || !candidate || typeof candidate !== 'object') return null;
      return { from, candidate };
    })
    .filter((entry): entry is StoredCallIceCandidate => !!entry);
}

function replayStoredIceCandidates(params: {
  ws: WebSocket;
  callSessionId: CallSessionId;
  callSession: { ice_candidates?: any } | null | undefined;
  fromIdentityId: IdentityId;
}) {
  const candidates = getStoredCallIceCandidates(params.callSession)
    .filter((entry) => entry.from === params.fromIdentityId);

  if (candidates.length === 0) return;

  if (CALL_ICE_DIAGNOSTICS) {
    logger.debug('call_ice_candidates_replayed', {
      callSessionId: params.callSessionId,
      fromIdentityId: params.fromIdentityId,
      count: candidates.length
    });
  }

  for (const entry of candidates) {
    sendMessage(params.ws, {
      type: 'call:ice-candidate',
      data: {
        callSessionId: params.callSessionId,
        candidate: entry.candidate
      },
      timestamp: Date.now()
    });
  }
}

async function resolvePublishedIdentityName(familyId: string, identity: any | null): Promise<string | undefined> {
  void familyId;
  void identity;
  return undefined;
}

let httpCallRuntimeSessionManager: HttpCallRuntimeSessionManager;
const wsTransport = createWsTransport({
  findHttpRuntimeQueue: (ws) => httpCallRuntimeSessionManager?.findQueueBySocket(ws) || null,
  maxHttpRuntimeQueue: HTTP_CALL_SIGNALING_MAX_QUEUE,
  canSend: (ws, message) => isOutboundMessageAllowedForConnection(connectionRegistry.getInfo(ws), message.type)
});
function sendMessage(ws: WebSocket, message: WebSocketMessage): void {
  if (callSignalingRecovery?.buffer(ws, message)) return;
  wsTransport.send(ws, message);
}
const sendError = wsTransport.sendError;
const sendToConnectionSet = wsTransport.sendToSet;
let callSignalingRecovery: CallSignalingRecovery;

httpCallRuntimeSessionManager = new HttpCallRuntimeSessionManager({
  handleMessage,
  handleClose,
  setSocketFamilyContext,
  hasConnectionInfo: (ws) => connectionRegistry.hasInfo(ws),
  getConnectionInfo: (ws) => connectionRegistry.getInfo(ws),
  sessionTtlMs: HTTP_CALL_SIGNALING_SESSION_TTL_MS,
  maxPollMs: HTTP_CALL_SIGNALING_MAX_POLL_MS,
  maxQueue: HTTP_CALL_SIGNALING_MAX_QUEUE,
  maxSessions: callRuntimeConfig.calls.httpSignaling.maxSessions,
  maxSessionsPerIp: callRuntimeConfig.calls.httpSignaling.maxSessionsPerIp,
  maxQueueBytes: callRuntimeConfig.calls.httpSignaling.maxQueueBytes,
  maxGlobalBytes: callRuntimeConfig.calls.httpSignaling.maxGlobalBytes
});

const wsEventPublisher = new WsEventPublisher({
  logger: logger.child({ subsystem: 'ws_event_publisher' }),
  registry: connectionRegistry,
  sendMessage,
  sendToSet: sendToConnectionSet,
  sendError,
  hasTemporaryChatAccess: (familyId, deviceId, chatId, chatType) => (
    temporaryDeviceRepository.hasChatAccess(familyId, deviceId, chatId, chatType)
  )
});

function describeSocket(ws: WebSocket): Record<string, string | undefined> {
  const info = connectionRegistry.getInfo(ws);
  if (!info) {
    return { actorType: 'unknown' };
  }

  return {
    actorType: info.actorType,
    identityId: info.identityId,
    deviceId: info.deviceId,
    runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined,
    clientRuntime: info.actorType === 'local' ? info.clientRuntime || 'web' : undefined,
    scopedCallSessionId: info.actorType === 'local' ? info.scopedCallSessionId : undefined,
    scopedDirectFileTransferSessionId: info.actorType === 'local'
      ? info.scopedDirectFileTransferSessionId
      : undefined
  };
}

function logCallDiag(event: string, details: Record<string, unknown>) {
  if (!CALL_SIGNALING_DIAGNOSTICS) return;
  const compact = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
  logger.debug(`call_diag_${event}`, compact);
}

function isGeneralAppSocket(ws: WebSocket): boolean {
  const info = connectionRegistry.getInfo(ws);
  if (!info || info.actorType !== 'local') return false;
  return !info.runtimeMode || info.runtimeMode === 'default';
}

function getGeneralIdentitySockets(familyId: string, identityId: IdentityId): Set<WebSocket> | undefined {
  const sockets = connectionRegistry.getIdentitySockets(familyId, identityId);
  if (!sockets || sockets.size === 0) return undefined;

  const filtered = new Set<WebSocket>();
  for (const ws of sockets) {
    if (isGeneralAppSocket(ws)) {
      filtered.add(ws);
    }
  }

  return filtered.size > 0 ? filtered : undefined;
}

function getWebIncomingCallSockets(familyId: string, identityId: IdentityId): Set<WebSocket> | undefined {
  return getGeneralIdentitySockets(familyId, identityId);
}

const directFileTransferSignaling = new DirectFileTransferSignalingService({
  getConnectionInfo: (ws) => connectionRegistry.getInfo(ws),
  getIdentitySockets: (familyId, identityId) => (
    connectionRegistry.getIdentitySockets(familyId, identityId)
  ),
  getDeviceSockets: (deviceId) => connectionRegistry.getDeviceSockets(deviceId),
  sendMessage,
  sendError,
  resolvePublishedIdentityName
});

function requireWsActor(ws: WebSocket, dataDeviceId?: DeviceId | string) {
  return requireAuthenticatedWsActor(
    ws,
    (socket) => connectionRegistry.getInfo(socket),
    sendError,
    dataDeviceId
  );
}

function rejectTemporaryDirectMessages(ws: WebSocket): boolean {
  const info = connectionRegistry.getInfo(ws);
  if (info?.actorType !== 'local' || !info.isTemporaryDevice) return false;
  sendError(ws, 'FORBIDDEN', 'Temporary devices cannot access direct messages');
  return true;
}

function getDirectChatId(a: string, b: string): string {
  const left = (a || '').trim();
  const right = (b || '').trim();
  if (!left || !right) return `${left}::${right}`;
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}

async function requireTemporaryDirectChatAccess(ws: WebSocket, peerIdentityId: string): Promise<boolean> {
  const info = connectionRegistry.getInfo(ws);
  if (info?.actorType !== 'local' || !info.isTemporaryDevice) return true;
  const directChatId = getDirectChatId(info.identityId, peerIdentityId);
  const allowed = await temporaryDeviceRepository.hasChatAccess(info.familyId, info.deviceId, directChatId, 'direct');
  if (!allowed) {
    sendError(ws, 'FORBIDDEN', 'Temporary device has no access to this chat');
  }
  return allowed;
}

const directMessageWsHandlers = new DirectMessageWsHandlers({
  logger: logger.child({ subsystem: 'direct_message_ws' }),
  requireActor: requireWsActor,
  requireTemporaryChatAccess: requireTemporaryDirectChatAccess,
  rejectTemporaryDirectMessages,
  sendMessage,
  sendError,
  maxSyncBatch: MAX_SYNC_BATCH
});

async function isTemporaryCallTargetAllowed(info: LocalConnectionInfo, peerIdentityId: string): Promise<boolean> {
  if (!info.isTemporaryDevice) return true;
  const device = await temporaryDeviceRepository.findByDeviceId(info.familyId, info.deviceId);
  if (!device || device.status !== 'active' || device.expires_at.getTime() <= Date.now() || !device.can_call) {
    return false;
  }
  return temporaryDeviceRepository.hasChatAccess(
    info.familyId,
    info.deviceId,
    getDirectChatId(info.identityId, peerIdentityId),
    'direct'
  );
}

async function validateTemporaryCallDelegation(params: {
  info: LocalConnectionInfo;
  peerIdentityId: IdentityId;
  callKeyDelegation?: { payload?: string; signature?: string } | null;
}): Promise<boolean> {
  if (!params.info.isTemporaryDevice) return true;
  const serialized = params.callKeyDelegation?.payload;
  const envelopeSignature = params.callKeyDelegation?.signature;
  if (!serialized || !envelopeSignature) return false;

  let credential: TemporaryIdentityDelegationCredential;
  try {
    credential = JSON.parse(serialized) as TemporaryIdentityDelegationCredential;
  } catch {
    return false;
  }
  const payload = credential?.payload;
  const now = Date.now();
  if (
    credential?.type !== 'temporary-identity:delegate'
    || credential.signature !== envelopeSignature
    || credential.signerId !== params.info.identityId
    || payload?.version !== 1
    || payload.purpose !== 'temporary-identity-delegation-v1'
    || payload.identityId !== params.info.identityId
    || payload.temporaryDeviceId !== params.info.deviceId
    || payload.temporaryDevicePublicKey?.algorithm !== 'ed25519'
    || !payload.capabilities?.includes('calls')
    || Date.parse(payload.notBefore) > now
    || Date.parse(payload.expiresAt) <= now
    || !(payload.scope.directChatIds || []).includes(getDirectChatId(params.info.identityId, params.peerIdentityId))
  ) {
    return false;
  }

  const device = await temporaryDeviceRepository.findByDeviceId(params.info.familyId, params.info.deviceId);
  if (
    !device
    || device.status !== 'active'
    || device.expires_at.getTime() <= now
    || !device.can_call
    || device.identity_id !== params.info.identityId
    || device.public_key_value !== payload.temporaryDevicePublicKey.value
  ) {
    return false;
  }
  const identity = await identityRepository.findByIdentityId(params.info.familyId, params.info.identityId);
  if (
    !identity
    || identity.status !== 'active'
    || identity.public_key_value !== payload.identityPublicKey.value
  ) {
    return false;
  }
  const hasScope = await temporaryDeviceRepository.hasChatAccess(
    params.info.familyId,
    params.info.deviceId,
    getDirectChatId(params.info.identityId, params.peerIdentityId),
    'direct'
  );
  if (!hasScope) return false;

  return verifySignedRequest(credential, {
    algorithm: identity.public_key_algorithm === 'x25519' ? 'x25519' : 'ed25519',
    value: identity.public_key_value
  });
}

function sendWsServiceError(ws: WebSocket, error: unknown, fallbackMessage: string): void {
  if (
    error instanceof CallLifecycleServiceError
    || error instanceof CallHistoryServiceError
    || error instanceof SystemEventsServiceError
  ) {
    sendError(ws, error.code, error.message);
    return;
  }
  logger.error('ws_service_error', { message: fallbackMessage, error });
  sendError(ws, 'INTERNAL_ERROR', fallbackMessage);
}

function assertRuntimeScopedCallSession(ws: WebSocket, callSessionId?: string): boolean {
  const info = connectionRegistry.getInfo(ws);
  if (
    info?.actorType === 'local'
    && info.runtimeMode === 'video-native'
    && info.scopedCallSessionId
    && info.scopedCallSessionId !== callSessionId
  ) {
    sendError(ws, 'FORBIDDEN', 'Call runtime registration is not valid for this call');
    return false;
  }
  return true;
}

const callLifecycleWsHandlers = new CallLifecycleWsHandlers({
  requireActor: requireWsActor,
  assertRuntimeScope: assertRuntimeScopedCallSession,
  sendMessage,
  sendServiceError: sendWsServiceError,
  callHistoryBatchLimit: MAX_CALL_HISTORY_SYNC_BATCH,
  listCallHistory: listCallHistoryForActor,
  ackCallHistory: ackCallHistorySyncForActor,
  markMissedCallsSeen: markMissedCallsSeenForActor,
  markCallConnected: markCallConnectedForActor,
  markCallHeartbeat: markCallHeartbeatForActor,
  finalizeCall: finalizeCallForActor
});

const systemEventWsHandlers = new SystemEventWsHandlers({
  requireActor: requireWsActor,
  sendMessage,
  sendServiceError: sendWsServiceError,
  syncBatchLimit: MAX_SYSTEM_SYNC_BATCH,
  listSystemEvents: listSystemEventsForActor,
  ackSystemEvents: ackSystemEventsForActor
});

const wsRegistrationHandlers = new WsRegistrationHandlers({
  logger: logger.child({ subsystem: 'ws_registration' }),
  getSocketFamilyId: (ws) => connectionRegistry.getFamilyContext(ws),
  getSocketCircleId: (ws) => connectionRegistry.getCircleContext(ws),
  registerConnection: (ws, info, options) => {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket closed during registration');
    connectionRegistry.register(ws, info, options);
    if (info.actorType === 'local' && info.scopedCallSessionId) {
      const callSessionId = info.scopedCallSessionId;
      queueMicrotask(() => callSignalingRecovery.resume(ws, info, callSessionId));
    }
  },
  sendMessage,
  sendError,
  touchConnectionLastSeen,
  isTemporaryCallTargetAllowed,
  resolvePublishedIdentityName,
  replayStoredIceCandidates,
  callSessionRouting,
  describeSocket,
  logCallDiag,
  validateDirectFileRuntimeRegistration: (scope) => (
    directFileTransferSignaling.validateRuntimeRegistration(scope)
  )
});

const callSignalingWsHandlers = new CallSignalingWsHandlers({
  logger: logger.child({ subsystem: 'call_signaling' }),
  getConnectionInfo: (ws) => connectionRegistry.getInfo(ws),
  getWebIncomingCallSockets,
  getGeneralIdentitySockets,
  getIdentitySockets: (familyId, identityId) => (
    connectionRegistry.getIdentitySockets(familyId, identityId)
  ),
  sendMessage,
  sendToConnectionSet,
  sendError,
  validateTemporaryCallDelegation,
  consumeEarlyEndedCallSession: (params) => earlyEndedCallSessionRegistry.consume(params),
  isTemporaryCallTargetAllowed,
  resolvePublishedIdentityName,
  replayStoredIceCandidates,
  sendCallDeliveryStatus: (params) => wsEventPublisher.sendCallDeliveryStatus(params),
  supersedeDisconnectedCall: (params) => (
    callSignalingRecovery.supersedeDisconnectedExternalCall(params)
  ),
  callRingingService,
  callSessionRouting,
  describeSocket,
  logCallDiag,
  iceDiagnostics: CALL_ICE_DIAGNOSTICS
});

const callTerminationWsHandlers = new CallTerminationWsHandlers({
  logger: logger.child({ subsystem: 'call_termination' }),
  getConnectionInfo: (ws) => connectionRegistry.getInfo(ws),
  getIdentitySockets: (familyId, identityId) => (
    connectionRegistry.getIdentitySockets(familyId, identityId)
  ),
  getGeneralIdentitySockets,
  rememberEarlyEndedCallSession: (params) => earlyEndedCallSessionRegistry.remember(params),
  sendMessage,
  sendToConnectionSet,
  sendError,
  resolvePublishedIdentityName,
  callRingingService,
  callSessionRouting,
  describeSocket,
  logCallDiag,
  cancellationDeliveredGraceMs: CALL_CANCEL_DELIVERED_GRACE_MS,
  cancellationNoDeliveryFallbackMs: CALL_CANCEL_NO_DELIVERY_FALLBACK_MS,
  iceDiagnostics: CALL_ICE_DIAGNOSTICS
});

callSignalingRecovery = new CallSignalingRecovery({
  routes: callSessionRouting,
  send: wsTransport.send,
  expire: (callSessionId, route, reason) => reason === 'superseded_by_redial'
    ? callTerminationWsHandlers.terminateForSupersededRedial(callSessionId, route)
    : callTerminationWsHandlers.terminateForSignalingTimeout(callSessionId, route),
  graceMs: callRuntimeConfig.calls.signalingRecoveryGraceMs,
  log: (event, details) => logger.warn(event, details)
});

configureWsGateway({
  drainFamilySocketsForMigration: drainFamilySocketsForMigrationInternal,
  declineCallViaMobileAction: (params) => callTerminationWsHandlers.declineViaMobileAction(params),
  sendToDevice: (deviceId, message) => wsEventPublisher.sendToDevice(deviceId, message),
  sendToIdentity: (familyId, identityId, message) => (
    wsEventPublisher.sendToIdentity(familyId, identityId, message)
  ),
  sendCallDeliveryStatus: (params) => wsEventPublisher.sendCallDeliveryStatus(params),
  notifyDeviceRevoked: (deviceId, identityId, localDeletionAuthorization) => (
    wsEventPublisher.notifyDeviceRevoked(deviceId, identityId, localDeletionAuthorization)
  ),
  notifyTemporaryDeviceExpired: (deviceId, identityId) => (
    wsEventPublisher.notifyTemporaryDeviceExpired(deviceId, identityId)
  ),
  suspendIdentityAccess: async (familyId, identityId) => {
    await callTerminationWsHandlers.terminateForIdentitySuspension(familyId, identityId);
    wsEventPublisher.notifyIdentitySuspended(familyId, identityId);
    httpCallRuntimeSessionManager.closeByIdentity(familyId, identityId);
  },
  suspendCircleAccess: async (familyId) => {
    await callTerminationWsHandlers.terminateForCircleSuspension(familyId);
    wsEventPublisher.notifyCircleSuspended(familyId);
    httpCallRuntimeSessionManager.closeByFamily(familyId);
  },
  notifyIdentityServerDataDeleted: (familyId, identityId, exceptDeviceId) => (
    wsEventPublisher.notifyIdentityServerDataDeleted(familyId, identityId, exceptDeviceId)
  ),
  notifyCircleServerDataDeleted: (familyId, exceptDeviceId) => (
    wsEventPublisher.notifyCircleServerDataDeleted(familyId, exceptDeviceId)
  ),
  sendDirectChatEvent: (familyId, identityId, directChatId, message) => (
    wsEventPublisher.sendDirectChatEvent(familyId, identityId, directChatId, message)
  ),
  hasIdentityConnections: (familyId, identityId) => (
    wsEventPublisher.hasIdentityConnections(familyId, identityId)
  ),
  sendGroupChatEvent: (params) => wsEventPublisher.sendGroupChatEvent(params),
  createHttpCallRuntimeSession: (params) => httpCallRuntimeSessionManager.create(params),
  sendHttpCallRuntimeMessage: (params) => httpCallRuntimeSessionManager.send(params),
  pollHttpCallRuntimeMessages: (params) => httpCallRuntimeSessionManager.poll(params),
  closeHttpCallRuntimeSession: (...params) => httpCallRuntimeSessionManager.close(...params)
});

const wsMessageHandlers = {
  ping: (ws) => touchConnectionLastSeen(ws),
  register: (ws, data) => wsRegistrationHandlers.handleLocal(
    ws,
    data as SignedRequest<any, DeviceId>
  ),
  'register-call-runtime': (ws, data) => wsRegistrationHandlers.handleCallRuntime(
    ws,
    data as WSRegisterCallRuntimeData
  ),
  'register-file-transfer-runtime': (ws, data) => (
    wsRegistrationHandlers.handleDirectFileRuntime(
      ws,
      data as WSRegisterDirectFileTransferRuntimeData
    )
  ),
  'register-external': (ws, data) => wsRegistrationHandlers.handleExternal(
    ws,
    data as SignedRequest<ExternalRegisterPayload, string>
  ),
  'call:offer': (ws, data) => callSignalingWsHandlers.handleOffer(ws, data),
  'call:answer': (ws, data) => callSignalingWsHandlers.handleAnswer(ws, data),
  'call:renegotiate-offer': (ws, data) => callSignalingWsHandlers.handleRenegotiateOffer(ws, data),
  'call:renegotiate-answer': (ws, data) => callSignalingWsHandlers.handleRenegotiateAnswer(ws, data),
  'call:ice-candidate': (ws, data) => callSignalingWsHandlers.handleIceCandidate(ws, data),
  'call:video-state': (ws, data) => callSignalingWsHandlers.handleVideoState(
    ws,
    data as WSCallVideoStateData
  ),
  'call:cancel': (ws, data) => callTerminationWsHandlers.handle(ws, data, 'cancel'),
  'call:decline': (ws, data) => callTerminationWsHandlers.handle(ws, data, 'decline'),
  'call:hangup': (ws, data) => callTerminationWsHandlers.handle(ws, data, 'hangup'),
  'file-transfer:offer': (ws, data) => directFileTransferSignaling.handleOffer(
    ws,
    data as WSDirectFileTransferOfferData
  ),
  'file-transfer:accept': (ws, data) => directFileTransferSignaling.handleAccept(
    ws,
    data as WSDirectFileTransferAcceptData
  ),
  'file-transfer:reject': (ws, data) => directFileTransferSignaling.handleReject(
    ws,
    data as WSDirectFileTransferRejectData
  ),
  'file-transfer:ice-candidate': (ws, data) => directFileTransferSignaling.handleIceCandidate(
    ws,
    data as WSDirectFileTransferIceCandidateData
  ),
  'file-transfer:complete': (ws, data) => directFileTransferSignaling.handleComplete(
    ws,
    data as WSDirectFileTransferCompletedData
  ),
  'file-transfer:bootstrap': (ws, data) => directFileTransferSignaling.handleBootstrap(
    ws,
    data as WSDirectFileTransferBootstrapData
  ),
  'file-transfer:renotify': (ws, data) => directFileTransferSignaling.handleRenotify(
    ws,
    data as WSDirectFileTransferBootstrapData
  ),
  'file-transfer:cancel': (ws, data) => directFileTransferSignaling.handleCancel(
    ws,
    data as WSDirectFileTransferEndedData
  ),
  'message:send': (ws, data) => directMessageWsHandlers.handleSend(ws, data as WSMessageSendData),
  'message:status': (ws, data) => directMessageWsHandlers.handleStatus(ws, data as WSMessageStatusData),
  'message:edit': (ws, data) => directMessageWsHandlers.handleEdit(ws, data as WSMessageEditData),
  'message:delete': (ws, data) => directMessageWsHandlers.handleDelete(ws, data as WSMessageDeleteData),
  'message:sync': (ws, data) => directMessageWsHandlers.handleSync(ws, data as WSMessageSyncData),
  'message:sync-status': (ws, data) => directMessageWsHandlers.handleSyncStatus(
    ws,
    data as WSMessageSyncStatusData
  ),
  'message:sync-ack': (ws, data) => directMessageWsHandlers.handleSyncAck(
    ws,
    data as WSMessageSyncAckData
  ),
  'message:sync-status-ack': (ws, data) => directMessageWsHandlers.handleSyncStatusAck(
    ws,
    data as WSMessageSyncStatusAckData
  ),
  'message:mark-read': (ws, data) => directMessageWsHandlers.handleMarkRead(ws, data as WSMarkReadData),
  'system:sync': (ws, data) => systemEventWsHandlers.handleSync(
    ws,
    data as WSSystemSyncData
  ),
  'system:sync-ack': (ws, data) => systemEventWsHandlers.handleSyncAck(
    ws,
    data as WSSystemSyncAckData
  ),
  'call-history:sync': (ws, data) => callLifecycleWsHandlers.handleHistorySync(
    ws,
    data as WSCallHistorySyncData
  ),
  'call-history:sync-ack': (ws, data) => callLifecycleWsHandlers.handleHistorySyncAck(
    ws,
    data as WSCallHistorySyncAckData
  ),
  'call-history:mark-missed-seen': (ws, data) => callLifecycleWsHandlers.handleHistoryMarkMissedSeen(
    ws,
    data as WSCallHistoryMarkMissedSeenData
  ),
  'call:connected': (ws, data) => callLifecycleWsHandlers.handleConnected(
    ws,
    data as WSCallConnectedData
  ),
  'call:heartbeat': (ws, data) => callLifecycleWsHandlers.handleHeartbeat(
    ws,
    data as WSCallHeartbeatData
  ),
  'call:resume': async (ws, data) => {
    const info = connectionRegistry.getInfo(ws);
    const callSessionId = String((data as WSCallResumeData | undefined)?.callSessionId || '').trim();
    if (!info || !callSessionId) {
      sendError(ws, !info ? 'UNAUTHORIZED' : 'VALIDATION_ERROR', !info
        ? 'Not authenticated'
        : 'Missing callSessionId');
      return;
    }
    const resumed = callSignalingRecovery.resume(ws, info, callSessionId);
    const route = callSessionRouting.get(callSessionId);
    const alreadyBound = Boolean(route && (
      (route.initiatorIdentityId === info.identityId && route.initiatorWs === ws)
      || (route.targetIdentityId === info.identityId && route.acceptedTargetWs === ws)
    ));
    if (!resumed && !alreadyBound) {
      const ended = await readEndedCallForResume(info, callSessionId, {
        findSession: (familyId, sessionId) => callSessionRepository.findByCallSessionId(familyId, sessionId),
        findHistory: (familyId, sessionId) => callHistoryRepository.findByCallSessionId(familyId, sessionId)
      });
      if (ended) {
        sendMessage(ws, { type: 'call:ended', data: ended, timestamp: Date.now() });
        return;
      }
    }
    logger.info('call_signaling_resume_result', {
      callSessionId,
      familyId: info.familyId,
      identityId: info.identityId,
      deviceId: info.deviceId,
      resumed,
      alreadyBound
    });
    sendMessage(ws, {
      type: 'call:resumed',
      data: {
        callSessionId,
        resumed: resumed || alreadyBound,
        reason: resumed ? 'resumed' : alreadyBound ? 'already_bound' : 'not_pending'
      },
      timestamp: Date.now()
    });
  },
  'call:finalized': (ws, data) => callLifecycleWsHandlers.handleFinalized(
    ws,
    data as WSCallFinalizedData
  )
} satisfies WsMessageHandlerMap<WebSocket>;

const dispatchWsMessage = createWsMessageDispatcher(wsMessageHandlers);

/**
 * Handle WebSocket message
 */
export async function handleMessage(ws: WebSocket, message: WebSocketMessage) {
  try {
    const socketFamilyId = connectionRegistry.getFamilyContext(ws);
    if (socketFamilyId) {
      const freeze = await getCircleFreezeState(socketFamilyId);
      if (freeze) {
        sendError(ws, 'CIRCLE_MIGRATING', 'Circle migration is in progress');
        return;
      }
    }
    const existingInfo = connectionRegistry.getInfo(ws);
    if (!isMessageAllowedForConnection(existingInfo, message.type)) {
      sendError(ws, 'FORBIDDEN', 'Message type is not allowed for this runtime socket');
      return;
    }

    if (message.type !== 'ping') {
      const { bucket, count, limit, limitExceeded } = wsRateLimiter.consume(ws, message.type);

      if (limitExceeded) {
        const info = connectionRegistry.getInfo(ws);
        logger.warn('ws_rate_limit_exceeded', {
          familyId: info?.familyId,
          identityId: info?.identityId,
          deviceId: info?.deviceId,
          messageType: message.type,
          bucket,
          count,
          limit
        });
        sendError(ws, 'RATE_LIMITED', `WebSocket ${bucket} rate limit exceeded`);
        return;
      }
    }

    if (existingInfo && [
      'call:ice-candidate', 'call:video-state', 'call:renegotiate-offer',
      'call:renegotiate-answer', 'call:connected', 'call:heartbeat', 'call:hangup', 'call:cancel'
    ].includes(message.type)) {
      const callSessionId = message.data?.callSessionId || message.data?.payload?.callSessionId;
      if (typeof callSessionId === 'string') callSignalingRecovery.resume(ws, existingInfo, callSessionId);
    }
    const handled = await dispatchWsMessage(ws, message);
    if (!handled) {
      sendError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${message.type}`);
    }
  } catch (error) {
    logger.error('ws_message_handling_failed', {
      messageType: message.type,
      socket: describeSocket(ws),
      error
    });
    sendError(ws, 'INTERNAL_ERROR', 'Failed to handle message');
  }
}

/**
 * Handle WebSocket close
 */
export function handleClose(ws: WebSocket, details: { code?: number; hasReason?: boolean } = {}) {
  const info = connectionRegistry.getInfo(ws);
  directFileTransferSignaling.handleSocketClosed(ws);
  wsRateLimiter.remove(ws);

  if (info) callSignalingRecovery.closed(ws, info);
  logger.info('ws_connection_closed', {
    ...details,
    ...describeSocket(ws),
    callSessionIds: callSessionRouting.routesForSocket(ws).map(route => route.callSessionId),
    familyId: info?.familyId
  });
  connectionRegistry.remove(ws);
}

/** Log server-initiated termination before the socket loses its call context. */
export function logHeartbeatTimeout(ws: WebSocket): void {
  logger.warn('ws_heartbeat_timeout', {
    ...describeSocket(ws),
    familyId: connectionRegistry.getInfo(ws)?.familyId,
    callSessionIds: callSessionRouting.routesForSocket(ws).map(route => route.callSessionId),
    heartbeatIntervalMs: callRuntimeConfig.webSocket.heartbeatIntervalMs
  });
}

/** Get active connections count (for monitoring). */
export function getActiveConnectionsCount(): number {
  return connectionRegistry.getActiveCount();
}

/** Keep active calls and direct file transfers out of optional WS load shedding. */
export function isSocketInRealtimeSession(ws: WebSocket): boolean {
  const info = connectionRegistry.getInfo(ws);
  return Boolean((info?.actorType === 'local' && info.runtimeMode && info.runtimeMode !== 'default')
    || (info && callSessionRouting.hasIdentity(info.familyId, info.identityId)) || callSessionRouting.hasSocket(ws) || (info && directFileTransferSignaling.hasIdentity(info.familyId, info.identityId)) || directFileTransferSignaling.hasSocket(ws));
}
