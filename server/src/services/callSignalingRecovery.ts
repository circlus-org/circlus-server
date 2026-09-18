import type { WebSocket } from 'ws';
import type { WebSocketMessage } from '@shared/types';
import type { ConnectionInfo } from '../ws/wsConnectionContext';
import { CallSessionRoutingRegistry, type CallSessionRoute, type DetachedCallRoute } from './callSessionRoutingRegistry';

type Pending = DetachedCallRoute & {
  ws: WebSocket;
  info: ConnectionInfo;
  timer: ReturnType<typeof setTimeout>;
  messages: WebSocketMessage[];
  bytes: number;
};

export type CallSignalingRecoveryEndReason = 'signaling_disconnected' | 'superseded_by_redial';

/** Retain the exact call endpoints while an authenticated participant reconnects.
 * Registration alone is not proof of resuming: require traffic for the old call.
 */
export class CallSignalingRecovery {
  private readonly pending = new Set<Pending>();

  constructor(private readonly dependencies: {
    routes: CallSessionRoutingRegistry;
    send: (ws: WebSocket, message: WebSocketMessage) => void;
    expire: (
      callSessionId: string,
      route: CallSessionRoute,
      reason: CallSignalingRecoveryEndReason
    ) => Promise<void>;
    log: (event: string, details: Record<string, unknown>) => void;
    graceMs: number;
  }) {}

  closed(ws: WebSocket, info: ConnectionInfo): void {
    for (const detached of this.dependencies.routes.routesForSocket(ws)) {
      if ([...this.pending].some(p => p.ws === ws && p.callSessionId === detached.callSessionId)) continue;
      const pending: Pending = { ...detached, ws, info, messages: [], bytes: 0,
        timer: setTimeout(() => this.expire(pending), this.dependencies.graceMs) };
      pending.timer.unref?.();
      this.pending.add(pending);
      this.dependencies.log('call_signaling_disconnected', {
        callSessionId: pending.callSessionId, familyId: info.familyId, role: pending.role,
        graceMs: this.dependencies.graceMs
      });
    }
  }

  buffer(ws: WebSocket, message: WebSocketMessage): boolean {
    const callSessionId = message.data?.callSessionId;
    const pending = [...this.pending].find(p => p.ws === ws && p.callSessionId === callSessionId);
    if (!pending || !this.isCurrent(pending)) return false;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    // Never let a disconnected peer grow an unbounded signaling queue.
    if (pending.messages.length >= 128 || pending.bytes + bytes > 512 * 1024) {
      this.expire(pending);
      return true;
    }
    pending.messages.push(message);
    pending.bytes += bytes;
    return true;
  }

  resume(ws: WebSocket, info: ConnectionInfo, callSessionId: string): boolean {
    if (info.actorType === 'local' && (
      info.runtimeMode === 'direct-file-native'
      || (info.scopedCallSessionId && info.scopedCallSessionId !== callSessionId)
    )) return false;
    const pending = [...this.pending].find(p => p.callSessionId === callSessionId
      && p.info.familyId === info.familyId && p.info.identityId === info.identityId
      && p.info.deviceId === info.deviceId && p.info.actorType === info.actorType);
    if (!pending || ws.readyState !== 1) return false;
    const route = this.dependencies.routes.get(callSessionId);
    const currentWs = pending.role === 'initiator' ? route?.initiatorWs : route?.acceptedTargetWs;
    // Native registration can bind its scoped runtime before replay runs.
    if (currentWs !== pending.ws && currentWs !== ws) return false;
    if (info.actorType === 'external' && pending.info.actorType === 'external') {
      const previous = pending.info;
      if (previous.externalPublicKey.value !== info.externalPublicKey.value
        || previous.externalPublicKey.algorithm !== info.externalPublicKey.algorithm
        || previous.callGrant?.kind !== info.callGrant?.kind
        || previous.callGrant?.admissionId !== info.callGrant?.admissionId
        || previous.callGrant?.targetIdentityId !== info.callGrant?.targetIdentityId) return false;
    }
    const bind = pending.role === 'initiator' ? 'bindInitiatorRuntime' : 'bindTargetRuntime';
    this.dependencies.routes[bind]({ callSessionId, identityId: info.identityId, ws, deviceId: info.deviceId });
    this.clear(pending);
    for (const message of pending.messages) this.dependencies.send(ws, message);
    this.dependencies.log('call_signaling_resumed', {
      callSessionId, familyId: info.familyId, role: pending.role, replayedMessages: pending.messages.length
    });
    return true;
  }

  /**
   * Replace only a detached call from the exact same external caller. A shared
   * call-link capability is not enough: another browser using the same link has
   * a different public key and must never be able to interrupt this call.
   */
  async supersedeDisconnectedExternalCall(params: {
    ws: WebSocket;
    info: ConnectionInfo;
    previousCallSessionId: string;
    nextCallSessionId: string;
    targetIdentityId: string;
  }): Promise<boolean> {
    const { info } = params;
    if (info.actorType !== 'external' || info.callGrant?.kind !== 'call_link') return false;
    if (!params.previousCallSessionId || params.previousCallSessionId === params.nextCallSessionId) return false;
    const capabilityId = info.callGrant.capabilityGrant?.descriptor.payload.capabilityId;
    if (!capabilityId) return false;

    const pending = [...this.pending].find(candidate => (
      candidate.callSessionId === params.previousCallSessionId
      && candidate.role === 'initiator'
      && candidate.info.actorType === 'external'
      && candidate.route.familyId === info.familyId
      && candidate.route.initiatorIdentityId === info.identityId
      && candidate.route.targetIdentityId === params.targetIdentityId
      && candidate.info.familyId === info.familyId
      && candidate.info.identityId === info.identityId
      && candidate.info.deviceId === info.deviceId
      && candidate.info.externalPublicKey.algorithm === info.externalPublicKey.algorithm
      && candidate.info.externalPublicKey.value === info.externalPublicKey.value
      && candidate.info.callGrant?.kind === 'call_link'
      && candidate.info.callGrant.admissionId === info.callGrant?.admissionId
      && candidate.info.callGrant.targetIdentityId === params.targetIdentityId
      && candidate.info.callGrant.capabilityGrant?.descriptor.payload.capabilityId === capabilityId
      && info.callGrant?.targetIdentityId === params.targetIdentityId
    ));
    if (!pending || !this.isCurrent(pending) || params.ws.readyState !== 1) return false;

    this.clear(pending);
    const route = this.dependencies.routes.remove(pending.callSessionId);
    if (!route) return false;
    for (const other of [...this.pending]) {
      if (other.callSessionId === pending.callSessionId) this.clear(other);
    }
    this.dependencies.log('call_signaling_superseded_by_redial', {
      callSessionId: pending.callSessionId,
      nextCallSessionId: params.nextCallSessionId,
      familyId: route.familyId,
      initiatorIdentityId: route.initiatorIdentityId,
      targetIdentityId: route.targetIdentityId
    });
    // The termination handler notifies the live peer synchronously before its
    // first await. Do not delay the replacement offer on database/push cleanup.
    void this.dependencies.expire(pending.callSessionId, route, 'superseded_by_redial').catch(error => {
      this.dependencies.log('call_signaling_supersede_cleanup_failed', {
        callSessionId: pending.callSessionId,
        nextCallSessionId: params.nextCallSessionId,
        familyId: route.familyId,
        error
      });
    });
    return true;
  }

  private isCurrent(pending: Pending): boolean {
    const route = this.dependencies.routes.get(pending.callSessionId);
    return (pending.role === 'initiator' ? route?.initiatorWs : route?.acceptedTargetWs) === pending.ws;
  }

  private clear(pending: Pending): void {
    clearTimeout(pending.timer);
    this.pending.delete(pending);
  }

  private expire(pending: Pending): void {
    this.clear(pending);
    if (!this.isCurrent(pending)) return;
    const route = this.dependencies.routes.remove(pending.callSessionId)!;
    for (const other of this.pending) {
      if (other.callSessionId === pending.callSessionId) this.clear(other);
    }
    this.dependencies.log('call_signaling_recovery_expired', {
      callSessionId: pending.callSessionId, familyId: route.familyId, role: pending.role
    });
    void this.dependencies.expire(pending.callSessionId, route, 'signaling_disconnected').catch(error => {
      this.dependencies.log('call_signaling_recovery_cleanup_failed', {
        callSessionId: pending.callSessionId, familyId: route.familyId, error
      });
    });
  }
}
