import type { WebSocket } from 'ws';
import type { IdentityId, WebSocketMessage, WSCallVideoStateData } from '@shared/types';
import { callSessionRepository, identityRepository } from '../db/repositories';
import { recordCallIceCandidate } from './callIceDiagnostics';
import type { ConnectionInfo } from './wsConnectionContext';
import type {
  CallSignalingWsHandlerDependencies,
  CallSignalingWsHandlerRuntime
} from './callSignalingWsHandlerDependencies';

export class CallPeerMediaWsHandlers {
  private readonly now: () => number;
  private readonly logger: CallSignalingWsHandlerRuntime['logger'];

  constructor(
    private readonly dependencies: CallSignalingWsHandlerDependencies,
    runtime: CallSignalingWsHandlerRuntime
  ) {
    this.now = runtime.now;
    this.logger = runtime.logger;
  }
  async handleRenegotiateOffer(ws: WebSocket, data: any): Promise<void> {
    await this.handleRenegotiation(ws, data, 'offer');
  }

  async handleRenegotiateAnswer(ws: WebSocket, data: any): Promise<void> {
    await this.handleRenegotiation(ws, data, 'answer');
  }

  async handleIceCandidate(ws: WebSocket, data: any): Promise<void> {
    try {
      const info = this.dependencies.getConnectionInfo(ws);
      if (!info) {
        this.dependencies.sendError(ws, 'UNAUTHORIZED', 'Not authenticated');
        return;
      }
      const { callSessionId, candidate } = data;
      if (!callSessionId || !candidate) {
        this.dependencies.sendError(
          ws,
          'VALIDATION_ERROR',
          'Missing callSessionId or candidate'
        );
        return;
      }

      const callSession = await callSessionRepository.findByCallSessionId(
        info.familyId,
        callSessionId
      );
      if (!callSession) {
        this.logger.warn('call_ice_session_not_found', {
          familyId: info.familyId,
          identityId: info.identityId,
          callSessionId
        });
        this.dependencies.sendError(ws, 'CALL_NOT_FOUND', 'Call session not found');
        return;
      }
      if (!callSession.participants.includes(info.identityId)) {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'Not a participant in this call');
        return;
      }
      if (isTerminalCallState(callSession.state)) {
        this.dependencies.logCallDiag('ice_candidate_ignored_terminal', {
          callSessionId,
          familyId: info.familyId,
          identityId: info.identityId,
          deviceId: info.actorType === 'local' ? info.deviceId : undefined,
          state: callSession.state
        });
        return;
      }

      const recorded = recordCallIceCandidate({
        callSessionId,
        identityId: info.identityId,
        candidate
      });
      await callSessionRepository.addIceCandidate(info.familyId, callSessionId, {
        from: info.identityId,
        candidate
      });
      if (
        this.dependencies.iceDiagnostics
        && (recorded.entry.total <= 2 || recorded.entry.total % 10 === 0)
      ) {
        this.logger.debug('call_ice_candidate_recorded', {
          familyId: info.familyId,
          callSessionId,
          fromIdentityId: info.identityId,
          count: recorded.entry.total,
          candidateType: recorded.parsed.candidateType,
          protocol: recorded.parsed.protocol,
          address: recorded.parsed.address,
          port: recorded.parsed.port,
          totals: {
            relay: recorded.entry.relay,
            srflx: recorded.entry.srflx,
            host: recorded.entry.host,
            prflx: recorded.entry.prflx
          }
        });
      }

      const otherParticipant = callSession.participants.find(
        (participant: string) => participant !== info.identityId
      ) as IdentityId | undefined;
      if (!otherParticipant) return;
      const route = this.dependencies.callSessionRouting.get(callSessionId);
      if (route?.acceptedTargetWs) {
        const directPeerWs = this.dependencies.callSessionRouting.resolvePeerSocket(
          callSessionId,
          info.identityId
        );
        if (directPeerWs) {
          this.dependencies.sendMessage(directPeerWs, {
            type: 'call:ice-candidate',
            data: { callSessionId, candidate },
            timestamp: this.now()
          });
          return;
        }
      }
      this.dependencies.sendToConnectionSet(
        this.dependencies.getIdentitySockets(info.familyId, otherParticipant),
        {
          type: 'call:ice-candidate',
          data: { callSessionId, candidate },
          timestamp: this.now()
        }
      );
    } catch (error) {
      this.logger.error('call_ice_candidate_failed', {
        callSessionId: data?.callSessionId,
        error
      });
      this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Failed to handle ICE candidate');
    }
  }

  async handleVideoState(ws: WebSocket, data: WSCallVideoStateData): Promise<void> {
    try {
      const info = this.dependencies.getConnectionInfo(ws);
      if (!info) {
        this.dependencies.sendError(ws, 'UNAUTHORIZED', 'Not authenticated');
        return;
      }
      const { callSessionId, enabled } = data || {};
      if (!callSessionId || typeof enabled !== 'boolean') {
        this.dependencies.sendError(
          ws,
          'VALIDATION_ERROR',
          'Missing callSessionId or enabled'
        );
        return;
      }

      const callSession = await callSessionRepository.findByCallSessionId(
        info.familyId,
        callSessionId
      );
      if (!callSession) {
        this.logger.warn('call_video_state_session_not_found', {
          familyId: info.familyId,
          identityId: info.identityId,
          callSessionId
        });
        this.dependencies.sendError(ws, 'CALL_NOT_FOUND', 'Call session not found');
        return;
      }
      if (!callSession.participants.includes(info.identityId)) {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'Not a participant in this call');
        return;
      }
      if (isTerminalCallState(callSession.state)) {
        // Web clients sync video state after registration, including audio calls.
        // A participant returning after the recovery deadline must leave the old call.
        this.dependencies.sendMessage(ws, {
          type: 'call:ended',
          data: { callSessionId, reason: callSession.state },
          timestamp: this.now()
        });
        return;
      }

      const otherParticipant = callSession.participants.find(
        (participant: string) => participant !== info.identityId
      ) as IdentityId | undefined;
      if (!otherParticipant) return;
      this.dependencies.logCallDiag('video_state_received', {
        callSessionId,
        familyId: info.familyId,
        identityId: info.identityId,
        deviceId: info.deviceId,
        runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined,
        enabled
      });

      const message: WebSocketMessage = {
        type: 'call:video-state',
        data: {
          callSessionId, enabled,
          ...(data.source === 'camera' || data.source === 'screen' ? { source: data.source } : {}),
          ...(data.requestReply === true ? { requestReply: true } : {})
        },
        timestamp: this.now()
      };
      const directPeerWs = this.dependencies.callSessionRouting.resolvePeerSocket(
        callSessionId,
        info.identityId
      );
      if (directPeerWs) {
        this.dependencies.logCallDiag('video_state_forwarded', {
          callSessionId,
          familyId: info.familyId,
          fromIdentityId: info.identityId,
          enabled,
          targetSocket: this.dependencies.describeSocket(directPeerWs)
        });
        this.dependencies.sendMessage(directPeerWs, message);
        return;
      }

      const otherSockets = this.dependencies.getIdentitySockets(
        info.familyId,
        otherParticipant
      );
      this.dependencies.logCallDiag('video_state_broadcast', {
        callSessionId,
        familyId: info.familyId,
        fromIdentityId: info.identityId,
        enabled,
        targetIdentityId: otherParticipant,
        targetSocketCount: otherSockets?.size || 0
      });
      this.dependencies.sendToConnectionSet(otherSockets, message);
    } catch (error) {
      this.logger.error('call_video_state_failed', {
        callSessionId: data?.callSessionId,
        error
      });
      this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Failed to handle video state');
    }
  }

  private async handleRenegotiation(
    ws: WebSocket,
    data: any,
    kind: 'offer' | 'answer'
  ): Promise<void> {
    const messageType = `call:renegotiate-${kind}`;
    const payloadValue = data?.[kind];
    try {
      const info = this.dependencies.getConnectionInfo(ws);
      if (!info) {
        this.dependencies.sendError(ws, 'UNAUTHORIZED', 'Not authenticated');
        return;
      }
      const callSessionId = data?.callSessionId;
      this.dependencies.logCallDiag(`renegotiate_${kind}_received`, {
        callSessionId,
        familyId: info.familyId,
        identityId: info.identityId,
        deviceId: info.deviceId,
        runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined
      });
      if (!callSessionId || !payloadValue) {
        this.dependencies.sendError(
          ws,
          'VALIDATION_ERROR',
          `Missing callSessionId or ${kind}`
        );
        return;
      }

      const callSession = await callSessionRepository.findByCallSessionId(
        info.familyId,
        callSessionId
      );
      if (!callSession) {
        this.logger.warn('call_renegotiation_session_not_found', {
          familyId: info.familyId,
          identityId: info.identityId,
          callSessionId,
          kind
        });
        this.dependencies.sendError(ws, 'CALL_NOT_FOUND', 'Call session not found');
        return;
      }
      this.logger.debug('call_renegotiation_received', {
        familyId: info.familyId,
        callSessionId,
        fromIdentityId: info.identityId,
        state: callSession.state,
        kind
      });
      if (!callSession.participants.includes(info.identityId)) {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'Not a participant in this call');
        return;
      }
      if (isTerminalCallState(callSession.state)) return;

      try {
        if (kind === 'offer') {
          await callSessionRepository.updateSdpOffer(
            info.familyId,
            callSessionId,
            JSON.stringify(payloadValue)
          );
        } else {
          await callSessionRepository.updateSdpAnswer(
            info.familyId,
            callSessionId,
            JSON.stringify(payloadValue)
          );
        }
      } catch {
        // Persistence is best-effort for mid-call renegotiation.
      }

      const otherParticipant = callSession.participants.find(
        (participant: string) => participant !== info.identityId
      ) as IdentityId | undefined;
      if (!otherParticipant) return;
      const senderMetadata = await this.resolveSenderMetadata(info);
      const message: WebSocketMessage = {
        type: messageType,
        data: {
          callSessionId,
          [kind]: payloadValue,
          ...senderMetadata
        },
        timestamp: this.now()
      };
      const route = this.dependencies.callSessionRouting.get(callSessionId);
      const directPeerWs = this.dependencies.callSessionRouting.resolvePeerSocket(
        callSessionId,
        info.identityId
      );
      if (directPeerWs) {
        const targetToInitiator = info.identityId === route?.targetIdentityId;
        this.logger.debug('call_renegotiation_forwarded', {
          familyId: info.familyId,
          callSessionId,
          kind,
          direction: targetToInitiator ? 'target_to_initiator' : 'initiator_to_target',
          fromIdentityId: info.identityId,
          toIdentityId: targetToInitiator ? callSession.initiator : route?.targetIdentityId
        });
        this.dependencies.logCallDiag(`renegotiate_${kind}_forwarded`, {
          callSessionId,
          familyId: info.familyId,
          fromIdentityId: info.identityId,
          targetSocket: this.dependencies.describeSocket(directPeerWs)
        });
        this.dependencies.sendMessage(directPeerWs, message);
        return;
      }

      const otherSockets = this.dependencies.getIdentitySockets(
        info.familyId,
        otherParticipant
      );
      this.logger.warn('call_renegotiation_fallback_broadcast', {
        familyId: info.familyId,
        callSessionId,
        kind,
        fromIdentityId: info.identityId,
        toIdentityId: otherParticipant,
        socketCount: otherSockets?.size || 0
      });
      this.dependencies.sendToConnectionSet(otherSockets, message);
    } catch (error) {
      this.logger.error('call_renegotiation_failed', {
        callSessionId: data?.callSessionId,
        kind,
        error
      });
      this.dependencies.sendError(
        ws,
        'INTERNAL_ERROR',
        `Failed to handle renegotiation ${kind}`
      );
    }
  }

  private async resolveSenderMetadata(info: ConnectionInfo): Promise<{
    fromIdentityPublicKey?: { algorithm: string; value: string };
    fromIdentityName?: string;
  }> {
    if (info.actorType === 'external') {
      return {
        fromIdentityPublicKey: info.externalPublicKey,
        fromIdentityName: info.externalDisplayName
      };
    }
    const identity = await identityRepository.findByIdentityId(info.familyId, info.identityId);
    return {
      fromIdentityPublicKey: identity
        ? {
            algorithm: identity.public_key_algorithm,
            value: identity.public_key_value
          }
        : undefined,
      fromIdentityName: await this.dependencies.resolvePublishedIdentityName(
        info.familyId,
        identity
      )
    };
  }

}
function isTerminalCallState(state: string): boolean {
  return state === 'ended' || state === 'expired' || state === 'failed';
}
