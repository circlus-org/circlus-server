import type { WebSocket } from 'ws';
import type { WebSocketMessage } from '@shared/types';
import {
  HttpCallRuntimeSessionManager,
  type HttpCallRuntimeSessionManagerDependencies
} from './httpCallRuntimeSessionManager';

const ws = {} as WebSocket;

function harness(options: { registered?: boolean } = {}) {
  let now = 1_000;
  let manager: HttpCallRuntimeSessionManager;
  const dependencies: HttpCallRuntimeSessionManagerDependencies = {
    handleMessage: jest.fn(async (socket, message) => {
      const queue = manager.findQueueBySocket(socket)?.queue;
      if (message.type === 'register-call-runtime') {
        queue?.push(options.registered === false
          ? {
              type: 'error',
              data: { code: 'UNAUTHORIZED', message: 'Registration denied' },
              timestamp: now
            }
          : { type: 'registered', data: {}, timestamp: now });
      } else {
        queue?.push({ type: 'response', data: message.data, timestamp: now });
      }
    }),
    handleClose: jest.fn(),
    setSocketFamilyContext: jest.fn(),
    hasConnectionInfo: jest.fn(() => options.registered !== false),
    getConnectionInfo: jest.fn(() => options.registered === false ? undefined : ({
      familyId: 'family-1',
      identityId: 'identity-1'
    })),
    sessionTtlMs: 1_000,
    maxPollMs: 500,
    now: () => now,
    createSessionId: () => 'session-1',
    createSocket: () => ws
  };
  manager = new HttpCallRuntimeSessionManager(dependencies);
  return {
    dependencies,
    manager,
    advance: (ms: number) => { now += ms; }
  };
}

const signedRequest = { signerId: 'device-1' } as any;

describe('HTTP call runtime session manager', () => {
  it('creates an authenticated runtime session and drains registration messages', async () => {
    const { manager, dependencies } = harness();
    await expect(manager.create({ familyId: 'family-1', circleId: 'circle-1', signedRequest })).resolves.toEqual({
      ok: true,
      sessionId: 'session-1',
      messages: [{ type: 'registered', data: {}, timestamp: 1_000 }]
    });
    expect(dependencies.setSocketFamilyContext).toHaveBeenCalledWith(ws, 'family-1', 'circle-1');
  });

  it('closes and removes a session when registration fails', async () => {
    const { manager, dependencies } = harness({ registered: false });
    await expect(manager.create({ familyId: 'family-1', circleId: 'circle-1', signedRequest })).resolves.toEqual({
      ok: false,
      status: 401,
      error: 'Registration denied',
      messages: [{
        type: 'error',
        data: { code: 'UNAUTHORIZED', message: 'Registration denied' },
        timestamp: 1_000
      }]
    });
    expect(dependencies.handleClose).toHaveBeenCalledWith(ws);
    await expect(manager.send({
      sessionId: 'session-1',
      message: { type: 'ping', data: {}, timestamp: 1_000 }
    })).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'Call signaling session not found'
    });
  });

  it('routes messages through the synthetic socket and drains the response queue', async () => {
    const { manager } = harness();
    await manager.create({ familyId: 'family-1', circleId: 'circle-1', signedRequest });
    const message: WebSocketMessage = { type: 'call:heartbeat', data: { value: 1 }, timestamp: 1_000 };
    await expect(manager.send({ sessionId: 'session-1', message })).resolves.toEqual({
      ok: true,
      messages: [{ type: 'response', data: { value: 1 }, timestamp: 1_000 }]
    });
  });

  it('expires stale sessions before accepting another message', async () => {
    const { manager, dependencies, advance } = harness();
    await manager.create({ familyId: 'family-1', circleId: 'circle-1', signedRequest });
    advance(1_001);
    await expect(manager.poll({ sessionId: 'session-1', timeoutMs: 0 })).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'Call signaling session not found'
    });
    expect(dependencies.handleClose).toHaveBeenCalledWith(ws);
  });

  it('closes every HTTP call runtime session owned by a suspended identity', async () => {
    const { manager, dependencies } = harness();
    await manager.create({ familyId: 'family-1', circleId: 'circle-1', signedRequest });

    expect(manager.closeByIdentity('family-1', 'identity-1' as any)).toBe(1);
    expect(dependencies.handleClose).toHaveBeenCalledWith(ws);
    await expect(manager.poll({ sessionId: 'session-1', timeoutMs: 0 })).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'Call signaling session not found'
    });
  });

  it('closes every HTTP call runtime session for a suspended Circle', async () => {
    const { manager, dependencies } = harness();
    await manager.create({ familyId: 'family-1', circleId: 'circle-1', signedRequest });

    expect(manager.closeByFamily('family-1')).toBe(1);
    expect(dependencies.handleClose).toHaveBeenCalledWith(ws);
    expect(manager.closeByFamily('family-2')).toBe(0);
  });
});
