import { nanoid } from 'nanoid';
import type { WebSocket } from 'ws';
import type { CallSessionId, WSCallVideoStateData } from '@shared/types';
import { serverLogger } from '../utils/logger';
import { CallOfferWsHandler } from './callOfferWsHandler';
import { CallAnswerWsHandler } from './callAnswerWsHandler';
import { CallPeerMediaWsHandlers } from './callPeerMediaWsHandlers';
import type {
  CallSignalingWsHandlerDependencies,
  CallSignalingWsHandlerRuntime
} from './callSignalingWsHandlerDependencies';

export type { CallSignalingWsHandlerDependencies } from './callSignalingWsHandlerDependencies';

export class CallSignalingWsHandlers {
  private readonly offerHandlers: CallOfferWsHandler;
  private readonly answerHandlers: CallAnswerWsHandler;
  private readonly peerMediaHandlers: CallPeerMediaWsHandlers;

  constructor(dependencies: CallSignalingWsHandlerDependencies) {
    const runtime: CallSignalingWsHandlerRuntime = {
      now: dependencies.now || Date.now,
      createCallSessionId: dependencies.createCallSessionId
        || (() => `call_${nanoid()}` as CallSessionId),
      logger: dependencies.logger || serverLogger.child({ subsystem: 'call_signaling' })
    };
    this.offerHandlers = new CallOfferWsHandler(dependencies, runtime);
    this.answerHandlers = new CallAnswerWsHandler(dependencies, runtime);
    this.peerMediaHandlers = new CallPeerMediaWsHandlers(dependencies, runtime);
  }

  handleOffer(ws: WebSocket, data: any): Promise<void> {
    return this.offerHandlers.handleOffer(ws, data);
  }

  handleAnswer(ws: WebSocket, data: any): Promise<void> {
    return this.answerHandlers.handleAnswer(ws, data);
  }

  handleRenegotiateOffer(ws: WebSocket, data: any): Promise<void> {
    return this.peerMediaHandlers.handleRenegotiateOffer(ws, data);
  }

  handleRenegotiateAnswer(ws: WebSocket, data: any): Promise<void> {
    return this.peerMediaHandlers.handleRenegotiateAnswer(ws, data);
  }

  handleIceCandidate(ws: WebSocket, data: any): Promise<void> {
    return this.peerMediaHandlers.handleIceCandidate(ws, data);
  }

  handleVideoState(ws: WebSocket, data: WSCallVideoStateData): Promise<void> {
    return this.peerMediaHandlers.handleVideoState(ws, data);
  }
}
