import WebSocket, { type RawData } from 'ws';
import type { Duplex } from 'node:stream';
import type { WebSocketResourceLimits } from '../config/callRuntimeConfig';

export type ConnectionLease = {
  readonly active: boolean;
  upgrade(): void;
  registered(): void;
  release(): void;
};
type Item = { data: RawData; bytes: number };
type State = {
  ws: WebSocket;
  lease: ConnectionLease;
  queue: Item[];
  messages: number;
  bytes: number;
  running: boolean;
  stopped: boolean;
  registered: boolean;
  fallbackCapable: boolean;
  lastActivity: number;
  outgoingBytes: number;
  sends: Set<{ bytes: number; released: boolean }>;
  deadline?: NodeJS.Timeout;
  terminateTimer?: NodeJS.Timeout;
};
const registrationHooks = new WeakMap<WebSocket, () => void>();

/** Called only after authentication succeeds and the registered response is sent. */
export function markWebSocketRegistered(ws: WebSocket): void {
  registrationHooks.get(ws)?.();
}

function byteLength(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + byteLength(part), 0);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
  return Buffer.byteLength(String(data));
}

/** One instance per process, shared by every Circle and WS runtime mode. */
export class WsResourceGuard {
  private readonly activeStates = new Set<State>();
  private readonly states = new WeakMap<WebSocket, State>();
  private readonly connectionsByIp = new Map<string, number>();
  private connections = 0;
  private unregisteredConnections = 0;
  private queuedMessages = 0;
  private queuedBytes = 0;
  private outgoingBytes = 0;
  private outgoingMessages = 0;

  constructor(
    private readonly limits: WebSocketResourceLimits,
    private readonly handle: (ws: WebSocket, data: RawData) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly onLimit: (reason: string) => void,
    private readonly onClosedTaskFinished: (ws: WebSocket) => void = () => undefined,
    private readonly isProtected: (ws: WebSocket) => boolean = () => true
  ) {
    if (limits.softMaxConnections !== undefined) {
      const timer = setInterval(() => this.relievePressure(), 1000);
      timer.unref();
    }
  }

  noteMessage(ws: WebSocket, message: {type: string; httpFallback?: boolean}): void {
    const state = this.states.get(ws);
    if (!state) return;
    if (message.type.startsWith('register') && message.httpFallback === true) state.fallbackCapable = true;
    if (message.type !== 'ping') state.lastActivity = Date.now();
  }

  private relievePressure(): void {
    const soft = Math.min(this.limits.softMaxConnections ?? this.limits.maxConnections, this.limits.maxConnections);
    if (this.connections <= soft) return;
    const candidates = [...this.activeStates].filter(state => state.registered && state.fallbackCapable
      && !state.stopped && !state.running && Date.now() - state.lastActivity >= 30_000 && !this.isProtected(state.ws))
      .sort((a, b) => a.lastActivity - b.lastActivity);
    // At most one handover per second; avoid a simultaneous reconnect wave.
    const state = candidates[0];
    if (!state) return;
    state.ws.send(JSON.stringify({ type: 'transport:defer', data: { retryAfterMs: 60_000 }, timestamp: Date.now() }));
    this.close(state, 'transport_deferred', 1013);
  }

  snapshot() {
    return { connections: this.connections, unregisteredConnections: this.unregisteredConnections,
      queuedMessages: this.queuedMessages, queuedBytes: this.queuedBytes, outgoingBytes: this.outgoingBytes, outgoingMessages: this.outgoingMessages };
  }

  /** Reserve before asynchronous origin/tenant checks, including pending upgrades. */
  reserve(address: string, transport: Duplex): ConnectionLease | null {
    const perIp = this.connectionsByIp.get(address) || 0;
    if (this.connections >= this.limits.maxConnections
      || this.unregisteredConnections >= this.limits.maxUnregisteredConnections
      || perIp >= this.limits.maxConnectionsPerIp) return null;
    this.connections++;
    this.unregisteredConnections++;
    this.connectionsByIp.set(address, perIp + 1);
    let active = true;
    let registered = false;
    const release = () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      transport.removeListener('close', release);
      this.connections--;
      if (!registered) this.unregisteredConnections--;
      const remaining = (this.connectionsByIp.get(address) || 1) - 1;
      if (remaining) this.connectionsByIp.set(address, remaining);
      else this.connectionsByIp.delete(address);
    };
    const timer = setTimeout(() => {
      release();
      transport.destroy();
      this.onLimit('handshake_timeout');
    }, this.limits.handshakeTimeoutMs);
    timer.unref();
    transport.once('close', release);
    return {
      get active() { return active; },
      upgrade: () => clearTimeout(timer),
      registered: () => {
        if (!active || registered) return;
        registered = true;
        this.unregisteredConnections--;
      },
      release
    };
  }

  attach(ws: WebSocket, lease: ConnectionLease): boolean {
    if (!lease.active || ws.readyState !== WebSocket.OPEN) { lease.release(); ws.terminate(); return false; }
    lease.upgrade();
    const state: State = { ws, lease, queue: [], messages: 0, bytes: 0, running: false,
      stopped: false, registered: false, fallbackCapable: false, lastActivity: Date.now(), outgoingBytes: 0, sends: new Set() };
    this.states.set(ws, state);
    this.activeStates.add(state);
    registrationHooks.set(ws, () => {
      if (state.stopped || ws.readyState !== WebSocket.OPEN) return;
      state.registered = true;
      lease.registered();
      clearTimeout(state.deadline);
    });
    state.deadline = setTimeout(() => this.close(state, 'registration_timeout', 1008), this.limits.registrationTimeoutMs);
    state.deadline.unref();
    ws.once('close', () => {
      this.stop(state);
      clearTimeout(state.terminateTimer);
      for (const send of state.sends) this.releaseSend(state, send);
      lease.release();
    });
    this.guardSend(state);
    return true;
  }

  enqueue(ws: WebSocket, data: RawData): void {
    const state = this.states.get(ws);
    if (!state || state.stopped || ws.readyState !== WebSocket.OPEN) return;
    const bytes = byteLength(data);
    const maxMessages = state.registered ? this.limits.maxQueuedMessages
      : Math.min(this.limits.maxQueuedMessages, this.limits.maxUnregisteredMessages);
    const maxBytes = state.registered ? this.limits.maxQueuedBytes
      : Math.min(this.limits.maxQueuedBytes, this.limits.maxUnregisteredBytes);
    if (state.messages + 1 > maxMessages || state.bytes + bytes > maxBytes
      || this.queuedMessages + 1 > this.limits.maxGlobalQueuedMessages
      || this.queuedBytes + bytes > this.limits.maxGlobalQueuedBytes) {
      this.close(state, 'incoming_queue_limit', 1013);
      return;
    }
    state.messages++;
    state.bytes += bytes;
    this.queuedMessages++;
    this.queuedBytes += bytes;
    state.queue.push({ data, bytes });
    if (!state.running) void this.drain(state).catch(error => this.onError(error));
  }

  private async drain(state: State): Promise<void> {
    state.running = true;
    try {
      while (!state.stopped && state.ws.readyState === WebSocket.OPEN && state.queue.length) {
        const item = state.queue.shift()!;
        try { await this.handle(state.ws, item.data); }
        catch (error) { this.onError(error); }
        finally {
          this.releaseItem(state, item);
          if (state.stopped || state.ws.readyState !== WebSocket.OPEN) this.onClosedTaskFinished(state.ws);
        }
      }
    } finally {
      state.running = false;
      if (state.ws.readyState !== WebSocket.OPEN) this.stop(state);
    }
  }

  private releaseItem(state: State, item: Item): void {
    state.messages--;
    state.bytes -= item.bytes;
    this.queuedMessages--;
    this.queuedBytes -= item.bytes;
  }

  private stop(state: State): void {
    if (state.stopped) return;
    state.stopped = true;
    this.activeStates.delete(state);
    clearTimeout(state.deadline);
    registrationHooks.delete(state.ws);
    for (const item of state.queue) this.releaseItem(state, item);
    state.queue.length = 0;
    // An already running handler remains accounted for until its finally executes.
  }

  private close(state: State, reason: string, code: number): void {
    if (state.stopped) return;
    this.stop(state);
    state.terminateTimer = setTimeout(() => state.ws.terminate(), 1000);
    state.terminateTimer.unref();
    try { state.ws.close(code, reason); } catch { state.ws.terminate(); }
    this.onLimit(reason);
  }

  private releaseSend(state: State, send: { bytes: number; released: boolean }): void {
    if (send.released) return;
    send.released = true;
    state.outgoingBytes -= send.bytes;
    this.outgoingBytes -= send.bytes;
    this.outgoingMessages--;
    state.sends.delete(send);
  }

  private guardSend(state: State): void {
    const ws = state.ws;
    const original = ws.send.bind(ws);
    // Intercept the socket once so every runtime/fanout path gets the same budget.
    ws.send = ((data: Parameters<WebSocket['send']>[0], options?: any, callback?: (error?: Error) => void) => {
      const done = typeof options === 'function' ? options : callback;
      this.write(state, data, done, complete => original(data, typeof options === 'function' ? {} : (options || {}), complete));
    }) as WebSocket['send'];
    // ws uses its public pong() for automatic ping replies too.
    for (const method of ['ping', 'pong'] as const) {
      const control = ws[method].bind(ws);
      ws[method] = (data?: any, mask?: boolean, callback?: (error: Error) => void) => {
        const done = typeof data === 'function' ? data : callback;
        this.write(state, typeof data === 'function' ? '' : (data ?? ''), done,
          complete => control(typeof data === 'function' ? undefined : data, mask, complete));
      };
    }
  }

  private write(state: State, data: unknown, done: ((error?: Error) => void) | undefined,
    invoke: (complete: (error?: Error) => void) => void): void {
    const ws = state.ws;
    // Include frame overhead, and cap message count separately (including empty frames).
    const bytes = byteLength(data) + 16;
    if (state.stopped || ws.readyState !== WebSocket.OPEN) {
      if (done) queueMicrotask(() => done(new Error('WebSocket is closing')));
      return;
    }
    if (state.sends.size >= this.limits.maxOutgoingMessages
      || this.outgoingMessages >= this.limits.maxGlobalOutgoingMessages
      || Math.max(state.outgoingBytes, ws.bufferedAmount) + bytes > this.limits.maxOutgoingBytes
      || this.outgoingBytes + bytes > this.limits.maxGlobalOutgoingBytes) {
      this.close(state, 'outgoing_queue_limit', 1013);
      if (done) queueMicrotask(() => done(new Error('WebSocket outgoing queue limit')));
      return;
    }
    const send = { bytes, released: false };
    state.sends.add(send);
    state.outgoingBytes += bytes;
    this.outgoingBytes += bytes;
    this.outgoingMessages++;
    try {
      invoke(error => {
        this.releaseSend(state, send);
        if (done) done(error);
      });
    } catch (error) {
      this.releaseSend(state, send);
      throw error;
    }
  }
}
