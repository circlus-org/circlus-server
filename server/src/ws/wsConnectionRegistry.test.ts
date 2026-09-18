import type { WebSocket } from 'ws';
import { WsConnectionRegistry } from './wsConnectionRegistry';

const ws1 = {} as WebSocket;
const ws2 = {} as WebSocket;

describe('WebSocket connection registry', () => {
  it('indexes a connection by identity and device', () => {
    const registry = new WsConnectionRegistry();
    registry.register(ws1, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-1'
    }, { trackDevice: true });

    expect(registry.getInfo(ws1)).toEqual(expect.objectContaining({ identityId: 'identity-1' }));
    expect(registry.getIdentitySockets('family-1', 'identity-1')).toEqual(new Set([ws1]));
    expect(registry.getDeviceSockets('device-1')).toEqual(new Set([ws1]));
    expect(registry.getActiveCount()).toBe(1);
  });

  it('keeps identity sockets isolated by family', () => {
    const registry = new WsConnectionRegistry();
    registry.register(ws1, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-1'
    });
    registry.register(ws2, {
      actorType: 'local',
      familyId: 'family-2',
      identityId: 'identity-1',
      deviceId: 'device-2'
    });

    expect(registry.getIdentitySockets('family-1', 'identity-1')).toEqual(new Set([ws1]));
    expect(registry.getIdentitySockets('family-2', 'identity-1')).toEqual(new Set([ws2]));
  });

  it('returns a family-scoped socket snapshot', () => {
    const registry = new WsConnectionRegistry();
    registry.setFamilyContext(ws1, 'family-1');
    registry.setFamilyContext(ws2, 'family-2');

    expect(registry.hasFamilySockets('family-1')).toBe(true);
    expect(registry.getFamilySocketEntries('family-1')).toEqual([[ws1, 'family-1']]);
  });

  it('removes all indexes and presence state atomically', () => {
    const registry = new WsConnectionRegistry();
    registry.setFamilyContext(ws1, 'family-1');
    registry.register(ws1, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-1'
    }, { trackDevice: true });
    registry.setLastSeenTouch(ws1, 123);

    expect(registry.remove(ws1)).toEqual(expect.objectContaining({ deviceId: 'device-1' }));
    expect(registry.getInfo(ws1)).toBeUndefined();
    expect(registry.getIdentitySockets('family-1', 'identity-1')).toBeUndefined();
    expect(registry.getDeviceSockets('device-1')).toBeUndefined();
    expect(registry.getFamilyContext(ws1)).toBeUndefined();
    expect(registry.getLastSeenTouch(ws1)).toBeUndefined();
    expect(registry.getActiveCount()).toBe(0);
  });
});
