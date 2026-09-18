import type { WebSocket } from 'ws';
import { DirectFileTransferSessionRegistry } from './directFileTransferSessionRegistry';

const socket = (name: string) => ({ name }) as unknown as WebSocket;

function session(params: {
  sessionId?: string;
  initiatorWs?: WebSocket;
  targetWs?: WebSocket;
  targetDeviceId?: string;
  expiresAt?: number;
} = {}) {
  return {
    familyId: 'family',
    initiatorIdentityId: 'sender',
    initiatorWs: params.initiatorWs || socket('sender'),
    targetIdentityId: 'receiver',
    targetDeviceId: params.targetDeviceId,
    targetWs: params.targetWs,
    incomingData: {
      sessionId: params.sessionId || 'session',
      fromIdentityId: 'sender',
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    },
    expiresAt: params.expiresAt || 2_000
  };
}

describe('DirectFileTransferSessionRegistry', () => {
  let now = 1_000;
  const registry = () => new DirectFileTransferSessionRegistry({
    now: () => now,
    maxPendingInitiatorCandidates: 2,
    setTimer: () => ({ unref() {} }) as unknown as NodeJS.Timeout,
    clearTimer: () => {}
  });

  beforeEach(() => {
    now = 1_000;
  });

  it('rejects duplicate session ids instead of replacing another route', () => {
    const routes = registry();
    expect(routes.register(session())).toBe(true);
    expect(routes.register(session({ initiatorWs: socket('attacker') }))).toBe(false);
    expect((routes.get('session')?.initiatorWs as unknown as { name: string }).name).toBe('sender');
  });

  it('expires a session when it is read after its TTL', () => {
    const expired: string[] = [];
    const routes = new DirectFileTransferSessionRegistry({
      now: () => now,
      setTimer: () => ({ unref() {} }) as unknown as NodeJS.Timeout,
      clearTimer: () => {},
      onExpire: (entry) => expired.push(entry.incomingData.sessionId)
    });
    routes.register(session({ expiresAt: 1_500 }));
    now = 1_501;
    expect(routes.get('session')).toBeUndefined();
    expect(expired).toEqual(['session']);
  });

  it('bounds and drains initiator ICE candidates', () => {
    const routes = registry();
    routes.register(session());
    const first = { sessionId: 'session', candidate: { candidate: 'one' } };
    const second = { sessionId: 'session', candidate: { candidate: 'two' } };
    const third = { sessionId: 'session', candidate: { candidate: 'three' } };
    expect(routes.bufferInitiatorCandidate('session', first)).toBe(true);
    expect(routes.bufferInitiatorCandidate('session', second)).toBe(true);
    expect(routes.bufferInitiatorCandidate('session', third)).toBe(false);
    expect(routes.drainInitiatorCandidates('session')).toEqual([first, second]);
    expect(routes.drainInitiatorCandidates('session')).toEqual([]);
  });

  it('keeps pre-accept target ICE candidates isolated by device', () => {
    const routes = registry();
    const firstDevice = socket('first-device');
    const secondDevice = socket('second-device');
    routes.register(session());
    const first = { sessionId: 'session', candidate: { candidate: 'first' } };
    const second = { sessionId: 'session', candidate: { candidate: 'second' } };

    expect(routes.bufferTargetCandidate('session', firstDevice, first)).toBe(true);
    expect(routes.bufferTargetCandidate('session', secondDevice, second)).toBe(true);
    expect(routes.drainTargetCandidates('session', secondDevice)).toEqual([second]);
    expect(routes.drainTargetCandidates('session', firstDevice)).toEqual([]);
  });

  it('removes an initiator route and detaches a target route on socket close', () => {
    const routes = registry();
    const sender = socket('sender');
    const receiver = socket('receiver');
    routes.register(session({ sessionId: 'sender-route', initiatorWs: sender, targetWs: receiver }));
    routes.register(session({ sessionId: 'target-route', initiatorWs: socket('other'), targetWs: receiver }));

    expect(routes.detachSocket(sender).map((entry) => entry.role)).toEqual(['initiator']);
    expect(routes.get('sender-route')).toBeUndefined();
    expect(routes.detachSocket(receiver).map((entry) => entry.role)).toEqual(['target']);
    expect(routes.get('target-route')?.targetWs).toBeUndefined();
  });
});
