import type { WebSocket } from 'ws';
import { CallSessionRoutingRegistry } from './callSessionRoutingRegistry';

function socket(name: string): WebSocket {
  return { name } as unknown as WebSocket;
}

const initiatorWs = socket('initiator');
const firstTargetWs = socket('target-1');
const secondTargetWs = socket('target-2');

function createRegistry() {
  const registry = new CallSessionRoutingRegistry();
  registry.registerInitiator({
    callSessionId: 'call-1',
    familyId: 'family-1',
    initiatorIdentityId: 'caller',
    initiatorWs,
    initiatorDeviceId: 'caller-device',
    targetIdentityId: 'recipient'
  });
  return registry;
}

describe('CallSessionRoutingRegistry', () => {
  it('registers the initiating socket and returns snapshots', () => {
    const registry = createRegistry();
    const route = registry.get('call-1');

    expect(route).toEqual({
      familyId: 'family-1',
      initiatorIdentityId: 'caller',
      initiatorWs,
      initiatorDeviceId: 'caller-device',
      targetIdentityId: 'recipient'
    });
    expect(registry.get('call-1')).not.toBe(route);
  });

  it('keeps the first accepted target when multiple devices answer', () => {
    const registry = createRegistry();

    expect(registry.bindAcceptedTargetIfAbsent({
      callSessionId: 'call-1',
      identityId: 'recipient',
      ws: firstTargetWs,
      deviceId: 'target-device-1'
    }).status).toBe('bound');
    const secondBinding = registry.bindAcceptedTargetIfAbsent({
      callSessionId: 'call-1',
      identityId: 'recipient',
      ws: secondTargetWs,
      deviceId: 'target-device-2'
    });

    expect(secondBinding.status).toBe('already_bound');
    expect(secondBinding.route).toMatchObject({
      acceptedTargetWs: firstTargetWs,
      acceptedTargetDeviceId: 'target-device-1'
    });
  });

  it('allows native runtimes to replace the socket for their own role', () => {
    const registry = createRegistry();
    const nativeInitiatorWs = socket('native-initiator');

    expect(registry.bindInitiatorRuntime({
      callSessionId: 'call-1',
      identityId: 'caller',
      ws: nativeInitiatorWs,
      deviceId: 'caller-native'
    }).status).toBe('bound');
    expect(registry.bindTargetRuntime({
      callSessionId: 'call-1',
      identityId: 'recipient',
      ws: firstTargetWs,
      deviceId: 'target-native'
    }).status).toBe('bound');

    expect(registry.get('call-1')).toMatchObject({
      initiatorWs: nativeInitiatorWs,
      initiatorDeviceId: 'caller-native',
      acceptedTargetWs: firstTargetWs,
      acceptedTargetDeviceId: 'target-native'
    });
  });

  it('ignores closure of a socket that was already replaced by a runtime', () => {
    const registry = createRegistry();
    registry.bindTargetRuntime({
      callSessionId: 'call-1',
      identityId: 'recipient',
      ws: firstTargetWs,
      deviceId: 'target-device-1'
    });
    registry.bindTargetRuntime({
      callSessionId: 'call-1',
      identityId: 'recipient',
      ws: secondTargetWs,
      deviceId: 'target-device-2'
    });

    expect(registry.detachSocket(firstTargetWs)).toEqual([]);
    expect(registry.get('call-1')).toMatchObject({
      acceptedTargetWs: secondTargetWs,
      acceptedTargetDeviceId: 'target-device-2'
    });
  });

  it('rejects runtime binding for the wrong identity', () => {
    const registry = createRegistry();

    expect(registry.bindInitiatorRuntime({
      callSessionId: 'call-1',
      identityId: 'recipient',
      ws: secondTargetWs
    }).status).toBe('identity_mismatch');
    expect(registry.get('call-1')?.initiatorWs).toBe(initiatorWs);
  });

  it('routes signaling only between the initiator and accepted target', () => {
    const registry = createRegistry();
    registry.bindAcceptedTargetIfAbsent({
      callSessionId: 'call-1',
      identityId: 'recipient',
      ws: firstTargetWs
    });

    expect(registry.resolvePeerSocket('call-1', 'caller')).toBe(firstTargetWs);
    expect(registry.resolvePeerSocket('call-1', 'recipient')).toBe(initiatorWs);
    expect(registry.resolvePeerSocket('call-1', 'stranger')).toBeUndefined();
  });

  it('removes the whole route when the initiator disconnects', () => {
    const registry = createRegistry();
    registry.bindAcceptedTargetIfAbsent({
      callSessionId: 'call-1',
      identityId: 'recipient',
      ws: firstTargetWs
    });

    expect(registry.detachSocket(initiatorWs)).toEqual([expect.objectContaining({
      callSessionId: 'call-1',
      role: 'initiator'
    })]);
    expect(registry.get('call-1')).toBeUndefined();
  });

  it('only unbinds the accepted target socket and preserves the accepted device', () => {
    const registry = createRegistry();
    registry.bindAcceptedTargetIfAbsent({
      callSessionId: 'call-1',
      identityId: 'recipient',
      ws: firstTargetWs,
      deviceId: 'target-device-1'
    });

    expect(registry.detachSocket(firstTargetWs)).toEqual([expect.objectContaining({
      callSessionId: 'call-1',
      role: 'accepted_target'
    })]);
    expect(registry.get('call-1')).toEqual({
      familyId: 'family-1',
      initiatorIdentityId: 'caller',
      initiatorWs,
      initiatorDeviceId: 'caller-device',
      targetIdentityId: 'recipient',
      acceptedTargetDeviceId: 'target-device-1'
    });
  });
});
