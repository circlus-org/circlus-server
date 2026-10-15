import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { WebSocketMessage } from '@shared/types';
import { canonicalizeJson } from '../../../shared/signatureMessage';
import { callSdpEffects } from './callSdpEffects';
import type { CallRuntimeRecoveryStore } from './callRuntimeRecoveryStore';
import type { CallSessionRoute } from './callSessionRoutingRegistry';
import type { ConnectionInfo, LocalConnectionInfo } from '../ws/wsConnectionContext';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commands = new Set(['call:offer', 'call:answer', 'call:renegotiate-offer', 'call:renegotiate-answer']);
const descriptions = new Set(['call:answered', 'call:renegotiate-offer', 'call:renegotiate-answer']);
type Operation = { digest: string; done: Promise<void>; replies: WebSocketMessage[]; committed: boolean };
type Mail = { destination: string; message: WebSocketMessage; bytes: number };
type Call = { operations: Map<string, Operation>; mail: Map<string, Mail>; closedAt?: number; recipients?: string[] };
type Context = { ws: WebSocket; operation: Operation };
type Dependencies = {
  info: (ws: WebSocket) => ConnectionInfo | undefined;
  send: (ws: WebSocket, message: WebSocketMessage) => void;
  authorize: (ws: WebSocket, info: LocalConnectionInfo, callId: string, type: string) => Promise<boolean>;
  current?: (ws: WebSocket, info: LocalConnectionInfo, callId: string) => boolean;
  diagnostic: (data: { operation: string; reason: string; missingFields?: string[] }) => void;
  store?: CallRuntimeRecoveryStore;
  route?: (callId: string) => CallSessionRoute | undefined;
  invalidateRoute?: (callId: string) => void;
  now?: () => number;
};

/** SDP recovery v1 is bounded. Production persists its outcomes and outbox in
 * the same transaction as call state. Receipts mean admission, not SDK application;
 * the selected recipient ACKs a separate delivery only after applying its SDP. */
export class CallSdpRecovery {
  private readonly calls = new Map<string, Call>();
  private readonly context = new AsyncLocalStorage<Context>();
  private bytes = 0;
  private readonly pendingSends = new AsyncLocalStorage<Array<() => void>>();
  deferSend(send: () => void): boolean {
    const sends = this.pendingSends.getStore();
    if (!sends) return false;
    sends.push(send); return true;
  }
  private emit(ws: WebSocket, message: WebSocketMessage): void {
    if (!this.deferSend(() => this.deps.send(ws, message))) this.deps.send(ws, message);
  }
  private serialize(call: Call) {
    return { version: 1, operations: [...call.operations].map(([key, op]) => [key, { digest: op.digest, replies: op.replies, committed: op.committed }]),
      mail: [...call.mail], recipients: call.recipients || [], ...(call.closedAt !== undefined ? { closedAt: call.closedAt } : {}) };
  }
  private async load(info: ConnectionInfo, callId: string): Promise<void> {
    const key = this.key(info, callId), old = this.calls.get(key);
    if (old) { for (const mail of old.mail.values()) this.bytes -= mail.bytes; this.calls.delete(key); }
    const record = await this.deps.store!.load(info.familyId, callId);
    if (!record) return;
    const data = record.journal as any;
    if (data?.version !== 1 || !Array.isArray(data.operations) || !Array.isArray(data.mail)
        || data.operations.length > 256 || data.mail.length > 32 || !Array.isArray(data.recipients)) throw new Error('CALL_SDP_JOURNAL_INVALID');
    const call: Call = { operations: new Map(data.operations.map(([id, op]: [string, Operation]) => [id, { ...op, done: Promise.resolve() }])),
      mail: new Map(data.mail), recipients: data.recipients, closedAt: data.closedAt };
    for (const mail of call.mail.values()) this.bytes += mail.bytes;
    this.calls.set(key, call);
  }
  private async durable(info: ConnectionInfo, callId: string, work: () => Promise<void>): Promise<void> {
    if (!this.deps.store) { await work(); return; }
    const sends: Array<() => void> = [], effects: Array<() => Promise<void>> = [];
    try {
      await this.deps.store.locked(info.familyId, callId, async () => {
        await this.load(info, callId);
        await this.pendingSends.run(sends, () => callSdpEffects.run(effects, work));
        const call = this.calls.get(this.key(info, callId)), route = this.deps.route?.(callId);
        if (call && route) await this.deps.store!.save(info.familyId, callId, { route, journal: this.serialize(call) });
      });
    } catch (error) {
      const call = this.calls.get(this.key(info, callId));
      if (call) for (const mail of call.mail.values()) this.bytes -= mail.bytes;
      this.calls.delete(this.key(info, callId)); this.deps.invalidateRoute?.(callId);
      throw error; // Nothing is sent before COMMIT; reconnect reloads committed authority.
    }
    for (const send of sends) send();
    for (const effect of effects) void effect().catch(() => this.deps.diagnostic({ operation: 'call.sdpEffect', reason: 'CALL_SDP_EFFECT_FAILED' }));
  }
  /** Address a selected native peer even when it has not reconnected yet. */
  deliverPeer(info: ConnectionInfo, message: WebSocketMessage): boolean {
    if (!this.deps.store || !this.pendingSends.getStore() || info.actorType !== 'local') return false;
    const callId = message.data?.callSessionId, route = this.deps.route?.(callId);
    const call = this.calls.get(this.key(info, callId));
    if (!route || !call || route.familyId !== info.familyId) return false;
    const caller = info.identityId === route.initiatorIdentityId;
    const destination = JSON.stringify(caller
      ? [route.targetIdentityId, route.acceptedTargetDeviceId, route.initiatorIdentityId, 'callee']
      : [route.initiatorIdentityId, route.initiatorDeviceId, route.targetIdentityId, 'caller']);
    if (!call.recipients?.includes(destination)) return false;
    const decorated = this.mail(call, destination, message);
    const peer = caller ? route.acceptedTargetWs : route.initiatorWs;
    if (peer) this.emit(peer, decorated);
    return true;
  }
  hasDurablePeer(info: ConnectionInfo, callId: string): boolean {
    if (!this.deps.store || info.actorType !== 'local') return false;
    const route = this.deps.route?.(callId), call = this.calls.get(this.key(info, callId));
    if (!route || !call) return false;
    const caller = info.identityId === route.initiatorIdentityId;
    return !!call.recipients?.includes(JSON.stringify(caller
      ? [route.targetIdentityId, route.acceptedTargetDeviceId, route.initiatorIdentityId, 'callee']
      : [route.initiatorIdentityId, route.initiatorDeviceId, route.targetIdentityId, 'caller']));
  }
  private readonly deliveryScopes = new WeakMap<WebSocket, LocalConnectionInfo>();
  remember(ws: WebSocket, info: ConnectionInfo): void {
    if (info.actorType === 'local' && info.sdpRecoveryVersion === 1) this.deliveryScopes.set(ws, info);
    else this.deliveryScopes.delete(ws);
  }
  constructor(private readonly deps: Dependencies) {}
  private isCurrent(ws: WebSocket, info: LocalConnectionInfo, callId: string): boolean {
    return this.deps.info(ws) === info && (!this.deps.current || this.deps.current(ws, info, callId));
  }
  private now() { return (this.deps.now || Date.now)(); }
  private key(info: ConnectionInfo, callId: string) { return JSON.stringify([info.familyId, callId]); }
  private destination(info: LocalConnectionInfo) { return JSON.stringify([info.identityId, info.deviceId, info.scopedRemoteIdentityId, info.callRuntimeRole]); }
  private state(info: ConnectionInfo, callId: string): Call {
    for (const [key, call] of this.calls) if (call.closedAt !== undefined && this.now() - call.closedAt > 120_000) {
      for (const mail of call.mail.values()) this.bytes -= mail.bytes;
      this.calls.delete(key);
    }
    const key = this.key(info, callId);
    let state = this.calls.get(key);
    if (!state) {
      if (this.calls.size >= 512) throw new Error('CALL_SDP_CAPACITY');
      state = { operations: new Map(), mail: new Map() }; this.calls.set(key, state);
    }
    return state;
  }
  private reject(ws: WebSocket, reason: string, missingFields?: string[]) {
    this.deps.diagnostic({ operation: 'call.sdpRecovery', reason, ...(missingFields ? { missingFields } : {}) });
    this.emit(ws, { type: 'error', data: { code: 'FORBIDDEN', message: reason }, timestamp: this.now() });
  }
  async execute(ws: WebSocket, info: ConnectionInfo, message: WebSocketMessage, dispatch: () => Promise<unknown>): Promise<void> {
    if (!commands.has(message.type)) { await dispatch(); return; }
    if (info.actorType !== 'local' || info.sdpRecoveryVersion !== 1) {
      if (this.deps.store && await this.deps.store.load(info.familyId, message.data?.callSessionId)) {
        await this.durable(info, message.data.callSessionId, async () => { await dispatch(); });
      } else await dispatch();
      return;
    }
    try { await this.durable(info, message.data?.callSessionId, () => this.executeInner(ws, info, message, dispatch)); }
    catch { this.reject(ws, 'CALL_SDP_DURABILITY_FAILED'); }
  }
  private async executeInner(ws: WebSocket, info: ConnectionInfo, message: WebSocketMessage, dispatch: () => Promise<unknown>): Promise<void> {
    if (info.actorType !== 'local' || info.sdpRecoveryVersion !== 1 || !commands.has(message.type)) { await dispatch(); return; }
    this.remember(ws, info);
    const data = message.data as any;
    if (data?.sdpRecoveryVersion !== 1 || typeof data.sdpOperationId !== 'string' || !uuid.test(data.sdpOperationId)) {
      this.reject(ws, 'CALL_SDP_OPERATION_REQUIRED', ['sdpRecoveryVersion', 'sdpOperationId']); return;
    }
    if (!await this.deps.authorize(ws, info, data.callSessionId, message.type)) return;
    if (!this.isCurrent(ws, info, data.callSessionId)) { this.reject(ws, 'CALL_SDP_AUTHORITY_CHANGED'); return; }
    const call = this.state(info, data.callSessionId);
    call.recipients ||= [];
    if (!call.recipients.includes(this.destination(info))) call.recipients.push(this.destination(info));
    if (call.closedAt !== undefined) { this.reject(ws, 'CALL_SDP_CLOSED'); return; }
    const key = JSON.stringify([this.destination(info), data.sdpOperationId.toLowerCase()]);
    const digest = createHash('sha256').update(canonicalizeJson({ type: message.type, data: { ...data, sdpOperationId: data.sdpOperationId.toLowerCase() } })).digest('hex');
    let operation = call.operations.get(key);
    if (operation) {
      if (operation.digest !== digest) { this.reject(ws, 'CALL_SDP_OPERATION_CONFLICT'); return; }
      await operation.done;
    } else {
      if (call.operations.size >= 256) { this.reject(ws, 'CALL_SDP_OPERATION_LIMIT'); return; }
      let finish!: () => void;
      operation = { digest, done: new Promise<void>(resolve => { finish = resolve; }), replies: [], committed: false };
      call.operations.set(key, operation);
      try {
        await this.context.run({ ws, operation }, dispatch);
        operation.committed = !operation.replies.some(reply => reply.type === 'error');
      } catch {
        operation.replies.push({ type: 'error', data: { code: 'INTERNAL_ERROR', message: 'CALL_SDP_PROCESSING_FAILED' }, timestamp: this.now() });
      } finally { finish(); }
      if (this.deps.store && !operation.committed) throw new Error('CALL_SDP_TRANSACTION_REJECTED');
    }
    // Re-authorize after async work: a replacement may have taken this endpoint.
    // The stored outcome survives so its exact selected successor can reconcile.
    if (!this.isCurrent(ws, info, data.callSessionId)) return;
    for (const reply of operation.replies) this.emit(ws, reply);
    if (operation.committed) this.emit(ws, { type: 'call:sdp-committed', data: {
      callSessionId: data.callSessionId, sdpRecoveryVersion: 1, sdpOperationId: data.sdpOperationId
    }, timestamp: this.now() });
  }
  /** Called before ordinary transport/buffering; never logs SDP or bearer data. */
  capture(ws: WebSocket, message: WebSocketMessage): WebSocketMessage {
    const context = this.context.getStore();
    if (context?.ws === ws && ['error', 'call:access-denied', 'call:ended'].includes(message.type)) {
      if (context.operation.replies.length < 8) context.operation.replies.push(message);
    }
    const info = this.deps.info(ws) ?? this.deliveryScopes.get(ws);
    if (info?.actorType !== 'local' || info.sdpRecoveryVersion !== 1 || !descriptions.has(message.type)) return message;
    const data = message.data as any;
    if (!info.scopedCallSessionId || data?.callSessionId !== info.scopedCallSessionId) throw new Error('CALL_SDP_ROUTE_MISMATCH');
    if (data.sdpDeliveryId) return message; // Already captured by a recovery buffer.
    const call = this.state(info, data.callSessionId);
    return this.mail(call, this.destination(info), message);
  }
  private mail(call: Call, destination: string, message: WebSocketMessage): WebSocketMessage {
    const deliveryId = randomUUID();
    const decorated = { ...message, data: { ...message.data, sdpRecoveryVersion: 1, sdpDeliveryId: deliveryId } };
    const bytes = Buffer.byteLength(JSON.stringify(decorated));
    if (call.mail.size >= 32 || this.bytes + bytes > 16 * 1024 * 1024) throw new Error('CALL_SDP_MAILBOX_LIMIT');
    call.mail.set(deliveryId, { destination, message: decorated, bytes }); this.bytes += bytes;
    return decorated;
  }
  replay(ws: WebSocket, info: LocalConnectionInfo, callId: string): void | Promise<void> {
    if (this.deps.store) return this.deps.store.locked(info.familyId, callId, async () => {
      await this.load(info, callId);
      if (await this.deps.authorize(ws, info, callId, 'call:resume') && this.isCurrent(ws, info, callId)) this.replayInner(ws, info, callId);
    });
    this.replayInner(ws, info, callId);
  }
  private replayInner(ws: WebSocket, info: LocalConnectionInfo, callId: string): void {
    const call = this.calls.get(this.key(info, callId));
    if (!call || call.closedAt !== undefined) return;
    for (const mail of call.mail.values()) if (mail.destination === this.destination(info)) this.deps.send(ws, mail.message);
  }
  async acknowledge(ws: WebSocket, info: ConnectionInfo, data: any): Promise<void> {
    try { await this.durable(info, data?.callSessionId, () => this.acknowledgeInner(ws, info, data)); }
    catch { this.reject(ws, 'CALL_SDP_DURABILITY_FAILED'); }
  }
  private async acknowledgeInner(ws: WebSocket, info: ConnectionInfo, data: any): Promise<void> {
    if (info.actorType !== 'local' || info.sdpRecoveryVersion !== 1 || data?.sdpRecoveryVersion !== 1 || !uuid.test(data?.sdpDeliveryId || '')) {
      this.reject(ws, 'CALL_SDP_ACK_INVALID', ['sdpDeliveryId']); return;
    }
    if (!await this.deps.authorize(ws, info, data.callSessionId, 'call:sdp-ack')) return;
    if (!this.isCurrent(ws, info, data.callSessionId)) { this.reject(ws, 'CALL_SDP_AUTHORITY_CHANGED'); return; }
    const call = this.calls.get(this.key(info, data.callSessionId));
    const mail = call?.mail.get(data.sdpDeliveryId.toLowerCase());
    if (!mail) return; // Lost ACK retry, scoped above; no state to invent.
    if (mail.destination !== this.destination(info)) { this.reject(ws, 'CALL_SDP_ACK_ROUTE_MISMATCH'); return; }
    call!.mail.delete(data.sdpDeliveryId.toLowerCase()); this.bytes -= mail.bytes;
  }
  close(familyId: string, callId: string): void {
    const call = this.calls.get(JSON.stringify([familyId, callId]));
    if (call) { call.closedAt = this.now(); for (const mail of call.mail.values()) this.bytes -= mail.bytes; call.mail.clear(); }
  }
}
