import type { WebSocket } from 'ws';
import type { CallSessionId, IdentityId } from '@shared/types';
import { callHistoryRepository, callSessionRepository, identityRepository } from '../db/repositories';
import { sendCallStatusPush } from '../utils/push';
import type { ConnectionInfo } from './wsConnectionContext';
import type {
  CallSignalingWsHandlerDependencies,
  CallSignalingWsHandlerRuntime
} from './callSignalingWsHandlerDependencies';

export class CallAnswerWsHandler {
  private readonly now: () => number;
  private readonly logger: CallSignalingWsHandlerRuntime['logger'];

  constructor(
    private readonly dependencies: CallSignalingWsHandlerDependencies,
    runtime: CallSignalingWsHandlerRuntime
  ) {
    this.now = runtime.now;
    this.logger = runtime.logger;
  }
  async handleAnswer(ws: WebSocket, data: any): Promise<void> {
    try {
      const info = this.dependencies.getConnectionInfo(ws);
      if (!info) {
        this.dependencies.sendError(ws, 'UNAUTHORIZED', 'Not authenticated');
        return;
      }
      const { familyId } = info;
      const { callSessionId, answer } = data;
      if (!callSessionId || !answer) {
        this.dependencies.sendError(
          ws,
          'VALIDATION_ERROR',
          'Missing callSessionId or answer'
        );
        return;
      }

      const callSession = await callSessionRepository.findByCallSessionId(familyId, callSessionId);
      if (!callSession) {
        this.logger.warn('call_answer_session_not_found', {
          familyId,
          identityId: info.identityId,
          callSessionId
        });
        this.dependencies.sendError(ws, 'CALL_NOT_FOUND', 'Call session not found');
        return;
      }

      const answerDelayMs = callSession.created_at?.getTime
        ? this.now() - callSession.created_at.getTime()
        : undefined;
      const route = this.dependencies.callSessionRouting.get(callSessionId);
      this.dependencies.logCallDiag('answer_received', {
        callSessionId,
        familyId,
        state: callSession.state,
        identityId: info.identityId,
        deviceId: info.deviceId,
        runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined,
        answerDelayMs,
        acceptedTargetSocket: route?.acceptedTargetWs
          ? this.dependencies.describeSocket(route.acceptedTargetWs)
          : undefined,
        initiatorSocket: route?.initiatorWs
          ? this.dependencies.describeSocket(route.initiatorWs)
          : undefined
      });

      if (!callSession.participants.includes(info.identityId)) {
        this.dependencies.sendError(ws, 'FORBIDDEN', 'Not a participant in this call');
        return;
      }
      if (callSession.initiator === info.identityId) {
        this.dependencies.logCallDiag('answer_rejected_initiator', {
          callSessionId,
          familyId,
          state: callSession.state,
          identityId: info.identityId,
          deviceId: info.deviceId
        });
        this.dependencies.sendError(
          ws,
          'FORBIDDEN',
          'Call initiator cannot answer their own call'
        );
        return;
      }
      if (
        info.actorType === 'local'
        && !await this.dependencies.validateTemporaryCallDelegation({
          info,
          peerIdentityId: callSession.initiator as IdentityId,
          callKeyDelegation: answer.callKeyDelegation
        })
      ) {
        this.dependencies.sendError(
          ws,
          'FORBIDDEN',
          'Temporary device is not allowed to answer this call'
        );
        return;
      }

      if (callSession.state === 'accepted' || callSession.state === 'active') {
        this.dependencies.logCallDiag('answer_rejected_answered_elsewhere', {
          callSessionId,
          familyId,
          state: callSession.state,
          identityId: info.identityId,
          deviceId: info.deviceId,
          runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined
        });
        this.dependencies.sendMessage(ws, {
          type: 'call:ended',
          data: {
            callSessionId,
            reason: 'answered_elsewhere',
            acceptedDeviceId: this.dependencies.callSessionRouting.get(callSessionId)
              ?.acceptedTargetDeviceId
          },
          timestamp: this.now()
        });
        return;
      }
      if (callSession.state !== 'new' && callSession.state !== 'ringing') {
        this.dependencies.logCallDiag('answer_rejected_invalid_state', {
          callSessionId,
          familyId,
          state: callSession.state,
          identityId: info.identityId,
          deviceId: info.deviceId,
          runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined
        });
        this.dependencies.sendMessage(ws, {
          type: 'call:ended',
          data: { callSessionId, reason: callSession.state },
          timestamp: this.now()
        });
        return;
      }

      await callSessionRepository.updateState(familyId, callSessionId, 'accepted');
      await callHistoryRepository.markAccepted({
        familyId,
        callSessionId,
        connectedAt: this.now()
      });
      this.dependencies.callRingingService.stop(callSessionId);

      const targetBinding = this.dependencies.callSessionRouting.bindAcceptedTargetIfAbsent({
        callSessionId,
        identityId: info.identityId,
        ws,
        deviceId: info.actorType === 'local' ? info.deviceId : undefined
      });
      if (targetBinding.status === 'bound' && targetBinding.route) {
        this.dependencies.logCallDiag('answer_accepted_socket_bound', {
          callSessionId,
          familyId,
          state: 'accepted',
          identityId: info.identityId,
          deviceId: info.deviceId,
          runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined,
          acceptedTargetSocket: this.dependencies.describeSocket(ws),
          initiatorSocket: this.dependencies.describeSocket(targetBinding.route.initiatorWs)
        });
      } else if (
        targetBinding.status === 'already_bound'
        && targetBinding.route?.acceptedTargetWs
      ) {
        this.dependencies.logCallDiag('answer_accepting_socket_already_bound', {
          callSessionId,
          familyId,
          state: 'accepted',
          identityId: info.identityId,
          deviceId: info.deviceId,
          runtimeMode: info.actorType === 'local' ? info.runtimeMode || 'default' : undefined,
          acceptedTargetSocket: this.dependencies.describeSocket(
            targetBinding.route.acceptedTargetWs
          ),
          answerSocket: this.dependencies.describeSocket(ws)
        });
      }

      this.stopRingingOnOtherSockets(ws, info, callSessionId);
      void this.stopRingingPush(info, callSessionId, callSession.initiator as IdentityId);
      this.dependencies.replayStoredIceCandidates({
        ws,
        callSessionId,
        callSession,
        fromIdentityId: callSession.initiator as IdentityId
      });
      await this.forwardAnswerToInitiator(info, callSessionId, answer);

      this.logger.info('call_answered', {
        familyId,
        callSessionId,
        identityId: info.identityId,
        answerDelayMs
      });
    } catch (error) {
      this.logger.error('call_answer_failed', { error });
      this.dependencies.sendError(ws, 'INTERNAL_ERROR', 'Failed to answer call');
    }
  }

  private stopRingingOnOtherSockets(
    ws: WebSocket,
    info: ConnectionInfo,
    callSessionId: CallSessionId
  ): void {
    const targetSockets = this.dependencies.getGeneralIdentitySockets(info.familyId, info.identityId);
    if (!targetSockets) return;
    for (const otherWs of targetSockets) {
      if (otherWs === ws) continue;
      const otherInfo = this.dependencies.getConnectionInfo(otherWs);
      if (otherInfo?.actorType === 'local' && otherInfo.deviceId === info.deviceId) {
        this.dependencies.logCallDiag('answer_skip_answered_elsewhere_same_device', {
          callSessionId,
          familyId: info.familyId,
          acceptedDeviceId: info.deviceId,
          skippedSocket: this.dependencies.describeSocket(otherWs)
        });
        continue;
      }
      this.dependencies.logCallDiag('answer_send_answered_elsewhere', {
        callSessionId,
        familyId: info.familyId,
        acceptedDeviceId: info.deviceId,
        targetSocket: this.dependencies.describeSocket(otherWs)
      });
      this.dependencies.sendMessage(otherWs, {
        type: 'call:ended',
        data: {
          callSessionId,
          reason: 'answered_elsewhere',
          acceptedDeviceId: info.actorType === 'local' ? info.deviceId : undefined
        },
        timestamp: this.now()
      });
    }
  }

  private async stopRingingPush(
    info: ConnectionInfo,
    callSessionId: CallSessionId,
    initiatorIdentityId: IdentityId
  ): Promise<void> {
    try {
      const initiator = await identityRepository.findByIdentityId(
        info.familyId,
        initiatorIdentityId
      );
      const initiatorName = await this.dependencies.resolvePublishedIdentityName(
        info.familyId,
        initiator
      );
      await sendCallStatusPush(info.familyId, info.identityId, {
        callSessionId,
        callStatus: 'answered_elsewhere',
        callEndReason: 'answered_elsewhere',
        fromIdentityId: initiatorIdentityId,
        fromIdentityName: initiatorName,
        excludeDeviceIds: info.actorType === 'local' ? [info.deviceId] : undefined
      });
    } catch (error) {
      this.logger.warn('call_answer_status_push_failed', {
        familyId: info.familyId,
        callSessionId,
        identityId: info.identityId,
        error
      });
    }
  }

  private async forwardAnswerToInitiator(
    info: ConnectionInfo,
    callSessionId: CallSessionId,
    answer: any
  ): Promise<void> {
    const initiatorWs = this.dependencies.callSessionRouting.get(callSessionId)?.initiatorWs;
    if (!initiatorWs) return;
    this.dependencies.logCallDiag('answer_forward_to_initiator', {
      callSessionId,
      familyId: info.familyId,
      fromIdentityId: info.identityId,
      fromDeviceId: info.deviceId,
      initiatorSocket: this.dependencies.describeSocket(initiatorWs)
    });
    const fromIdentity = await identityRepository.findByIdentityId(
      info.familyId,
      info.identityId
    );
    const fromIdentityPublicKey = fromIdentity
      ? {
          algorithm: fromIdentity.public_key_algorithm,
          value: fromIdentity.public_key_value
        }
      : undefined;
    const fromIdentityName = await this.dependencies.resolvePublishedIdentityName(
      info.familyId,
      fromIdentity
    );
    this.dependencies.sendMessage(initiatorWs, {
      type: 'call:answered',
      data: {
        callSessionId,
        fromIdentityId: info.identityId,
        fromIdentityPublicKey,
        fromIdentityName,
        answer
      },
      timestamp: this.now()
    });
  }
}
