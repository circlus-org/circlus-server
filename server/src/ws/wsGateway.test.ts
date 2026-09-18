import fs from 'node:fs';
import path from 'node:path';
import type { WebSocketMessage } from '@shared/types';
import { WsGateway, type WsGatewayImplementation } from './wsGateway';

function implementation(): WsGatewayImplementation {
  return {
    drainFamilySocketsForMigration: jest.fn(async () => 2),
    declineCallViaMobileAction: jest.fn(async () => ({ status: 'declined' as const })),
    sendToDevice: jest.fn(),
    sendToIdentity: jest.fn(),
    sendCallDeliveryStatus: jest.fn(),
    notifyDeviceRevoked: jest.fn(),
    notifyTemporaryDeviceExpired: jest.fn(),
    suspendIdentityAccess: jest.fn(async () => undefined),
    suspendCircleAccess: jest.fn(async () => undefined),
    notifyIdentityServerDataDeleted: jest.fn(),
    notifyCircleServerDataDeleted: jest.fn(),
    sendDirectChatEvent: jest.fn(),
    hasIdentityConnections: jest.fn(() => true),
    sendGroupChatEvent: jest.fn(),
    createHttpCallRuntimeSession: jest.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      messages: []
    })),
    sendHttpCallRuntimeMessage: jest.fn(async () => ({ ok: true as const, messages: [] })),
    pollHttpCallRuntimeMessages: jest.fn(async () => ({ ok: true as const, messages: [] })),
    closeHttpCallRuntimeSession: jest.fn()
  };
}

describe('WsGateway', () => {
  it('keeps routes and services independent from the WebSocket composition root', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const offenders = ['routes', 'services'].flatMap((directory) => (
      fs.readdirSync(path.join(sourceRoot, directory), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => path.join(sourceRoot, directory, entry.name))
        .filter((file) => fs.readFileSync(file, 'utf8').includes('/callHandler'))
    ));

    expect(offenders).toEqual([]);
  });

  it('fails clearly before the WebSocket runtime is configured', () => {
    expect(() => new WsGateway().get()).toThrow('WebSocket gateway is not configured');
  });

  it('exposes the configured implementation', () => {
    const gateway = new WsGateway();
    const configured = implementation();
    gateway.configure(configured);

    const message: WebSocketMessage = { type: 'test', data: {}, timestamp: 1 };
    gateway.get().sendToDevice('device-1', message);

    expect(configured.sendToDevice).toHaveBeenCalledWith('device-1', message);
  });

  it('rejects accidental runtime reconfiguration', () => {
    const gateway = new WsGateway();
    gateway.configure(implementation());
    expect(() => gateway.configure(implementation())).toThrow(
      'WebSocket gateway is already configured'
    );
  });
});
