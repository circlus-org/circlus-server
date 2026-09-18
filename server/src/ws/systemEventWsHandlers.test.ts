import type { WebSocket } from 'ws';
import type { AuthenticatedActor } from '../services/authenticatedActor';
import {
  SystemEventWsHandlers,
  type SystemEventWsHandlerDependencies
} from './systemEventWsHandlers';

const ws = {} as WebSocket;
const actor: AuthenticatedActor = {
  familyId: 'family-1',
  identityId: 'identity-1',
  deviceId: 'device-1',
  accessLevel: 'trusted'
};

function harness(overrides: Partial<SystemEventWsHandlerDependencies> = {}) {
  const dependencies: SystemEventWsHandlerDependencies = {
    requireActor: jest.fn(() => actor),
    sendMessage: jest.fn(),
    sendServiceError: jest.fn(),
    syncBatchLimit: 200,
    listSystemEvents: jest.fn(async () => ({ events: [], syncedThrough: 10, hasMore: false })),
    ackSystemEvents: jest.fn(async () => undefined),
    now: () => 123,
    ...overrides
  };
  return { dependencies, handlers: new SystemEventWsHandlers(dependencies) };
}

describe('system event WebSocket handlers', () => {
  it('preserves the system sync result envelope and batch limit', async () => {
    const { handlers, dependencies } = harness();
    await handlers.handleSync(ws, {
      deviceId: 'device-1',
      payload: { since: 5 }
    });
    expect(dependencies.listSystemEvents).toHaveBeenCalledWith(actor, {
      since: 5,
      limit: 200
    });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(ws, {
      type: 'system:sync-result',
      data: { events: [], syncedThrough: 10, hasMore: false },
      timestamp: 123
    });
  });

  it('does nothing for an unauthenticated socket', async () => {
    const { handlers, dependencies } = harness({ requireActor: () => null });
    await handlers.handleSyncAck(ws, { deviceId: 'device-1', payload: {} });
    expect(dependencies.ackSystemEvents).not.toHaveBeenCalled();
  });

  it('maps service errors through the common error boundary', async () => {
    const error = new Error('sync failed');
    const { handlers, dependencies } = harness({
      listSystemEvents: jest.fn(async () => { throw error; })
    });
    await handlers.handleSync(ws, { deviceId: 'device-1', payload: {} });
    expect(dependencies.sendServiceError).toHaveBeenCalledWith(
      ws,
      error,
      'Failed to sync system events'
    );
  });
});
