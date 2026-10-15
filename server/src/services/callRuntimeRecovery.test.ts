import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { CallSdpRecovery } from './callSdpRecovery';
import { CallSessionRoutingRegistry } from './callSessionRoutingRegistry';
import { deferCallSdpEffect } from './callSdpEffects';
import type { DurableCallRecord, CallRuntimeRecoveryStore } from './callRuntimeRecoveryStore';
import type { LocalConnectionInfo } from '../ws/wsConnectionContext';

const caller: LocalConnectionInfo = { actorType: 'local', familyId: 'circle-a', identityId: 'caller', deviceId: 'caller-device',
  scopedCallSessionId: 'call', scopedRemoteIdentityId: 'callee', callRuntimeRole: 'caller', runtimeMode: 'video-native', sdpRecoveryVersion: 1 };
const callee: LocalConnectionInfo = { ...caller, identityId: 'callee', deviceId: 'selected-callee', scopedRemoteIdentityId: 'caller', callRuntimeRole: 'callee' };
const route = { familyId: 'circle-a', initiatorIdentityId: 'caller', initiatorDeviceId: 'caller-device', targetIdentityId: 'callee', acceptedTargetDeviceId: 'selected-callee' };
function fixture() {
  let rows = new Map<string, DurableCallRecord>(), fail = false;
  const store: CallRuntimeRecoveryStore = {
    async locked(family, call, work) {
      const before = structuredClone(rows);
      try { await Promise.resolve(); const result = await work(); if (fail) throw new Error('crash before commit'); return result; }
      catch (error) { rows = before; throw error; }
    },
    async load(family, call) { const record = rows.get(JSON.stringify([family,call])); return record ? structuredClone(record) : undefined; },
    async save(family, call, record) { rows.set(JSON.stringify([family,call]), structuredClone(record)); },
    async close(family, call) { rows.delete(JSON.stringify([family,call])); }
  };
  function process() {
    const a = {} as WebSocket, b = {} as WebSocket, actors = new Map([[a,caller],[b,callee]]);
    const sent = jest.fn(), diagnostic = jest.fn(), routes = new CallSessionRoutingRegistry();
    routes.restore('call', route);
    const recovery = new CallSdpRecovery({ store, info: socket => actors.get(socket), send: sent, diagnostic,
      authorize: async (_socket, info) => info.familyId === route.familyId && (info.callRuntimeRole === 'caller'
        ? info.identityId === route.initiatorIdentityId && info.deviceId === route.initiatorDeviceId && info.scopedRemoteIdentityId === route.targetIdentityId
        : info.identityId === route.targetIdentityId && info.deviceId === route.acceptedTargetDeviceId && info.scopedRemoteIdentityId === route.initiatorIdentityId),
      route: call => routes.get(call), invalidateRoute: call => { routes.remove(call); } });
    return { recovery, sent, diagnostic, routes, a, b, actors };
  }
  const command = (type = 'call:offer', id = randomUUID()) => ({ type, data: { callSessionId: 'call', sdpRecoveryVersion: 1, sdpOperationId: id, offer: { sdp: 'private-sdp' } }, timestamp: 1 });
  return { process, store, command, fail: (value: boolean) => { fail = value; } };
}
describe('durable native API recovery', () => {
  it('commits immutable outcomes and outbox before any receipt or notification, then reloads in a new process', async () => {
    const f = fixture(), first = f.process(), op = f.command(), effect = jest.fn(async () => {});
    await first.recovery.execute(first.a, caller, op, async () => {
      expect(first.sent).not.toHaveBeenCalled();
      expect(deferCallSdpEffect(effect)).toBe(true);
      first.recovery.capture(first.b, { type: 'call:renegotiate-offer', data: { callSessionId: 'call', offer: {} }, timestamp: 1 });
      expect(effect).not.toHaveBeenCalled();
    });
    expect(effect).toHaveBeenCalledTimes(1);
    const second = f.process(), dispatch = jest.fn();
    await second.recovery.execute(second.a, caller, op, dispatch);
    expect(dispatch).not.toHaveBeenCalled(); expect(second.sent.mock.calls.at(-1)![1].type).toBe('call:sdp-committed');
    await second.recovery.replay(second.b, callee, 'call');
    const delivery = second.sent.mock.calls.at(-1)![1];
    expect(delivery.type).toBe('call:renegotiate-offer');
    const third = f.process(); await third.recovery.replay(third.b, callee, 'call');
    expect(third.sent.mock.calls.at(-1)![1]).toEqual(delivery);
    await third.recovery.acknowledge(third.b, callee, delivery.data);
    const fourth = f.process(); await fourth.recovery.replay(fourth.b, callee, 'call');
    expect(fourth.sent).not.toHaveBeenCalled();
  });
  it('rolls back on commit failure, sends no committed receipt or external effect and retries from durable state', async () => {
    const f = fixture(), p = f.process(), op = f.command(), effect = jest.fn(async () => {});
    f.fail(true);
    await p.recovery.execute(p.a, caller, op, async () => { deferCallSdpEffect(effect); });
    expect(effect).not.toHaveBeenCalled(); expect(await f.store.load('circle-a','call')).toBeUndefined();
    expect(p.sent.mock.calls.map(c => c[1].type)).toEqual(['error']);
    expect(p.routes.get('call')).toBeUndefined();
    f.fail(false); const next = f.process(), dispatch = jest.fn(async () => {});
    await next.recovery.execute(next.a, caller, op, dispatch); expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('queues an answer for the exact caller device without a live caller socket', async () => {
    const f = fixture(), first = f.process();
    await first.recovery.execute(first.a, caller, f.command(), async () => {});
    const next = f.process();
    await next.recovery.execute(next.b, callee, f.command('call:answer'), async () => {
      expect(next.recovery.deliverPeer(callee, { type: 'call:answered', data: { callSessionId: 'call', answer: {} }, timestamp: 1 })).toBe(true);
    });
    const resumed = f.process(); await resumed.recovery.replay(resumed.a, caller, 'call');
    expect(resumed.sent.mock.calls.at(-1)![1].type).toBe('call:answered');
  });
  it.each([{ ...callee, deviceId: 'sibling' }, { ...callee, familyId: 'circle-b' }, { ...callee, scopedRemoteIdentityId: 'wrong' }, { ...callee, deviceId: '' }])('refuses unrelated or incomplete selected scope after restart %p', async other => {
    const f = fixture(), p = f.process(), dispatch = jest.fn();
    await p.recovery.execute(p.b, other, f.command('call:answer'), dispatch);
    expect(dispatch).not.toHaveBeenCalled(); expect(await f.store.load(other.familyId,'call')).toBeUndefined();
  });
  it('restores no sockets, preserves already attached endpoints, rejects conflicting selected devices and Circle', () => {
    const routes = new CallSessionRoutingRegistry(); routes.restore('call',route);
    expect(routes.get('call')?.initiatorWs).toBeUndefined(); expect(routes.get('call')?.acceptedTargetWs).toBeUndefined();
    const ws = {} as WebSocket; routes.bindTargetRuntime({ callSessionId: 'call', identityId: 'callee', deviceId: 'selected-callee', ws });
    routes.restore('call',route); expect(routes.get('call')?.acceptedTargetWs).toBe(ws);
    for (const changes of [{ familyId: 'circle-b' }, { acceptedTargetDeviceId: 'sibling' }, { initiatorDeviceId: '' }, { targetIdentityId: 'caller' }]) {
      expect(() => routes.restore('call',{ ...route,...changes })).toThrow('CALL_DURABLE_ROUTE_CONFLICT');
    }
  });
});
