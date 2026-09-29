import type { WebSocket } from 'ws';
import type { CallSessionId, IdentityId, WebSocketMessage } from '@shared/types';
import {
  callHistoryRepository,
  callSessionRepository,
  identityRepository
} from '../db/repositories';
import type { CallRingingService } from '../services/callRingingService';
import type { CallSessionRoutingRegistry, CallSessionRoute } from '../services/callSessionRoutingRegistry';
import {
  resolveCallTermination,
  type CallTerminationContext,
  type CallTerminationKind
} from '../services/callTerminationPolicy';
import { persistCallTermination } from '../services/callTerminationService';
import { sendCallStatusPush } from '../utils/push';
import { serverLogger, type Logger } from '../utils/logger';
import {
  persistAndClearCallIceStats,
  summarizeCallIceStats
} from './callIceDiagnostics';
import type { ConnectionInfo } from './wsConnectionContext';
import {
  resolveCallLinkPresentation,
  type CallLinkPresentation
} from '../services/callSessionPresentation';

export type CallTerminationWsHandlerDependencies = {
  getConnectionInfo: (ws: WebSocket) => ConnectionInfo | undefined;
  getIdentitySockets: (
    familyId: string,
    identityId: IdentityId
  ) => Set<WebSocket> | undefined;
  getGeneralIdentitySockets: (
    familyId: string,
    identityId: IdentityId
  ) => Set<WebSocket> | undefined;
  rememberEarlyEndedCallSession: (params: {
    familyId: string;
    callSessionId: CallSessionId | string;
    endedByIdentityId: IdentityId;
  }) => void;
  sendMessage: (ws: WebSocket, message: WebSocketMessage) => void;
  sendToConnectionSet: (
    sockets: Set<WebSocket> | undefined,
    message: WebSocketMessage
  ) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
  resolvePublishedIdentityName: (
    familyId: string,
    identity: any | null
  ) => Promise<string | undefined>;
  callRingingService: Pick<CallRingingService, 'stop'>;
  callSessionRouting: Pick<CallSessionRoutingRegistry, 'get' | 'remove'>;
  describeSocket: (ws: WebSocket) => Record<string, string | undefined>;
  logCallDiag: (event: string, details: Record<string, unknown>) => void;
  logger?: Logger;
  cancellationDeliveredGraceMs: number;
  cancellationNoDeliveryFallbackMs: number;
  iceDiagnostics?: boolean;
  now?: () => number;
};

export type MobileCallDeclineResult = {
  status: 'declined' | 'not_found' | 'forbidden' | 'noop';
};

export class CallTerminationWsHandlers {
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly dependencies: CallTerminationWsHandlerDependencies) {
    this.now = dependencies.now || Date.now;
    this.logger = dependencies.logger || serverLogger.child({ subsystem: 'call_termination' });
  }

  async terminateForSignalingTimeout(callSessionId: CallSessionId, route: CallSessionRoute): Promise<void> {
    return this.terminateDisconnectedCall(callSessionId, route, 'signaling_disconnected');
  }

  async terminateForSupersededRedial(callSessionId: CallSessionId, route: CallSessionRoute): Promise<void> {
    return this.terminateDisconnectedCall(callSessionId, route, 'superseded_by_redial');
  }

  private async terminateDisconnectedCall(
    callSessionId: CallSessionId,
    route: CallSessionRoute,
    reason: 'signaling_disconnected' | 'superseded_by_redial'
  ): Promise<void> {
    const { familyId } = route;
    this.dependencies.callRingingService.stop(callSessionId);
    // Release the live peer immediately, independently of database and push latency.
    const message: WebSocketMessage = {
      type: 'call:ended', data: { callSessionId, reason }, timestamp: this.now()
    };
    this.dependencies.sendMessage(route.initiatorWs, message);
    if (route.acceptedTargetWs) this.dependencies.sendMessage(route.acceptedTargetWs, message);
    for (const identityId of [route.initiatorIdentityId, route.targetIdentityId]) {
      this.dependencies.sendToConnectionSet(this.dependencies.getIdentitySockets(familyId, identityId), message);
    }
    await callSessionRepository.end(familyId, callSessionId);
    await Promise.all([
      callHistoryRepository.markFinalized({ familyId, callSessionId,
        endedAt: this.now(), finalStatus: 'failed', reason }),
      persistAndClearCallIceStats({ familyId, callSessionId }),
      ...[route.initiatorIdentityId, route.targetIdentityId].map(targetIdentityId =>
        sendCallStatusPush(familyId, targetIdentityId, {
          callSessionId, callStatus: 'ended', callEndReason: reason,
          fromIdentityId: targetIdentityId === route.initiatorIdentityId
            ? route.targetIdentityId : route.initiatorIdentityId
        }).catch(error => this.logger.warn('call_signaling_termination_push_failed', { callSessionId, reason, error }))
      )
    ]);
  }

  async terminateForIdentitySuspension(
    familyId: string,
    identityId: IdentityId
  ): Promise<number> {
    const activeCalls = (await callSessionRepository.findActive(familyId))
      .filter((callSession) => callSession.participants.includes(identityId));

    for (const callSession of activeCalls) {
      const callSessionId = callSession.call_session_id as CallSessionId;
      const callLinkPresentation = resolveCallLinkPresentation(callSession);
      await callSessionRepository.end(familyId, callSessionId);
      this.dependencies.callRingingService.stop(callSessionId);

      try {
        await callHistoryRepository.markFinalized({
          familyId,
          callSessionId,
          endedAt: this.now(),
          finalStatus: callSession.state === 'active' ? 'ended' : 'failed',
          reason: 'identity_blocked'
        });
      } catch (error) {
        this.logger.warn('call_identity_suspension_history_finalize_failed', {
          familyId,
          identityId,
          callSessionId,
          error
        });
      }

      const endedMessage: WebSocketMessage = {
        type: 'call:ended',
        data: { callSessionId, reason: 'identity_blocked' },
        timestamp: this.now()
      };
      const route = this.dependencies.callSessionRouting.get(callSessionId);
      if (route?.initiatorWs) this.dependencies.sendMessage(route.initiatorWs, endedMessage);
      if (route?.acceptedTargetWs) this.dependencies.sendMessage(route.acceptedTargetWs, endedMessage);
      for (const participantIdentityId of callSession.participants as IdentityId[]) {
        this.dependencies.sendToConnectionSet(
          this.dependencies.getIdentitySockets(familyId, participantIdentityId),
          endedMessage
        );
        if (participantIdentityId === identityId) continue;
        try {
          await sendCallStatusPush(familyId, participantIdentityId, {
            callSessionId,
            callStatus: 'ended',
            callEndReason: 'normal',
            fromIdentityId: identityId,
            ...callLinkPresentation
          });
        } catch (error) {
          this.logger.warn('call_identity_suspension_peer_push_failed', {
            familyId,
            identityId,
            targetIdentityId: participantIdentityId,
            callSessionId,
            error
          });
        }
      }

      this.dependencies.callSessionRouting.remove(callSessionId);
      await persistAndClearCallIceStats({ familyId, callSessionId });
    }

    return activeCalls.length;
  }

  async terminateForCircleSuspension(familyId: string): Promise<number> {
    const activeCalls = await callSessionRepository.findActive(familyId);

    for (const callSession of activeCalls) {
      const callSessionId = callSession.call_session_id as CallSessionId;
      const callLinkPresentation = resolveCallLinkPresentation(callSession);
      await callSessionRepository.end(familyId, callSessionId);
      this.dependencies.callRingingService.stop(callSessionId);

      try {
        await callHistoryRepository.markFinalized({
          familyId,
          callSessionId,
          endedAt: this.now(),
          finalStatus: callSession.state === 'active' ? 'ended' : 'failed',
          reason: 'circle_suspended'
        });
      } catch (error) {
        this.logger.warn('call_circle_suspension_history_finalize_failed', {
          familyId,
          callSessionId,
          error
        });
      }

      const endedMessage: WebSocketMessage = {
        type: 'call:ended',
        data: { callSessionId, reason: 'circle_suspended' },
        timestamp: this.now()
      };
      const route = this.dependencies.callSessionRouting.get(callSessionId);
      if (route?.initiatorWs) this.dependencies.sendMessage(route.initiatorWs, endedMessage);
      if (route?.acceptedTargetWs) this.dependencies.sendMessage(route.acceptedTargetWs, endedMessage);
      for (const participantIdentityId of callSession.participants as IdentityId[]) {
        this.dependencies.sendToConnectionSet(
          this.dependencies.getIdentitySockets(familyId, participantIdentityId),
          endedMessage
        );
        try {
          await sendCallStatusPush(familyId, participantIdentityId, {
            callSessionId,
            callStatus: 'ended',
            callEndReason: 'normal',
            fromIdentityId: callSession.initiator as IdentityId,
            ...callLinkPresentation
          });
        } catch (error) {
          this.logger.warn('call_circle_suspension_push_failed', {
            familyId,
            targetIdentityId: participantIdentityId,
            callSessionId,
            error
          });
        }
      }

      this.dependencies.callSessionRouting.remove(callSessionId);
      await persistAndClearCallIceStats({ familyId, callSessionId });
    }

    return activeCalls.length;
  }

  async declineViaMobileAction(params: {
    familyId: string;
    callSessionId: CallSessionId;
    targetIdentityId: IdentityId;
  }): Promise<MobileCallDeclineResult> {
    const callSession = await callSessionRepository.findByCallSessionId(
      params.familyId,
      params.callSessionId
    );
    if (!callSession) {
      return { status: 'not_found' };
    }
    if (!callSession.participants.includes(params.targetIdentityId)) {
      return { status: 'forbidden' };
    }
    if (
      callSession.state === 'accepted'
      || callSession.state === 'active'
      || callSession.state === 'ended'
      || callSession.state === 'expired'
    ) {
      return { status: 'noop' };
    }

    const callLinkPresentation = resolveCallLinkPresentation(callSession);
    await callSessionRepository.end(params.familyId, params.callSessionId);
    await callHistoryRepository.markRejected({
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      reason: 'mobile_declined'
    });
    this.dependencies.callRingingService.stop(params.callSessionId);

    const endedMessage: WebSocketMessage = {
      type: 'call:ended',
      data: { callSessionId: params.callSessionId, reason: 'declined' },
      timestamp: this.now()
    };
    this.dependencies.sendToConnectionSet(
      this.dependencies.getIdentitySockets(params.familyId, params.targetIdentityId),
      endedMessage
    );

    const otherParticipant = callSession.participants.find(
      (participant) => participant !== params.targetIdentityId
    ) as IdentityId | undefined;
    if (otherParticipant) {
      const initiatorWs = this.dependencies.callSessionRouting.get(
        params.callSessionId
      )?.initiatorWs;
      if (initiatorWs) {
        this.dependencies.logCallDiag('mobile_decline_direct_ended_to_initiator', {
          callSessionId: params.callSessionId,
          familyId: params.familyId,
          fromIdentityId: params.targetIdentityId,
          toIdentityId: otherParticipant,
          targetSocket: this.dependencies.describeSocket(initiatorWs)
        });
        this.dependencies.sendMessage(initiatorWs, endedMessage);
      }
      this.dependencies.sendToConnectionSet(
        this.dependencies.getIdentitySockets(params.familyId, otherParticipant),
        endedMessage
      );
      await this.sendMobileDeclinePeerPush(params, otherParticipant, callLinkPresentation);
    }

    await this.sendMobileDeclineTargetPush(params, otherParticipant, callLinkPresentation);
    this.dependencies.callSessionRouting.remove(params.callSessionId);
    await persistAndClearCallIceStats({
      familyId: params.familyId,
      callSessionId: params.callSessionId
    });
    this.logger.info('call_declined_via_mobile_action', {
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      targetIdentityId: params.targetIdentityId
    });
    return { status: 'declined' };
  }

  async handle(ws: WebSocket, data: any, kind: CallTerminationKind): Promise<void> {
    try {
      const info = this.dependencies.getConnectionInfo(ws);
      if (!info) {
        this.dependencies.sendError(ws, 'UNAUTHORIZED', 'Not authenticated');
        return;
      }

      const callSessionId = data?.callSessionId as CallSessionId | undefined;
      const requestedReason = String(data?.reason || '').trim();
      this.dependencies.logCallDiag(`call_${kind}_received`, {
        callSessionId,
        familyId: info.familyId,
        identityId: info.identityId,
        deviceId: info.deviceId,
        runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined,
        reason: requestedReason || undefined,
        socket: this.dependencies.describeSocket(ws)
      });
      if (!callSessionId) {
        this.dependencies.sendError(ws, 'VALIDATION_ERROR', 'Missing callSessionId');
        return;
      }

      const callSession = await callSessionRepository.findByCallSessionId(
        info.familyId,
        callSessionId
      );
      if (!callSession) {
        this.handleMissingCall(ws, info, callSessionId, kind);
        return;
      }
      if (!callSession.participants.includes(info.identityId)) {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'Not a participant in this call');
        return;
      }

      if (callSession.state === 'ended' || callSession.state === 'expired') {
        this.logger.debug('call_termination_duplicate_ignored', {
          familyId: info.familyId,
          callSessionId,
          kind,
          identityId: info.identityId,
          deviceId: info.deviceId,
          state: callSession.state
        });
        this.dependencies.logCallDiag(`call_${kind}_duplicate_terminal_ignored`, {
          callSessionId,
          familyId: info.familyId,
          endedByIdentityId: info.identityId,
          state: callSession.state,
          socket: this.dependencies.describeSocket(ws)
        });
        return;
      }

      const route = this.dependencies.callSessionRouting.get(callSessionId);
      const endedByInitiator = callSession.initiator === info.identityId;
      const activeRouteWs = endedByInitiator
        ? route?.initiatorWs
        : route?.acceptedTargetWs;
      const activeRouteDeviceId = endedByInitiator
        ? route?.initiatorDeviceId
        : route?.acceptedTargetDeviceId;
      const decision = resolveCallTermination({
        kind,
        requestedReason,
        actorIdentityId: info.identityId,
        actorDeviceId: info.actorType === 'local' ? info.deviceId : undefined,
        actorIsLocal: info.actorType === 'local',
        session: {
          state: callSession.state,
          initiatorIdentityId: callSession.initiator,
          participantIdentityIds: callSession.participants
        },
        activeRouteSocket: !activeRouteWs
          ? 'none'
          : activeRouteWs === ws
            ? 'current'
            : 'other',
        activeRouteDeviceId
      });
      if (!decision.accepted) {
        this.logRejectedTermination({
          ws,
          info,
          kind,
          callSessionId,
          state: callSession.state,
          reason: decision.reason,
          activeRouteWs,
          activeRouteDeviceId
        });
        return;
      }

      const context = decision.context;
      const callLinkPresentation = resolveCallLinkPresentation(callSession);
      this.logger.info('call_termination_accepted', {
        familyId: info.familyId,
        callSessionId,
        kind,
        identityId: info.identityId,
        deviceId: info.deviceId,
        actorType: info.actorType,
        runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined,
        clientRuntime: info.actorType === 'local' ? info.clientRuntime || 'web' : 'external',
        state: callSession.state,
        reason: context.endReason,
        activeRouteDeviceId
      });
      await persistCallTermination({
        familyId: info.familyId,
        callSessionId,
        callSession,
        context,
        terminationAt: this.now(),
        cancellationDeliveredGraceMs: this.dependencies.cancellationDeliveredGraceMs,
        cancellationNoDeliveryFallbackMs: this.dependencies.cancellationNoDeliveryFallbackMs,
        afterSessionEnded: () => this.dependencies.callRingingService.stop(callSessionId)
      });

      // Acknowledge the originating socket before the client releases its call
      // context. Without this, a local cleanup can close the WebSocket while
      // the termination frame is still waiting in the server's work queue.
      this.dependencies.sendMessage(ws, {
        type: 'call:ended',
        data: { callSessionId, reason: context.endReason },
        timestamp: this.now()
      });

      const otherParticipant = context.otherParticipantIdentityId as IdentityId | undefined;
      if (otherParticipant) {
        await this.notifyPeer({
          info,
          kind,
          callSessionId,
          endReason: context.endReason,
          peerPushStatus: context.peerPushStatus,
          peerPushEndReason: context.peerPushEndReason,
          otherParticipant,
          callLinkPresentation,
          directPeerWs: endedByInitiator ? route?.acceptedTargetWs : route?.initiatorWs,
          route
        });
      }
      this.notifySiblingSockets(ws, info, callSessionId, context.endReason);
      await this.updateOwnDevicePush(
        info,
        callSessionId,
        context.pushEndReason,
        otherParticipant,
        callLinkPresentation
      );
      await this.cleanupCall(info, callSessionId, kind);
    } catch (error) {
      this.logger.error('call_termination_failed', {
        callSessionId: data?.callSessionId,
        kind,
        error
      });
      this.dependencies.sendError(ws, 'INTERNAL_ERROR', `Failed to ${kind} call`);
    }
  }

  private async sendMobileDeclinePeerPush(
    params: {
      familyId: string;
      callSessionId: CallSessionId;
      targetIdentityId: IdentityId;
    },
    otherParticipant: IdentityId,
    callLinkPresentation: CallLinkPresentation
  ): Promise<void> {
    try {
      const fromIdentity = await identityRepository.findByIdentityId(
        params.familyId,
        params.targetIdentityId
      );
      const fromIdentityName = await this.dependencies.resolvePublishedIdentityName(
        params.familyId,
        fromIdentity
      );
      await sendCallStatusPush(params.familyId, otherParticipant, {
        callSessionId: params.callSessionId,
        callStatus: 'ended',
        callEndReason: 'declined',
        fromIdentityId: params.targetIdentityId,
        fromIdentityName: callLinkPresentation.isTemporaryLinkCall ? undefined : fromIdentityName,
        ...callLinkPresentation
      });
    } catch (error) {
      this.logger.warn('call_mobile_decline_peer_push_failed', {
        familyId: params.familyId,
        callSessionId: params.callSessionId,
        targetIdentityId: otherParticipant,
        error
      });
    }
  }

  private async sendMobileDeclineTargetPush(
    params: {
      familyId: string;
      callSessionId: CallSessionId;
      targetIdentityId: IdentityId;
    },
    otherParticipant: IdentityId | undefined,
    callLinkPresentation: CallLinkPresentation
  ): Promise<void> {
    try {
      const callerIdentity = otherParticipant
        ? await identityRepository.findByIdentityId(params.familyId, otherParticipant)
        : null;
      const callerIdentityName = await this.dependencies.resolvePublishedIdentityName(
        params.familyId,
        callerIdentity
      );
      await sendCallStatusPush(params.familyId, params.targetIdentityId, {
        callSessionId: params.callSessionId,
        callStatus: 'ended',
        callEndReason: 'normal',
        fromIdentityId: otherParticipant,
        fromIdentityName: callLinkPresentation.isTemporaryLinkCall ? undefined : callerIdentityName,
        ...callLinkPresentation
      });
    } catch (error) {
      this.logger.warn('call_mobile_decline_target_push_failed', {
        familyId: params.familyId,
        callSessionId: params.callSessionId,
        targetIdentityId: params.targetIdentityId,
        error
      });
    }
  }

  private handleMissingCall(
    ws: WebSocket,
    info: ConnectionInfo,
    callSessionId: CallSessionId,
    kind: CallTerminationKind
  ): void {
    if (kind !== 'cancel') {
      this.dependencies.logCallDiag(`call_${kind}_missing_ignored`, {
        callSessionId,
        familyId: info.familyId,
        endedByIdentityId: info.identityId,
        socket: this.dependencies.describeSocket(ws)
      });
      return;
    }
    this.dependencies.rememberEarlyEndedCallSession({
      familyId: info.familyId,
      callSessionId,
      endedByIdentityId: info.identityId
    });
    this.dependencies.logCallDiag('call_cancel_before_offer_remembered', {
      callSessionId,
      familyId: info.familyId,
      endedByIdentityId: info.identityId,
      socket: this.dependencies.describeSocket(ws)
    });
  }

  private logRejectedTermination(params: {
    ws: WebSocket;
    info: ConnectionInfo;
    kind: CallTerminationKind;
    callSessionId: CallSessionId;
    state: string;
    reason: string;
    activeRouteWs?: WebSocket;
    activeRouteDeviceId?: string;
  }): void {
    const inactiveRoute = params.reason === 'socket_mismatch'
      || params.reason === 'device_mismatch';
    this.logger.warn('call_termination_rejected', {
      familyId: params.info.familyId,
      callSessionId: params.callSessionId,
      kind: params.kind,
      routeStatus: inactiveRoute ? 'inactive' : 'invalid',
      identityId: params.info.identityId,
      deviceId: params.info.deviceId,
      actorType: params.info.actorType,
      runtimeMode: params.info.actorType === 'local'
        ? params.info.runtimeMode || 'default'
        : undefined,
      clientRuntime: params.info.actorType === 'local'
        ? params.info.clientRuntime || 'web'
        : 'external',
      state: params.state,
      reason: params.reason,
      activeRouteDeviceId: params.activeRouteDeviceId
    });
    this.dependencies.logCallDiag(
      inactiveRoute
        ? `call_${params.kind}_ignored_inactive_socket`
        : `call_${params.kind}_ignored_invalid`,
      {
        callSessionId: params.callSessionId,
        familyId: params.info.familyId,
        endedByIdentityId: params.info.identityId,
        state: params.state,
        reason: params.reason,
        socket: this.dependencies.describeSocket(params.ws),
        ...(inactiveRoute
          ? {
              activeRouteSocket: params.activeRouteWs
                ? this.dependencies.describeSocket(params.activeRouteWs)
                : undefined,
              activeRouteDeviceId: params.activeRouteDeviceId
            }
          : {})
      }
    );
  }

  private async notifyPeer(params: {
    info: ConnectionInfo;
    kind: CallTerminationKind;
    callSessionId: CallSessionId;
    endReason: string;
    peerPushStatus: CallTerminationContext['peerPushStatus'];
    peerPushEndReason: CallTerminationContext['peerPushEndReason'];
    otherParticipant: IdentityId;
    callLinkPresentation: CallLinkPresentation;
    directPeerWs?: WebSocket;
    route?: ReturnType<CallSessionRoutingRegistry['get']>;
  }): Promise<void> {
    if (params.directPeerWs) {
      this.logger.info('call_termination_delivered_to_peer', {
        familyId: params.info.familyId,
        callSessionId: params.callSessionId,
        kind: params.kind,
        fromIdentityId: params.info.identityId,
        targetIdentityId: params.otherParticipant,
        targetSocket: this.dependencies.describeSocket(params.directPeerWs)
      });
      this.dependencies.logCallDiag(`call_${params.kind}_direct_ended_to_peer`, {
        callSessionId: params.callSessionId,
        familyId: params.info.familyId,
        fromIdentityId: params.info.identityId,
        toIdentityId: params.otherParticipant,
        targetSocket: this.dependencies.describeSocket(params.directPeerWs)
      });
      this.dependencies.sendMessage(params.directPeerWs, {
        type: 'call:ended',
        data: { callSessionId: params.callSessionId, reason: params.endReason },
        timestamp: this.now()
      });
    } else if (params.kind === 'hangup') {
      this.logger.warn('call_hangup_active_peer_socket_missing', {
        familyId: params.info.familyId,
        callSessionId: params.callSessionId,
        fromIdentityId: params.info.identityId,
        targetIdentityId: params.otherParticipant
      });
      this.dependencies.logCallDiag('hangup_active_peer_socket_missing', {
        callSessionId: params.callSessionId,
        familyId: params.info.familyId,
        fromIdentityId: params.info.identityId,
        toIdentityId: params.otherParticipant,
        initiatorSocket: params.route?.initiatorWs
          ? this.dependencies.describeSocket(params.route.initiatorWs)
          : undefined,
        acceptedTargetSocket: params.route?.acceptedTargetWs
          ? this.dependencies.describeSocket(params.route.acceptedTargetWs)
          : undefined
      });
    }

    this.dependencies.sendToConnectionSet(
      this.dependencies.getIdentitySockets(params.info.familyId, params.otherParticipant),
      {
        type: 'call:ended',
        data: { callSessionId: params.callSessionId, reason: params.endReason },
        timestamp: this.now()
      }
    );
    try {
      const fromIdentity = params.info.actorType === 'local'
        ? await identityRepository.findByIdentityId(
            params.info.familyId,
            params.info.identityId
          )
        : null;
      const fromIdentityName = params.info.actorType === 'external'
        ? params.info.externalDisplayName
        : await this.dependencies.resolvePublishedIdentityName(
            params.info.familyId,
            fromIdentity
          );
      const externalCallLinkTitle = params.info.actorType === 'external'
        && params.info.callGrant?.kind === 'call_link'
        ? params.info.callGrant.callLinkTitle || undefined
        : undefined;
      const externalGrantIsCallLink = params.info.actorType === 'external'
        && params.info.callGrant?.kind === 'call_link';
      const isTemporaryLinkCall = params.callLinkPresentation.isTemporaryLinkCall
        || externalGrantIsCallLink;
      const callLinkTitle = params.callLinkPresentation.callLinkTitle
        || externalCallLinkTitle;
      await sendCallStatusPush(params.info.familyId, params.otherParticipant, {
        callSessionId: params.callSessionId,
        callStatus: params.peerPushStatus,
        callEndReason: params.peerPushEndReason,
        fromIdentityId: params.info.identityId,
        fromIdentityName: isTemporaryLinkCall ? undefined : fromIdentityName,
        isTemporaryLinkCall,
        callLinkTitle
      });
    } catch (error) {
      this.logger.warn('call_termination_peer_push_failed', {
        familyId: params.info.familyId,
        callSessionId: params.callSessionId,
        targetIdentityId: params.otherParticipant,
        error
      });
    }
  }

  private notifySiblingSockets(
    ws: WebSocket,
    info: ConnectionInfo,
    callSessionId: CallSessionId,
    endReason: string
  ): void {
    const siblingSockets = this.dependencies.getGeneralIdentitySockets(
      info.familyId,
      info.identityId
    );
    for (const siblingWs of siblingSockets || []) {
      if (siblingWs === ws) continue;
      this.dependencies.sendMessage(siblingWs, {
        type: 'call:ended',
        data: { callSessionId, reason: endReason },
        timestamp: this.now()
      });
    }
  }

  private async updateOwnDevicePush(
    info: ConnectionInfo,
    callSessionId: CallSessionId,
    pushEndReason: CallTerminationContext['pushEndReason'],
    otherParticipant: IdentityId | undefined,
    callLinkPresentation: CallLinkPresentation
  ): Promise<void> {
    try {
      await sendCallStatusPush(info.familyId, info.identityId, {
        callSessionId,
        callStatus: 'ended',
        callEndReason: pushEndReason,
        fromIdentityId: otherParticipant,
        ...callLinkPresentation,
        excludeDeviceIds: info.actorType === 'local' ? [info.deviceId] : undefined
      });
    } catch (error) {
      this.logger.warn('call_termination_own_device_push_failed', {
        familyId: info.familyId,
        callSessionId,
        identityId: info.identityId,
        error
      });
    }
  }

  private async cleanupCall(
    info: ConnectionInfo,
    callSessionId: CallSessionId,
    kind: CallTerminationKind
  ): Promise<void> {
    const route = this.dependencies.callSessionRouting.get(callSessionId);
    this.dependencies.logCallDiag(`call_${kind}_cleanup`, {
      callSessionId,
      familyId: info.familyId,
      endedByIdentityId: info.identityId,
      acceptedTargetSocket: route?.acceptedTargetWs
        ? this.dependencies.describeSocket(route.acceptedTargetWs)
        : undefined,
      initiatorSocket: route?.initiatorWs
        ? this.dependencies.describeSocket(route.initiatorWs)
        : undefined
    });
    this.dependencies.callSessionRouting.remove(callSessionId);
    const iceSummary = this.dependencies.iceDiagnostics
      ? summarizeCallIceStats(callSessionId)
      : '';
    await persistAndClearCallIceStats({ familyId: info.familyId, callSessionId });
    this.logger.info('call_termination_cleanup_completed', {
      familyId: info.familyId,
      callSessionId,
      kind,
      identityId: info.identityId,
      iceSummary: iceSummary || undefined
    });
  }
}
