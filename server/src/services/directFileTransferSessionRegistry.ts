import type { WebSocket } from 'ws';
import type {
  DeviceId,
  DirectFileTransferSessionId,
  IdentityId,
  WSDirectFileTransferIceCandidateData,
  WSDirectFileTransferIncomingData
} from '@shared/types';

export type DirectFileTransferSession = Readonly<{
  familyId: string;
  initiatorIdentityId: IdentityId;
  initiatorWs: WebSocket;
  targetIdentityId: IdentityId;
  targetDeviceId?: DeviceId;
  targetDeviceIds?: DeviceId[];
  targetWs?: WebSocket;
  incomingData: WSDirectFileTransferIncomingData;
  incomingDataByDevice?: Record<string, WSDirectFileTransferIncomingData>;
  expiresAt: number;
}>;

type MutableDirectFileTransferSession = {
  -readonly [Key in keyof DirectFileTransferSession]: DirectFileTransferSession[Key];
} & {
  pendingInitiatorCandidates: WSDirectFileTransferIceCandidateData[];
  pendingTargetCandidates: Map<WebSocket, WSDirectFileTransferIceCandidateData[]>;
};

export type DirectFileTransferSessionRegistryConfig = {
  maxPendingInitiatorCandidates?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  onExpire?: (session: DirectFileTransferSession) => void;
};

function snapshot(session: MutableDirectFileTransferSession): DirectFileTransferSession {
  return {
    familyId: session.familyId,
    initiatorIdentityId: session.initiatorIdentityId,
    initiatorWs: session.initiatorWs,
    targetIdentityId: session.targetIdentityId,
    targetDeviceId: session.targetDeviceId,
    targetDeviceIds: session.targetDeviceIds,
    targetWs: session.targetWs,
    incomingData: session.incomingData,
    incomingDataByDevice: session.incomingDataByDevice,
    expiresAt: session.expiresAt
  };
}

export class DirectFileTransferSessionRegistry {
  hasIdentity(familyId: string, identityId: string): boolean {
    return [...this.sessions.values()].some(session => session.familyId === familyId && (session.initiatorIdentityId === identityId || session.targetIdentityId === identityId));
  }

  hasSocket(ws: WebSocket): boolean {
    return [...this.sessions.values()].some(session => session.initiatorWs === ws || session.targetWs === ws);
  }

  private readonly sessions = new Map<DirectFileTransferSessionId, MutableDirectFileTransferSession>();
  private readonly expiryTimers = new Map<DirectFileTransferSessionId, NodeJS.Timeout>();
  private readonly maxPendingInitiatorCandidates: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly onExpire?: (session: DirectFileTransferSession) => void;

  constructor(config: DirectFileTransferSessionRegistryConfig = {}) {
    this.maxPendingInitiatorCandidates = Math.max(1, config.maxPendingInitiatorCandidates || 256);
    this.now = config.now || Date.now;
    this.setTimer = config.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = config.clearTimer || clearTimeout;
    this.onExpire = config.onExpire;
  }

  register(params: DirectFileTransferSession): boolean {
    if (this.sessions.has(params.incomingData.sessionId)) return false;
    const sessionId = params.incomingData.sessionId;
    this.sessions.set(sessionId, {
      ...params,
      pendingInitiatorCandidates: [],
      pendingTargetCandidates: new Map()
    });
    const timer = this.setTimer(() => {
      const current = this.sessions.get(sessionId);
      if (current && current.expiresAt <= this.now()) {
        const expired = this.remove(sessionId);
        if (expired) this.onExpire?.(expired);
      }
    }, Math.max(1, params.expiresAt - this.now()));
    timer.unref?.();
    this.expiryTimers.set(sessionId, timer);
    return true;
  }

  get(sessionId: DirectFileTransferSessionId): DirectFileTransferSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      const expired = this.remove(sessionId);
      if (expired) this.onExpire?.(expired);
      return undefined;
    }
    return snapshot(session);
  }

  bindTarget(
    sessionId: DirectFileTransferSessionId,
    targetWs: WebSocket
  ): DirectFileTransferSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= this.now()) {
      if (session) this.remove(sessionId);
      return undefined;
    }
    session.targetWs = targetWs;
    return snapshot(session);
  }

  bufferInitiatorCandidate(
    sessionId: DirectFileTransferSessionId,
    candidate: WSDirectFileTransferIceCandidateData
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.pendingInitiatorCandidates.length >= this.maxPendingInitiatorCandidates) {
      return false;
    }
    session.pendingInitiatorCandidates.push(candidate);
    return true;
  }

  drainInitiatorCandidates(
    sessionId: DirectFileTransferSessionId
  ): WSDirectFileTransferIceCandidateData[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const pending = session.pendingInitiatorCandidates;
    session.pendingInitiatorCandidates = [];
    return pending;
  }

  bufferTargetCandidate(
    sessionId: DirectFileTransferSessionId,
    targetWs: WebSocket,
    candidate: WSDirectFileTransferIceCandidateData
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const pending = session.pendingTargetCandidates.get(targetWs) || [];
    if (pending.length >= this.maxPendingInitiatorCandidates) return false;
    pending.push(candidate);
    session.pendingTargetCandidates.set(targetWs, pending);
    return true;
  }

  drainTargetCandidates(
    sessionId: DirectFileTransferSessionId,
    targetWs: WebSocket
  ): WSDirectFileTransferIceCandidateData[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const pending = session.pendingTargetCandidates.get(targetWs) || [];
    session.pendingTargetCandidates.clear();
    return pending;
  }

  remove(sessionId: DirectFileTransferSessionId): DirectFileTransferSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.sessions.delete(sessionId);
    const timer = this.expiryTimers.get(sessionId);
    if (timer) this.clearTimer(timer);
    this.expiryTimers.delete(sessionId);
    return snapshot(session);
  }

  detachSocket(ws: WebSocket): Array<{
    sessionId: DirectFileTransferSessionId;
    role: 'initiator' | 'target';
    session: DirectFileTransferSession;
  }> {
    const detached: Array<{
      sessionId: DirectFileTransferSessionId;
      role: 'initiator' | 'target';
      session: DirectFileTransferSession;
    }> = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.initiatorWs === ws) {
        const removed = this.remove(sessionId);
        if (removed) detached.push({ sessionId, role: 'initiator', session: removed });
        continue;
      }
      if (session.targetWs === ws) {
        const previous = snapshot(session);
        delete session.targetWs;
        detached.push({ sessionId, role: 'target', session: previous });
      }
    }
    return detached;
  }
}
