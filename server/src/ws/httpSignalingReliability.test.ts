import { WebSocket } from 'ws';
import type { WebSocketMessage } from '@shared/types';
import { HttpCallRuntimeSessionManager } from './httpCallRuntimeSessionManager';

function fixture(maxQueue = 10) {
  let now = 0, nextId = 0;
  const sockets: WebSocket[] = [];
  const processed: string[] = [];
  let pause: Promise<void> | undefined;
  let manager: HttpCallRuntimeSessionManager;
  manager = new HttpCallRuntimeSessionManager({
    now: () => now, createSessionId: () => `session-${++nextId}`,
    createSocket: () => { const ws = {} as WebSocket; sockets.push(ws); return ws; },
    sessionTtlMs: 1000, maxPollMs: 500, maxQueue, maxSessions: 2,
    maxQueueBytes: 2048, maxGlobalBytes: 3000,
    setSocketFamilyContext: jest.fn(), handleClose: jest.fn(), hasConnectionInfo: () => true,
    handleMessage: async (ws, message) => {
      if (message.type === 'register') manager.findQueueBySocket(ws)?.enqueue({ type: 'registered', data: {}, timestamp: now });
      else {
        processed.push(message.type);
        await pause;
        manager.findQueueBySocket(ws)?.enqueue(message);
      }
    }
  });
  const create = () => manager.create({ familyId: 'circle', circleId: 'circle-1', origin: 'https://client', protocol: 2,
    registration: { type: 'register', data: {}, timestamp: 0 } });
  const scope = { sessionId: 'session-1', familyId: 'circle', origin: 'https://client' };
  return {manager, create, scope, sockets, processed, pause: (promise: Promise<void>) => { pause = promise; }, advance: (ms: number) => { now += ms; }};
}
const signal: WebSocketMessage = {type: 'call:offer', data: {callSessionId: 'call'}, timestamp: 0};

describe('event-driven poll wakeup', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function waitingSession(protocol = 2) {
    let manager: HttpCallRuntimeSessionManager;
    const socket = {} as WebSocket;
    manager = new HttpCallRuntimeSessionManager({
      now: () => Date.now(), createSocket: () => socket, createSessionId: () => 'waiting',
      sessionTtlMs: 60000, maxPollMs: 10000,
      setSocketFamilyContext: jest.fn(), handleClose: jest.fn(), hasConnectionInfo: () => true,
      handleMessage: async ws => {
        manager.findQueueBySocket(ws)?.enqueue({type: 'registered', data: {}, timestamp: Date.now()});
      }
    });
    await manager.create({familyId: 'circle', circleId: 'circle-1', protocol,
      ...(protocol === 2 ? {registration: {type: 'register', data: {}, timestamp: 0}} : {})});
    if (protocol === 2) await manager.poll({sessionId: 'waiting', ack: 0, timeoutMs: 0});
    return {manager, socket, params: {sessionId: 'waiting', ack: 1}};
  }

  test.each([1, 2])('protocol %i wakes on arrival without advancing the clock', async protocol => {
    const f = await waitingSession(protocol);
    const pending = f.manager.poll(f.params);
    expect(jest.getTimerCount()).toBe(1);
    f.manager.findQueueBySocket(f.socket)?.enqueue(signal);
    const result = await pending;
    expect(result).toMatchObject(protocol === 2
      ? {ok: true, events: [{sequence: 2, message: signal}]}
      : {ok: true, messages: [signal]});
    expect(jest.getTimerCount()).toBe(0);
  });

  test('idle poll waits until its deadline and rejects a concurrent poll', async () => {
    const f = await waitingSession();
    let finished = false;
    const pending = f.manager.poll(f.params).then(result => { finished = true; return result; });
    expect(await f.manager.poll(f.params)).toMatchObject({status: 409});
    await jest.advanceTimersByTimeAsync(9999);
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ok: true, events: []});
    expect(jest.getTimerCount()).toBe(0);
  });

  test('abort wakes immediately, removes its listener and permits a new poll', async () => {
    const f = await waitingSession();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const pending = f.manager.poll({...f.params, signal: controller.signal});
    controller.abort();
    expect(await pending).toMatchObject({status: 499});
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
    expect(await f.manager.poll({...f.params, timeoutMs: 0})).toMatchObject({ok: true});
  });

  test('closing the session wakes an outstanding poll immediately', async () => {
    const f = await waitingSession();
    const pending = f.manager.poll(f.params);
    f.manager.close('waiting');
    expect(await pending).toMatchObject({status: 404});
    expect(jest.getTimerCount()).toBe(0);
  });
});

test('lost poll response is retained until explicit ACK', async () => {
  const f = fixture(); await f.create();
  const first = await f.manager.poll({...f.scope, ack: 0, timeoutMs: 0});
  expect(first).toMatchObject({ok: true, events: [{sequence: 1, message: {type: 'registered'}}]});
  expect(await f.manager.poll({...f.scope, ack: 0, timeoutMs: 0})).toEqual(first);
  expect(await f.manager.poll({...f.scope, ack: 1, timeoutMs: 0})).toMatchObject({ok: true, events: []});
});

test('lost send response retries one sequence exactly once', async () => {
  const f = fixture(); await f.create();
  await f.manager.send({...f.scope, sequence: 1, message: signal});
  expect(await f.manager.send({...f.scope, sequence: 1, message: signal})).toMatchObject({ok: true});
  expect(f.processed).toEqual(['call:offer']);
  expect(await f.manager.send({...f.scope, sequence: 1, message: {...signal, data: {changed: true}}})).toMatchObject({status: 409});
  expect(await f.manager.send({...f.scope, sequence: 3, message: signal})).toMatchObject({status: 409});
});

test('concurrent writes cannot overtake an unfinished handler', async () => {
  const f = fixture(); await f.create();
  let release!: () => void;
  f.pause(new Promise(resolve => { release = resolve; }));
  const first = f.manager.send({...f.scope, sequence: 1, message: signal});
  expect(await f.manager.send({...f.scope, sequence: 2, message: signal})).toMatchObject({status: 409});
  release(); await first;
  expect(await f.manager.send({...f.scope, sequence: 2, message: signal})).toMatchObject({ok: true});
});

test('tenant and browser origin scope cannot be crossed', async () => {
  const f = fixture(); await f.create();
  expect(await f.manager.poll({...f.scope, familyId: 'other', ack: 0})).toMatchObject({status: 404});
  expect(await f.manager.send({...f.scope, origin: 'https://evil', message: signal, sequence: 1})).toMatchObject({status: 404});
  f.manager.close(f.scope.sessionId, 'other', f.scope.origin);
  expect(await f.manager.poll({...f.scope, ack: 0, timeoutMs: 0})).toMatchObject({ok: true});
});

test('ACK cannot discard events which were never delivered', async () => {
  const f = fixture(); await f.create();
  expect(await f.manager.poll({...f.scope, ack: 1, timeoutMs: 0})).toMatchObject({status: 400});
  expect(await f.manager.poll({...f.scope, ack: 0, timeoutMs: 0})).toMatchObject({ok: true, events: [{sequence: 1}]});
});

test('queue overflow closes the session instead of dropping a signal', async () => {
  const f = fixture(1); await f.create();
  expect(await f.manager.send({...f.scope, sequence: 1, message: signal})).toMatchObject({status: 404});
  expect(f.sockets[0].readyState).toBe(WebSocket.CLOSED);
  expect(await f.manager.poll({...f.scope, ack: 0})).toMatchObject({status: 404});
});

test('session capacity is released on close and idle expiry', async () => {
  const f = fixture(); await f.create(); await f.create();
  expect(await f.create()).toMatchObject({status: 503});
  f.manager.close('session-1');
  expect(await f.create()).toMatchObject({ok: true});
  f.advance(1001);
  expect(await f.create()).toMatchObject({ok: true});
});

test('active polling extends idle lifetime', async () => {
  const f = fixture(); await f.create();
  f.advance(900);
  await f.manager.poll({...f.scope, ack: 0, timeoutMs: 0});
  f.advance(900);
  expect(await f.manager.poll({...f.scope, ack: 1, timeoutMs: 0})).toMatchObject({ok: true});
});

test('session cannot change its actor by registering again', async () => {
  const f = fixture(); await f.create();
  expect(await f.manager.send({...f.scope, sequence: 1, message: {type: 'register', data: {}, timestamp: 0}})).toMatchObject({status: 400});
});
