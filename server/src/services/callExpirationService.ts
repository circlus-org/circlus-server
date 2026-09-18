import type { WebSocket } from 'ws';
import type { CallSessionId, IdentityId, WebSocketMessage } from '@shared/types';
import {
  callHistoryRepository,
  callSessionRepository,
  identityRepository,
  systemEventRepository
} from '../db/repositories';
import { sendCallStatusPush } from '../utils/push';
import { configService } from './configService';
import { stableMissedCallEventId } from './callTerminationService';
import { persistAndClearCallIceStats } from '../ws/callIceDiagnostics';
import type { CallRingingParams, RingingCallSession } from './callRingingService';
import { getRequestLogger } from '../middleware/requestContext';
import type { Logger } from '../utils/logger';

export type CallExpirationDependencies = {
  getInitiatorSocket: (callSessionId: CallSessionId) => WebSocket | undefined;
  getTargetSockets: (
    familyId: string,
    targetIdentityId: IdentityId
  ) => Set<WebSocket> | undefined;
  sendMessage: (ws: WebSocket, message: WebSocketMessage) => void;
  sendToConnectionSet: (
    sockets: Set<WebSocket> | undefined,
    message: WebSocketMessage
  ) => void;
  resolvePublishedIdentityName: (
    familyId: string,
    identity: any | null
  ) => Promise<string | undefined>;
  removeRoute: (callSessionId: CallSessionId) => void;
  logger?: Logger;
  now?: () => number;
};

export class CallExpirationService {
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly dependencies: CallExpirationDependencies) {
    this.now = dependencies.now || Date.now;
    this.logger = dependencies.logger || getRequestLogger({ subsystem: 'call_expiration' });
  }

  async expire(
    params: CallRingingParams & { callSession: RingingCallSession }
  ): Promise<void> {
    await callSessionRepository.updateState(
      params.familyId,
      params.callSessionId,
      'expired'
    );
    await this.replaceIncomingPushWithMissedStatus(params);

    const endedMessage: WebSocketMessage = {
      type: 'call:ended',
      data: { callSessionId: params.callSessionId, reason: 'timeout' },
      timestamp: this.now()
    };
    const initiatorWs = this.dependencies.getInitiatorSocket(params.callSessionId);
    if (initiatorWs) this.dependencies.sendMessage(initiatorWs, endedMessage);
    this.dependencies.sendToConnectionSet(
      this.dependencies.getTargetSockets(params.familyId, params.targetIdentityId),
      endedMessage
    );

    const familyConfig = await configService.requireFamilyConfig(params.familyId);
    const circleId = familyConfig.circle_id;
    await systemEventRepository.insertEvent({
      eventId: stableMissedCallEventId(
        params.familyId,
        params.callSessionId,
        params.targetIdentityId
      ),
      familyId: params.familyId,
      recipientIdentityId: params.targetIdentityId,
      circleId,
      type: 'call:missed',
      payload: {
        callSessionId: params.callSessionId,
        remoteIdentityId: params.initiatorIdentityId,
        direction: 'incoming',
        reason: 'timeout',
        isTemporaryLinkCall: params.isTemporaryLinkCall === true,
        callLinkTitle: params.callLinkTitle,
        callCreatedAt: params.callSession.created_at?.getTime?.()
          ? params.callSession.created_at.getTime()
          : undefined
      },
      createdAt: this.now()
    });
    await callHistoryRepository.markMissed({
      familyId: params.familyId,
      callSessionId: params.callSessionId,
      reason: 'timeout'
    });

    this.dependencies.removeRoute(params.callSessionId);
    await persistAndClearCallIceStats({
      familyId: params.familyId,
      callSessionId: params.callSessionId
    });
  }

  private async replaceIncomingPushWithMissedStatus(
    params: CallRingingParams
  ): Promise<void> {
    try {
      const fromIdentity = await identityRepository.findByIdentityId(
        params.familyId,
        params.initiatorIdentityId
      );
      const fromIdentityName = await this.dependencies.resolvePublishedIdentityName(
        params.familyId,
        fromIdentity
      );
      await sendCallStatusPush(params.familyId, params.targetIdentityId, {
        callSessionId: params.callSessionId,
        callStatus: 'missed',
        callEndReason: 'timeout',
        fromIdentityId: params.initiatorIdentityId,
        fromIdentityName: params.isTemporaryLinkCall ? undefined : fromIdentityName,
        isTemporaryLinkCall: params.isTemporaryLinkCall,
        callLinkTitle: params.callLinkTitle
      });
    } catch (error) {
      this.logger.warn('call_expiration_status_push_failed', {
        familyId: params.familyId,
        callSessionId: params.callSessionId,
        targetIdentityId: params.targetIdentityId,
        error
      });
    }
  }
}
