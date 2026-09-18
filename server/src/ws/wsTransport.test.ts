import { isOutboundMessageAllowedForConnection } from './wsConnectionContext';
import WebSocket from 'ws';
import { createWsTransport } from './wsTransport';

function socket(readyState = WebSocket.OPEN) {
  return { readyState, send: jest.fn() } as unknown as WebSocket;
}

describe('WebSocket transport', () => {
  it('serializes messages only for open network sockets', () => {
    const transport = createWsTransport({ findHttpRuntimeQueue: () => null, maxHttpRuntimeQueue: 10 });
    const open = socket();
    const closed = socket(WebSocket.CLOSED);
    const message = { type: 'pong', data: {}, timestamp: 1 };

    transport.send(open, message);
    transport.send(closed, message);

    expect(open.send).toHaveBeenCalledWith(JSON.stringify(message));
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('queues HTTP-runtime messages and keeps the newest bounded page', () => {
    const ws = socket();
    const runtime = { queue: [] as Array<{ type: string; data: unknown }> };
    const transport = createWsTransport({
      findHttpRuntimeQueue: (candidate) => candidate === ws ? runtime : null,
      maxHttpRuntimeQueue: 2
    });

    transport.send(ws, { type: 'one', data: {} });
    transport.send(ws, { type: 'two', data: {} });
    transport.send(ws, { type: 'three', data: {} });

    expect(runtime.queue.map((message) => message.type)).toEqual(['two', 'three']);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('creates the existing wire-level error envelope', () => {
    const ws = socket();
    const transport = createWsTransport({
      findHttpRuntimeQueue: () => null,
      maxHttpRuntimeQueue: 10,
      now: () => 123
    });

    transport.sendError(ws, 'FORBIDDEN', 'Denied');

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'error',
      data: { code: 'FORBIDDEN', message: 'Denied' },
      timestamp: 123
    }));
  });
});

it('filters member events before both network delivery and HTTP queueing on a call-only socket', () => {
  const external = { actorType: 'external', identityId: 'new-member', deviceId: 'ext:new-member',
    familyId: 'family', externalPublicKey: { algorithm: 'ed25519', value: 'key' } } as const;
  const network = socket();
  const http = socket();
  const queue = { queue: [] as Array<{ type: string; data: unknown }> };
  const transport = createWsTransport({
    findHttpRuntimeQueue: ws => ws === http ? queue : null, maxHttpRuntimeQueue: 10,
    canSend: (_ws, message) => isOutboundMessageAllowedForConnection(external, message.type)
  });
  for (const type of ['message:deliver', 'system:event', 'circle:directory-changed', 'group:message:deliver']) {
    transport.sendToSet(new Set([network, http]), { type, data: {} });
  }
  expect(network.send).not.toHaveBeenCalled();
  expect(queue.queue).toEqual([]);
  transport.sendToSet(new Set([network, http]), { type: 'call:ended', data: {} });
  expect(network.send).toHaveBeenCalledTimes(1);
  expect(queue.queue.map(message => message.type)).toEqual(['call:ended']);
});
