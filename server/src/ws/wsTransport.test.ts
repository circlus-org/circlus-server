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


it('excludes no-call sessions from call delivery and HTTP queueing while preserving messages and other devices', () => {
  const noCalls = socket(), enabled = socket(), http = socket();
  const queue = { queue: [] as Array<{ type: string; data: unknown }> };
  const noCallInfo = { actorType: 'local', familyId: 'circle-a', identityId: 'identity-a', deviceId: 'ios-a', callsEnabled: false } as const;
  const transport = createWsTransport({
    findHttpRuntimeQueue: ws => ws === http ? queue : null, maxHttpRuntimeQueue: 10,
    canSend: (ws, message) => isOutboundMessageAllowedForConnection(ws === enabled ? { ...noCallInfo, deviceId: 'other', callsEnabled: true } : noCallInfo, message.type)
  });
  const recipients = new Set([noCalls, enabled, http]);
  for (const type of ['call:incoming', 'call:ended', 'call:delivery-status']) {
    transport.sendToSet(recipients, { type, data: {} });
  }
  expect(noCalls.send).not.toHaveBeenCalled();
  expect(queue.queue).toEqual([]);
  expect(enabled.send).toHaveBeenCalledTimes(3);
  transport.sendToSet(recipients, { type: 'message:deliver', data: {} });
  expect(noCalls.send).toHaveBeenCalledTimes(1);
  expect(queue.queue.map(message => message.type)).toEqual(['message:deliver']);
});

it('drops late, foreign and incomplete native call broadcasts before both socket send and HTTP queue', () => {
  const a = socket(), b = socket(), http = socket();
  const first = { actorType: 'local', familyId: 'circle-a', identityId: 'identity', deviceId: 'device-a', runtimeMode: 'video-native', scopedCallSessionId: 'call-new' } as const;
  const second = { ...first, familyId: 'circle-b', deviceId: 'device-b', scopedCallSessionId: 'call-other' };
  const queue = { queue: [] as Array<{ type: string; data: unknown }> };
  const transport = createWsTransport({ findHttpRuntimeQueue: ws => ws === http ? queue : null, maxHttpRuntimeQueue: 20,
    canSend: (ws, message) => isOutboundMessageAllowedForConnection(ws === b ? second : first, message.type, message.data) });
  const recipients = new Set([a, b, http]);
  for (const type of ['call:ended', 'call:video-state', 'call:delivery-status']) {
    for (const data of [{ callSessionId: 'call-old' }, {}]) transport.sendToSet(recipients, { type, data });
  }
  transport.sendToSet(recipients, { type: 'message:deliver', data: {} });
  expect(a.send).not.toHaveBeenCalled(); expect(b.send).not.toHaveBeenCalled(); expect(queue.queue).toEqual([]);
  transport.sendToSet(recipients, { type: 'call:video-state', data: { callSessionId: 'call-new', enabled: true } });
  transport.sendToSet(recipients, { type: 'call:ended', data: { callSessionId: 'call-other' } });
  expect(a.send).toHaveBeenCalledTimes(1); expect(b.send).toHaveBeenCalledTimes(1);
  expect(queue.queue).toEqual([{ type: 'call:video-state', data: { callSessionId: 'call-new', enabled: true } }]);
  transport.sendToSet(recipients, { type: 'pong', data: {} });
  expect(a.send).toHaveBeenCalledTimes(2); expect(b.send).toHaveBeenCalledTimes(2);
  expect(queue.queue).toHaveLength(2);
});
