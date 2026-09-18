import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { WebSocket } from 'ws';
import type {
  IdentityId,
  WebSocketMessage,
  WSRegisterCallRuntimeData
} from '@shared/types';

type HttpRuntimeSession = {
  ws: WebSocket;
  queue: WebSocketMessage[];
  expiresAt: number;
  lastSeenAt: number;
  familyId: string;
  address?: string;
  origin?: string;
  protocol: number;
  events: Array<{ sequence: number; message: WebSocketMessage; bytes: number }>;
  nextEvent: number;
  deliveredThrough: number;
  lastSend: number;
  lastFingerprint: string;
  busy: boolean;
  polling: boolean;
  wakePoll?: () => void;
  bytes: number;
};

export type HttpCallRuntimeSessionManagerDependencies = {
  handleMessage: (ws: WebSocket, message: WebSocketMessage) => Promise<void>;
  handleClose: (ws: WebSocket) => void;
  setSocketFamilyContext: (ws: WebSocket, familyId: string, circleId: string) => void;
  hasConnectionInfo: (ws: WebSocket) => boolean;
  getConnectionInfo?: (ws: WebSocket) => { familyId: string; identityId: IdentityId } | undefined;
  maxSessions?: number;
  maxSessionsPerIp?: number;
  maxQueue?: number;
  maxQueueBytes?: number;
  maxGlobalBytes?: number;
  sessionTtlMs: number;
  maxPollMs: number;
  now?: () => number;
  createSessionId?: () => string;
  createSocket?: () => WebSocket;
};

export class HttpCallRuntimeSessionManager {
  private readonly sessions = new Map<string, HttpRuntimeSession>();
  private globalBytes = 0;
  private readonly now: () => number;
  private readonly createSessionId: () => string;
  private readonly createSocket: () => WebSocket;

  constructor(private readonly dependencies: HttpCallRuntimeSessionManagerDependencies) {
    this.now = dependencies.now || Date.now;
    this.createSessionId = dependencies.createSessionId || (() => nanoid(43));
    this.createSocket = dependencies.createSocket || createHttpRuntimeSocket;
    if (!dependencies.now) {
      const cleanup = setInterval(() => this.cleanupExpired(), Math.min(60_000, dependencies.sessionTtlMs));
      cleanup.unref();
    }
  }

  findQueueBySocket(ws: WebSocket): { queue: WebSocketMessage[]; enqueue: (message: WebSocketMessage) => void } | null {
    for (const session of this.sessions.values()) {
      if (session.ws === ws) return { queue: session.queue, enqueue: message => this.enqueue(session, message) };
    }
    return null;
  }

  async create(params: {
    familyId: string;
    circleId: string;
    signedRequest?: WSRegisterCallRuntimeData['signedRequest'];
    registration?: WebSocketMessage;
    protocol?: number;
    address?: string;
    origin?: string;
  }): Promise<
    | { ok: true; sessionId: string; messages: WebSocketMessage[] }
    | { ok: false; status: number; error: string; messages?: WebSocketMessage[] }
  > {
    this.cleanupExpired();
    if (Buffer.byteLength(JSON.stringify(params.registration || params.signedRequest || {})) > 1024 * 1024) return { ok: false, status: 413, error: 'Registration too large' };
    if (this.sessions.size >= (this.dependencies.maxSessions ?? 512)) return { ok: false, status: 503, error: 'HTTP signaling capacity reached' };
    if (params.registration && (params.protocol !== 2 || !['register', 'register-external', 'register-call-runtime', 'register-file-transfer-runtime'].includes(params.registration.type))) {
      return { ok: false, status: 400, error: 'Invalid registration' };
    }
    if (params.address && [...this.sessions.values()].filter(session => session.address === params.address).length >= (this.dependencies.maxSessionsPerIp ?? 128)) return { ok: false, status: 503, error: 'HTTP signaling address capacity reached' };
    const sessionId = this.createSessionId();
    const ws = this.createSocket();
    const now = this.now();
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN, configurable: true });
    ws.close = () => this.close(sessionId);
    ws.terminate = () => this.close(sessionId);
    this.dependencies.setSocketFamilyContext(ws, params.familyId, params.circleId);
    this.sessions.set(sessionId, {
      ws,
      queue: [],
      expiresAt: now + this.dependencies.sessionTtlMs,
      lastSeenAt: now,
      familyId: params.familyId, address: params.address, origin: params.origin, protocol: params.protocol === 2 ? 2 : 1,
      events: [], nextEvent: 1, deliveredThrough: 0, lastSend: 0, lastFingerprint: '', busy: false, polling: false, bytes: 0
    });

    const registrationDeadline = setTimeout(() => this.close(sessionId), 10_000);
    registrationDeadline.unref();
    try {
    await this.dependencies.handleMessage(ws, params.registration || {
      type: 'register-call-runtime',
      data: { signedRequest: params.signedRequest },
      timestamp: this.now()
    });
    } catch (error) { this.close(sessionId); throw error; } finally { clearTimeout(registrationDeadline); }
    if (!this.sessions.has(sessionId)) return notFound();
    const messages = params.protocol === 2 ? this.sessions.get(sessionId)!.events.map(event => event.message) : this.drain(sessionId);
    if (!this.dependencies.hasConnectionInfo(ws) || (params.protocol === 2 && !this.sessions.get(sessionId)?.events.some(e => e.message.type === 'registered'))) {
      this.close(sessionId);
      const errorData = messages.find((message) => message.type === 'error')?.data as
        | { message?: string }
        | undefined;
      return {
        ok: false,
        status: 401,
        error: errorData?.message || 'Call runtime registration failed',
        messages
      };
    }
    return { ok: true, sessionId, messages: params.protocol === 2 ? [] : messages };
  }

  async send(params: {
    sessionId: string; message: WebSocketMessage; familyId?: string; origin?: string; sequence?: number;
  }): Promise<{ ok: true; messages: WebSocketMessage[] } | { ok: false; status: number; error: string }> {
    this.cleanupExpired();
    const session = this.get(params);
    if (!session) return notFound();
    if (session.busy) return { ok: false, status: 409, error: 'Signaling write in progress' };
    if (params.message.type.startsWith('register')) return { ok: false, status: 400, error: 'Already registered' };
    const encoded = JSON.stringify(params.message);
    if (Buffer.byteLength(encoded) > 1024 * 1024) return { ok: false, status: 413, error: 'Signal too large' };
    const fingerprint = createHash('sha256').update(encoded).digest('hex');
    if (session.protocol === 2) {
      if (params.sequence === session.lastSend && fingerprint === session.lastFingerprint) return { ok: true, messages: [] };
      if (!Number.isSafeInteger(params.sequence) || params.sequence !== session.lastSend + 1) {
        return { ok: false, status: 409, error: 'Unexpected signaling sequence' };
      }
    }
    session.busy = true;
    session.lastSeenAt = this.now();
    try {
      await this.dependencies.handleMessage(session.ws, params.message);
      if (!this.sessions.has(params.sessionId)) return notFound();
      session.lastSend = params.sequence ?? session.lastSend;
      session.lastFingerprint = fingerprint;
      return { ok: true, messages: session.protocol === 2 ? [] : this.drain(params.sessionId) };
    } finally {
      session.busy = false;
      if (!this.sessions.has(params.sessionId)) this.dependencies.handleClose(session.ws);
    }
  }

  async poll(params: {
    sessionId: string; timeoutMs?: number; familyId?: string; origin?: string; ack?: number; signal?: AbortSignal;
  }): Promise<{ ok: true; messages: WebSocketMessage[]; events?: Array<{sequence: number; message: WebSocketMessage}> } | { ok: false; status: number; error: string }> {
    this.cleanupExpired();
    const session = this.get(params);
    if (!session) return notFound();
    if (session.polling) return { ok: false, status: 409, error: 'Poll already active' };
    if (session.protocol === 2) {
      if (!Number.isSafeInteger(params.ack) || params.ack! < 0 || params.ack! > session.deliveredThrough) {
        return { ok: false, status: 400, error: 'Invalid signaling ACK' };
      }
      while (session.events.length && session.events[0].sequence <= params.ack!) {
        const event = session.events.shift()!;
        session.bytes -= event.bytes; this.globalBytes -= event.bytes;
      }
    }
    session.polling = true;
    session.lastSeenAt = this.now();
    const startedAt = this.now();
    const timeoutMs = Math.max(0, Math.min(this.dependencies.maxPollMs, Number.isFinite(params.timeoutMs) ? params.timeoutMs! : this.dependencies.maxPollMs));
    try {
      while (true) {
        if (params.signal?.aborted) return { ok: false, status: 499, error: 'Poll cancelled' };
        if (!this.sessions.has(params.sessionId)) return notFound();
        const elapsed = this.now() - startedAt;
        if ((session.protocol === 2 ? session.events.length : session.queue.length) || elapsed >= timeoutMs) {
          session.lastSeenAt = this.now();
          if (session.protocol === 2) {
            const events = session.events.map(({sequence, message}) => ({sequence, message}));
            session.deliveredThrough = Math.max(session.deliveredThrough, events.at(-1)?.sequence ?? 0);
            return { ok: true, messages: [], events };
          }
          return { ok: true, messages: this.drain(params.sessionId) };
        }
        await this.waitForEvent(session, timeoutMs - elapsed, params.signal);
      }
    } finally { session.polling = false; }
  }

  private waitForEvent(session: HttpRuntimeSession, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', wake);
        if (session.wakePoll === wake) session.wakePoll = undefined;
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      session.wakePoll = wake;
      signal?.addEventListener('abort', wake, { once: true });
      if (signal?.aborted) wake();
    });
  }

  private get(params: {sessionId: string; familyId?: string; origin?: string}): HttpRuntimeSession | undefined {
    const session = this.sessions.get(params.sessionId);
    if (!session || (params.familyId !== undefined && session.familyId !== params.familyId)
      || session.origin !== params.origin) return undefined;
    return session;
  }

  private enqueue(session: HttpRuntimeSession, message: WebSocketMessage): void {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    const count = session.protocol === 2 ? session.events.length : session.queue.length;
    if (count >= (this.dependencies.maxQueue ?? 500) || session.bytes + bytes > (this.dependencies.maxQueueBytes ?? 4 * 1024 * 1024)
      || this.globalBytes + bytes > (this.dependencies.maxGlobalBytes ?? 32 * 1024 * 1024)) {
      for (const [id, candidate] of this.sessions) if (candidate === session) this.close(id);
      return;
    }
    session.bytes += bytes; this.globalBytes += bytes;
    if (session.protocol === 2) session.events.push({sequence: session.nextEvent++, message, bytes});
    else session.queue.push(message);
    session.wakePoll?.();
  }

  close(sessionId: string, familyId?: string, origin?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || (familyId !== undefined && (session.familyId !== familyId || session.origin !== origin))) return;
    this.sessions.delete(sessionId);
    session.wakePoll?.();
    this.globalBytes -= session.bytes;
    session.bytes = 0;
    session.queue.length = 0; session.events.length = 0;
    Object.defineProperty(session.ws, 'readyState', { value: WebSocket.CLOSED, configurable: true });
    this.dependencies.handleClose(session.ws);
  }

  closeByIdentity(familyId: string, identityId: IdentityId): number {
    let closed = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      const info = this.dependencies.getConnectionInfo?.(session.ws);
      if (info?.familyId !== familyId || info.identityId !== identityId) continue;
      this.close(sessionId);
      closed += 1;
    }
    return closed;
  }

  closeByFamily(familyId: string): number {
    let closed = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      const info = this.dependencies.getConnectionInfo?.(session.ws);
      if (info?.familyId !== familyId) continue;
      this.close(sessionId);
      closed += 1;
    }
    return closed;
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (
        now - session.lastSeenAt <= this.dependencies.sessionTtlMs
      ) {
        continue;
      }
      this.close(sessionId);
    }
  }

  private drain(sessionId: string): WebSocketMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    if (session.protocol === 2) return [];
    this.globalBytes -= session.bytes; session.bytes = 0;
    const messages = session.queue.splice(0, session.queue.length);
    session.lastSeenAt = this.now();
    return messages;
  }
}

function createHttpRuntimeSocket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: () => undefined,
    close: () => undefined,
    terminate: () => undefined,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
    removeListener: () => undefined
  } as unknown as WebSocket;
}

function notFound(): { ok: false; status: number; error: string } {
  return { ok: false, status: 404, error: 'Call signaling session not found' };
}
