import type { WebSocket } from 'ws';
import { CallSessionRoutingRegistry } from './callSessionRoutingRegistry';
import { CallSignalingRecovery } from './callSignalingRecovery';
import type { ConnectionInfo } from '../ws/wsConnectionContext';

const caller = { readyState: 3 } as WebSocket;
const receiver = { readyState: 1 } as WebSocket;
const replacement = { readyState: 1 } as WebSocket;
const info: ConnectionInfo = {
  actorType: 'external', familyId: 'circle', identityId: 'guest', deviceId: 'ext:guest',
  externalPublicKey: { algorithm: 'ed25519', value: 'key' },
  callGrant: {
    kind: 'call_link', admissionId: 'link', targetIdentityId: 'receiver',
    capabilityGrant: {
      descriptor: { payload: { capabilityId: 'cap-link' } } as any,
      proof: {} as any
    }
  }
};

function harness() {
  const routes = new CallSessionRoutingRegistry();
  routes.registerInitiator({ callSessionId: 'call-1', familyId: 'circle',
    initiatorIdentityId: 'guest', initiatorWs: caller, targetIdentityId: 'receiver' });
  routes.bindAcceptedTargetIfAbsent({ callSessionId: 'call-1', identityId: 'receiver',
    ws: receiver, deviceId: 'browser' });
  const send = jest.fn();
  const expire = jest.fn(async () => {});
  const recovery = new CallSignalingRecovery({ routes, send, expire, log: jest.fn(), graceMs: 10_000 });
  return { routes, send, expire, recovery };
}

describe('call signaling recovery after acceptance', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('preserves the accepted browser and replays an answer lost while the guest reconnects', async () => {
    const { routes, recovery, send, expire } = harness();
    recovery.closed(caller, info);
    const answer = { type: 'call:answered', data: { callSessionId: 'call-1', answer: {} }, timestamp: 1 };
    expect(recovery.buffer(caller, answer)).toBe(true);
    expect(recovery.resume(replacement, info, 'call-1')).toBe(true);
    expect(routes.resolvePeerSocket('call-1', 'receiver')).toBe(replacement);
    expect(routes.resolvePeerSocket('call-1', 'guest')).toBe(receiver);
    expect(send).toHaveBeenCalledWith(replacement, answer);
    recovery.closed(caller, info);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(expire).not.toHaveBeenCalled();
  });

  it('ends the orphaned call after the grace period instead of leaving the browser busy', async () => {
    const { routes, recovery, expire } = harness();
    recovery.closed(caller, info);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(expire).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(expire).toHaveBeenCalledWith(
      'call-1',
      expect.objectContaining({ acceptedTargetWs: receiver }),
      'signaling_disconnected'
    );
    expect(routes.get('call-1')).toBeUndefined();
    expect(recovery.resume(replacement, info, 'call-1')).toBe(false);
  });

  it('does not resume for a new call, another circle, device, or admission', () => {
    const { recovery } = harness();
    recovery.closed(caller, info);
    expect(recovery.resume(replacement, info, 'call-2')).toBe(false);
    expect(recovery.resume(replacement, { ...info, familyId: 'other' }, 'call-1')).toBe(false);
    expect(recovery.resume(replacement, { ...info, deviceId: 'other' }, 'call-1')).toBe(false);
    expect(recovery.resume(replacement, { ...info, callGrant: { ...info.callGrant!, admissionId: 'other' } }, 'call-1')).toBe(false);
  });

  it('lets the same call-link guest supersede only its disconnected call', async () => {
    const { routes, recovery, expire } = harness();
    recovery.closed(caller, info);

    await expect(recovery.supersedeDisconnectedExternalCall({
      ws: replacement,
      info,
      previousCallSessionId: 'call-1',
      nextCallSessionId: 'call-2',
      targetIdentityId: 'receiver'
    })).resolves.toBe(true);

    expect(routes.get('call-1')).toBeUndefined();
    expect(expire).toHaveBeenCalledWith(
      'call-1',
      expect.objectContaining({ acceptedTargetWs: receiver }),
      'superseded_by_redial'
    );
  });

  it('does not let another guest, admission, target, or a healthy route supersede a call', async () => {
    const { routes, recovery, expire } = harness();
    const request = (nextInfo: ConnectionInfo = info, targetIdentityId = 'receiver') => (
      recovery.supersedeDisconnectedExternalCall({
        ws: replacement,
        info: nextInfo,
        previousCallSessionId: 'call-1',
        nextCallSessionId: 'call-2',
        targetIdentityId
      })
    );

    await expect(request()).resolves.toBe(false);
    recovery.closed(caller, info);
    await expect(request({ ...info, identityId: 'other-guest' })).resolves.toBe(false);
    await expect(request({ ...info, externalPublicKey: { algorithm: 'ed25519', value: 'other-key' } })).resolves.toBe(false);
    await expect(request({ ...info, callGrant: { ...info.callGrant!, admissionId: 'other-link' } })).resolves.toBe(false);
    await expect(request(info, 'other-target')).resolves.toBe(false);

    expect(routes.get('call-1')).toBeDefined();
    expect(expire).not.toHaveBeenCalled();
  });

  it('does not expire a call that ended normally or moved to a native runtime', async () => {
    const { routes, recovery, expire } = harness();
    recovery.closed(caller, info);
    routes.bindInitiatorRuntime({ callSessionId: 'call-1', identityId: 'guest', ws: replacement });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(expire).not.toHaveBeenCalled();
    recovery.closed(replacement, info);
    routes.remove('call-1');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(expire).not.toHaveBeenCalled();
  });

  it('restores the accepted browser only for the same device', async () => {
    const { routes, recovery, expire } = harness();
    const browser: ConnectionInfo = { actorType: 'local', familyId: 'circle',
      identityId: 'receiver', deviceId: 'browser', runtimeMode: 'default' };
    recovery.closed(receiver, browser);
    expect(recovery.resume(replacement, { ...browser, deviceId: 'phone' }, 'call-1')).toBe(false);
    expect(recovery.resume(replacement, { ...browser, runtimeMode: 'video-native', scopedCallSessionId: 'call-2' }, 'call-1')).toBe(false);
    expect(recovery.resume(replacement, browser, 'call-1')).toBe(true);
    expect(routes.resolvePeerSocket('call-1', 'guest')).toBe(replacement);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(expire).not.toHaveBeenCalled();
  });

  it('replays after native scoped registration has rebound the socket', () => {
    const { routes, recovery, send } = harness();
    recovery.closed(caller, info);
    const message = { type: 'call:ice-candidate', data: { callSessionId: 'call-1' }, timestamp: 1 };
    recovery.buffer(caller, message);
    routes.bindInitiatorRuntime({ callSessionId: 'call-1', identityId: 'guest', ws: replacement });
    expect(recovery.resume(replacement, info, 'call-1')).toBe(true);
    expect(send).toHaveBeenCalledWith(replacement, message);
  });

  it('bounds buffered signaling and expires both disconnected endpoints only once', async () => {
    const { recovery, expire } = harness();
    recovery.closed(caller, info);
    recovery.closed(receiver, { actorType: 'local', familyId: 'circle', identityId: 'receiver', deviceId: 'browser' });
    for (let n = 0; n < 129; n++) {
      recovery.buffer(caller, { type: 'call:ice-candidate', data: { callSessionId: 'call-1' }, timestamp: n });
    }
    expect(expire).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(expire).toHaveBeenCalledTimes(1);
  });
});
