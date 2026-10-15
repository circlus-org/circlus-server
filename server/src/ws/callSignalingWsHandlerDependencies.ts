import type { WebSocket } from 'ws';
import type {
  CallDeliveryStatus,
  CallSessionId,
  IdentityId,
  WebSocketMessage
} from '@shared/types';
import type { CallRingingService } from '../services/callRingingService';
import type { CallSessionRoutingRegistry } from '../services/callSessionRoutingRegistry';
import type { Logger } from '../utils/logger';
import type { ConnectionInfo, LocalConnectionInfo } from './wsConnectionContext';
import type { CallAdmissionScope } from '../services/callAdmissionJournal';

export type CallSignalingWsHandlerDependencies = {
  deliverSdp?: (info: ConnectionInfo, message: WebSocketMessage) => boolean;
  hasDurableSdpPeer?: (info: ConnectionInfo, callId: string) => boolean;
  prepareOffer: (scope: CallAdmissionScope, create: () => Promise<unknown>) => Promise<boolean>;
  getConnectionInfo: (ws: WebSocket) => ConnectionInfo | undefined;
  getWebIncomingCallSockets: (
    familyId: string,
    identityId: IdentityId
  ) => Set<WebSocket> | undefined;
  getGeneralIdentitySockets: (
    familyId: string,
    identityId: IdentityId
  ) => Set<WebSocket> | undefined;
  getIdentitySockets: (
    familyId: string,
    identityId: IdentityId
  ) => Set<WebSocket> | undefined;
  sendMessage: (ws: WebSocket, message: WebSocketMessage) => void;
  sendToConnectionSet: (
    sockets: Set<WebSocket> | undefined,
    message: WebSocketMessage
  ) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
  validateTemporaryCallDelegation: (params: {
    info: LocalConnectionInfo;
    peerIdentityId: string;
    callKeyDelegation?: { payload?: string; signature?: string } | null;
  }) => Promise<boolean>;
  consumeEarlyEndedCallSession: (params: {
    familyId: string;
    callSessionId: CallSessionId | string;
    initiatorIdentityId: IdentityId;
  }) => boolean;
  isTemporaryCallTargetAllowed: (
    info: LocalConnectionInfo,
    peerIdentityId: string
  ) => Promise<boolean>;
  replayStoredIceCandidates: (params: {
    ws: WebSocket;
    callSessionId: CallSessionId;
    callSession: { ice_candidates?: any } | null | undefined;
    fromIdentityId: IdentityId;
  }) => void;
  sendCallDeliveryStatus: (params: {
    familyId: string;
    callerIdentityId: IdentityId;
    callSessionId: CallSessionId;
    status: CallDeliveryStatus;
    reason?: string | null;
    occurredAt: number;
  }) => void;
  supersedeDisconnectedCall: (params: {
    ws: WebSocket;
    info: ConnectionInfo;
    previousCallSessionId: string;
    nextCallSessionId: string;
    targetIdentityId: string;
  }) => Promise<boolean>;
  callRingingService: Pick<
    CallRingingService,
    'scheduleExpiry' | 'deliverInitialPush' | 'stop'
  >;
  callSessionRouting: Pick<
    CallSessionRoutingRegistry,
    'get' | 'registerInitiator' | 'bindAcceptedTargetIfAbsent' | 'resolvePeerSocket'
  >;
  describeSocket: (ws: WebSocket) => Record<string, string | undefined>;
  logCallDiag: (event: string, details: Record<string, unknown>) => void;
  logger?: Logger;
  now?: () => number;
  iceDiagnostics?: boolean;
};

export type CallSignalingWsHandlerRuntime = {
  now: () => number;
  logger: Logger;
};
