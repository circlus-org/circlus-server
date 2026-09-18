import type { WebSocket } from 'ws';
import type { AuthenticatedActor } from '../services/authenticatedActor';
import { CallLifecycleWsHandlers, type CallLifecycleWsHandlerDependencies } from './callLifecycleWsHandlers';

const ws = {} as WebSocket;
const actor: AuthenticatedActor = {
  familyId: 'family-1',
  identityId: 'identity-1',
  deviceId: 'device-1',
  accessLevel: 'trusted'
};

function harness(overrides: Partial<CallLifecycleWsHandlerDependencies> = {}) {
  const dependencies: CallLifecycleWsHandlerDependencies = {
    requireActor: jest.fn(() => actor),
    assertRuntimeScope: jest.fn(() => true),
    sendMessage: jest.fn(),
    sendServiceError: jest.fn(),
    callHistoryBatchLimit: 200,
    listCallHistory: jest.fn(async () => ({ events: [], syncedThrough: 10, hasMore: false })),
    ackCallHistory: jest.fn(async () => undefined),
    markMissedCallsSeen: jest.fn(async () => undefined),
    markCallConnected: jest.fn(async () => undefined),
    markCallHeartbeat: jest.fn(async () => undefined),
    finalizeCall: jest.fn(async () => undefined),
    now: () => 123,
    ...overrides
  };
  return { dependencies, handlers: new CallLifecycleWsHandlers(dependencies) };
}

describe('call lifecycle WebSocket handlers', () => {
  it('returns call history through the transport boundary', async () => {
    const { handlers, dependencies } = harness();
    await handlers.handleHistorySync(ws, {
      deviceId: 'device-1',
      payload: { since: 5 }
    });

    expect(dependencies.listCallHistory).toHaveBeenCalledWith(actor, { since: 5, limit: 200 });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(ws, {
      type: 'call-history:sync-result',
      data: { events: [], syncedThrough: 10, hasMore: false },
      timestamp: 123
    });
  });

  it('does not call lifecycle services for an unauthenticated socket', async () => {
    const { handlers, dependencies } = harness({ requireActor: () => null });
    await handlers.handleConnected(ws, {
      deviceId: 'device-1',
      payload: { callSessionId: 'call-1', connectedAt: 10 }
    });
    expect(dependencies.markCallConnected).not.toHaveBeenCalled();
  });

  it('enforces native runtime call scope before recording a report', async () => {
    const { handlers, dependencies } = harness({ assertRuntimeScope: () => false });
    await handlers.handleHeartbeat(ws, {
      deviceId: 'device-1',
      payload: { callSessionId: 'call-2', connectedAt: 10, sentAt: 20 }
    });
    expect(dependencies.markCallHeartbeat).not.toHaveBeenCalled();
  });

  it('maps domain failures through the shared service-error boundary', async () => {
    const error = new Error('invalid report');
    const { handlers, dependencies } = harness({
      finalizeCall: jest.fn(async () => { throw error; })
    });
    await handlers.handleFinalized(ws, {
      deviceId: 'device-1',
      payload: { callSessionId: 'call-1', endedAt: 30, finalStatus: 'ended' }
    });
    expect(dependencies.sendServiceError).toHaveBeenCalledWith(
      ws,
      error,
      'Failed to finalize call'
    );
  });
});
