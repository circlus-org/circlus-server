import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { loadCallRuntimeConfig, type WebSocketResourceLimits } from '../config/callRuntimeConfig';
import { WsResourceGuard, markWebSocketRegistered } from './wsResourceGuard';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  completes: Array<(error?: Error) => void> = [];
  autoClose = true;
  send = jest.fn((_data, _options, callback) => { this.completes.push(callback); });
  ping = jest.fn((_data, _mask, callback) => { this.completes.push(callback); });
  pong = jest.fn((_data, _mask, callback) => { this.completes.push(callback); });
  close = jest.fn((_code?: number, _reason?: string) => {
    void _code; void _reason;
    this.readyState = WebSocket.CLOSING;
    if (this.autoClose) this.finishClose();
  });
  terminate = jest.fn(() => this.finishClose());
  finishClose() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

function fixture(overrides: Partial<WebSocketResourceLimits> = {}, handle = jest.fn(async (_ws: WebSocket, _data: WebSocket.RawData) => { void _ws; void _data; }), isProtected: (ws: WebSocket) => boolean = () => true) {
  const errors = jest.fn(), limits = jest.fn(), cleaned = jest.fn();
  const guard = new WsResourceGuard({ ...loadCallRuntimeConfig({}).webSocket.limits, ...overrides }, handle, errors, limits, cleaned, isProtected);
  const connect = (address = 'one', registered = true) => {
    const transport = new PassThrough();
    const lease = guard.reserve(address, transport)!;
    expect(lease).not.toBeNull();
    const socket = new FakeSocket();
    const ws = socket as unknown as WebSocket;
    expect(guard.attach(ws, lease)).toBe(true);
    if (registered) markWebSocketRegistered(ws);
    return { socket, ws, transport, lease };
  };
  return { guard, connect, handle, errors, limits, cleaned };
}

describe('bounded WebSocket resources', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('soft pressure defers only opted-in idle sockets and protects calls', async () => {
    let protectedWs: WebSocket;
    const f = fixture({maxConnections: 3, softMaxConnections: 1}, undefined, ws => ws === protectedWs);
    const idle = f.connect();
    const call = f.connect(); protectedWs = call.ws;
    const oldClient = f.connect();
    f.guard.noteMessage(idle.ws, {type: 'register', httpFallback: true});
    f.guard.noteMessage(call.ws, {type: 'register', httpFallback: true});
    jest.advanceTimersByTime(31_000);
    expect(idle.socket.close).toHaveBeenCalledWith(1013, 'transport_deferred');
    expect(call.socket.close).not.toHaveBeenCalled();
    expect(oldClient.socket.close).not.toHaveBeenCalled();
    expect(f.guard.snapshot().connections).toBe(2);
  });

  test('preserves order while accounting for the running handler', async () => {
    const gate = deferred();
    const seen: string[] = [];
    const f = fixture({}, jest.fn(async (_ws, data) => { seen.push(data.toString()); if (seen.length === 1) await gate.promise; }));
    const { ws } = f.connect();
    for (const text of ['offer', 'answer', 'ice']) f.guard.enqueue(ws, Buffer.from(text));
    expect(seen).toEqual(['offer']);
    expect(f.guard.snapshot()).toMatchObject({ queuedMessages: 3, queuedBytes: 14 });
    gate.resolve(); await flush();
    expect(seen).toEqual(['offer', 'answer', 'ice']);
    expect(f.guard.snapshot()).toMatchObject({ queuedMessages: 0, queuedBytes: 0 });
  });

  test('overflow discards pending work but keeps the running task accounted until finally', async () => {
    const gate = deferred();
    const f = fixture({ maxQueuedMessages: 2 }, jest.fn(async () => gate.promise));
    const { ws, socket } = f.connect();
    for (let i = 0; i < 4; i++) f.guard.enqueue(ws, Buffer.from('x'));
    expect(socket.close).toHaveBeenCalledWith(1013, 'incoming_queue_limit');
    expect(f.handle).toHaveBeenCalledTimes(1);
    expect(f.guard.snapshot()).toMatchObject({ connections: 0, queuedMessages: 1, queuedBytes: 1 });
    gate.resolve(); await flush();
    expect(f.guard.snapshot()).toMatchObject({ queuedMessages: 0, queuedBytes: 0 });
    expect(f.cleaned).toHaveBeenCalledWith(ws);
  });

  test('counts all buffers and UTF-8 bytes before scheduling', async () => {
    const f = fixture({ maxQueuedBytes: 5 });
    const { ws, socket } = f.connect();
    f.guard.enqueue(ws, [Buffer.from('яя'), Buffer.from('xx')]);
    expect(socket.close).toHaveBeenCalledWith(1013, 'incoming_queue_limit');
    expect(f.handle).not.toHaveBeenCalled();
    expect(f.guard.snapshot().queuedBytes).toBe(0);
  });

  test.each([
    { maxGlobalQueuedBytes: 2 }, { maxGlobalQueuedMessages: 1 }
  ])('enforces a shared inbound budget across sockets: %j', async override => {
    const gate = deferred();
    const f = fixture(override, jest.fn(async () => gate.promise));
    const a = f.connect(), b = f.connect('two');
    f.guard.enqueue(a.ws, Buffer.from('xx'));
    f.guard.enqueue(b.ws, Buffer.from('x'));
    expect(a.socket.close).not.toHaveBeenCalled();
    expect(b.socket.close).toHaveBeenCalled();
    gate.resolve(); await flush();
    expect(f.guard.snapshot().queuedBytes).toBe(0);
  });

  test('close while queued never starts the next handler or accepts later messages', async () => {
    const gate = deferred();
    const f = fixture({}, jest.fn(async () => gate.promise));
    const { ws, socket } = f.connect();
    f.guard.enqueue(ws, Buffer.from('first'));
    f.guard.enqueue(ws, Buffer.from('second'));
    socket.finishClose();
    f.guard.enqueue(ws, Buffer.from('late'));
    gate.resolve(); await flush();
    expect(f.handle).toHaveBeenCalledTimes(1);
    expect(f.guard.snapshot()).toMatchObject({ connections: 0, queuedMessages: 0, queuedBytes: 0 });
  });

  test('handler failure releases budgets and does not break subsequent work', async () => {
    const f = fixture({}, jest.fn().mockRejectedValueOnce(new Error('DB unavailable')).mockResolvedValue(undefined));
    const { ws } = f.connect();
    f.guard.enqueue(ws, Buffer.from('one')); f.guard.enqueue(ws, Buffer.from('two'));
    await flush();
    expect(f.errors).toHaveBeenCalledTimes(1);
    expect(f.handle).toHaveBeenCalledTimes(2);
    expect(f.guard.snapshot().queuedMessages).toBe(0);
  });

  test('unregistered sockets have a smaller queue and cannot prolong the registration deadline', async () => {
    const f = fixture({ registrationTimeoutMs: 1000, maxUnregisteredBytes: 4 });
    const a = f.connect('one', false);
    f.guard.enqueue(a.ws, Buffer.from('large'));
    expect(a.socket.close).toHaveBeenCalled();
    const b = f.connect('two', false);
    jest.advanceTimersByTime(900);
    f.guard.enqueue(b.ws, Buffer.from('x')); await flush();
    jest.advanceTimersByTime(100);
    expect(b.socket.close).toHaveBeenCalledWith(1008, 'registration_timeout');
    markWebSocketRegistered(b.ws);
    expect(f.guard.snapshot().unregisteredConnections).toBe(0);
  });

  test('successful authentication clears the deadline and switches to the normal budget', async () => {
    const f = fixture({ registrationTimeoutMs: 1000, maxUnregisteredBytes: 1 });
    const { ws, socket } = f.connect('one', false);
    markWebSocketRegistered(ws);
    jest.advanceTimersByTime(2000);
    f.guard.enqueue(ws, Buffer.from('normal')); await flush();
    expect(socket.close).not.toHaveBeenCalled();
    expect(f.guard.snapshot().unregisteredConnections).toBe(0);
    expect(f.handle).toHaveBeenCalledTimes(1);
  });

  test('a refused close handshake is force-terminated and frees its connection slot', () => {
    const f = fixture({ registrationTimeoutMs: 1000 });
    const { socket } = f.connect('one', false);
    socket.autoClose = false;
    jest.advanceTimersByTime(1000);
    expect(f.guard.snapshot().connections).toBe(1);
    jest.advanceTimersByTime(1000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(f.guard.snapshot().connections).toBe(0);
  });

  test('pending upgrades count toward admission limits and time out without a WS object', () => {
    const f = fixture({ handshakeTimeoutMs: 1000, maxConnections: 2, maxConnectionsPerIp: 1 });
    const transport = new PassThrough();
    const first = f.guard.reserve('one', transport)!;
    expect(f.guard.reserve('one', new PassThrough())).toBeNull();
    const second = f.guard.reserve('two', new PassThrough())!;
    expect(f.guard.reserve('three', new PassThrough())).toBeNull();
    second.release(); second.release();
    jest.advanceTimersByTime(1000);
    expect(transport.destroyed).toBe(true);
    expect(first.active).toBe(false);
    expect(f.guard.snapshot()).toMatchObject({ connections: 0, unregisteredConnections: 0 });
  });

  test('bounds unregistered connections separately and frees admission after authentication', () => {
    const f = fixture({ maxUnregisteredConnections: 1 });
    const first = f.connect('one', false);
    expect(f.guard.reserve('two', new PassThrough())).toBeNull();
    markWebSocketRegistered(first.ws);
    const lease = f.guard.reserve('two', new PassThrough());
    expect(lease).not.toBeNull(); lease!.release();
  });

  test('outgoing limits cover native bufferedAmount and report an error to the sender', () => {
    const f = fixture({ maxOutgoingBytes: 64 });
    const { ws, socket } = f.connect();
    socket.bufferedAmount = 63;
    const callback = jest.fn();
    ws.send('x', callback);
    jest.runAllTicks();
    expect(socket.close).toHaveBeenCalledWith(1013, 'outgoing_queue_limit');
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    expect(f.guard.snapshot().outgoingBytes).toBe(0);
  });

  test.each([{ maxGlobalOutgoingBytes: 33 }, { maxGlobalOutgoingMessages: 1 }])('outgoing budget is shared: %j', override => {
    const f = fixture(override);
    const a = f.connect(), b = f.connect('two');
    a.ws.send('x'); b.ws.send('x');
    expect(b.socket.close).toHaveBeenCalled();
    expect(a.socket.close).not.toHaveBeenCalled();
    a.socket.completes[0]();
    expect(f.guard.snapshot()).toMatchObject({ outgoingBytes: 0, outgoingMessages: 0 });
  });

  test('empty sends and automatic pong replies also consume the outgoing budget', () => {
    const f = fixture({ maxOutgoingMessages: 2 });
    const { ws, socket } = f.connect();
    ws.send(''); ws.pong(''); ws.ping('');
    expect(socket.close).toHaveBeenCalledWith(1013, 'outgoing_queue_limit');
    expect(f.guard.snapshot().outgoingBytes).toBe(0);
    for (const complete of socket.completes) complete(new Error('closed'));
    expect(f.guard.snapshot()).toMatchObject({ outgoingBytes: 0, outgoingMessages: 0 });
  });

  test('synchronous send errors release accounting', () => {
    const f = fixture();
    const transport = new PassThrough();
    const socket = new FakeSocket();
    socket.send.mockImplementation(() => { throw new Error('write failed'); });
    const ws = socket as unknown as WebSocket;
    f.guard.attach(ws, f.guard.reserve('one', transport)!);
    expect(() => ws.send('x')).toThrow('write failed');
    expect(f.guard.snapshot()).toMatchObject({ outgoingBytes: 0, outgoingMessages: 0 });
  });
});
