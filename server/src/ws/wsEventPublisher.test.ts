import type { WebSocket } from 'ws';
import { WsConnectionRegistry } from './wsConnectionRegistry';
import { WsEventPublisher, type WsEventPublisherDependencies } from './wsEventPublisher';

function socket() {
  return { close: jest.fn() } as unknown as WebSocket;
}

function harness() {
  const registry = new WsConnectionRegistry();
  const logger = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn()
  };
  const dependencies: WsEventPublisherDependencies = {
    registry,
    sendMessage: jest.fn(),
    sendToSet: jest.fn(),
    sendError: jest.fn(),
    hasTemporaryChatAccess: jest.fn(async () => true),
    logger: logger as any,
    now: () => 123
  };
  return { dependencies, logger, publisher: new WsEventPublisher(dependencies), registry };
}

describe('WebSocket event publisher', () => {
  it('routes identity events through the tenant-scoped registry bucket', () => {
    const ws = socket();
    const { publisher, registry, dependencies } = harness();
    registry.register(ws, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-1'
    });
    const message = { type: 'event', data: {}, timestamp: 1 };

    publisher.sendToIdentity('family-1', 'identity-1', message);

    expect(dependencies.sendToSet).toHaveBeenCalledWith(new Set([ws]), message);
    publisher.sendToIdentity('family-2', 'identity-1', message);
    expect(dependencies.sendToSet).toHaveBeenLastCalledWith(undefined, message);
  });

  it('publishes the existing call delivery status envelope', () => {
    const { publisher, dependencies } = harness();
    publisher.sendCallDeliveryStatus({
      familyId: 'family-1',
      callerIdentityId: 'identity-1',
      callSessionId: 'call-1',
      status: 'delivered',
      occurredAt: 100
    });
    expect(dependencies.sendToSet).toHaveBeenCalledWith(undefined, {
      type: 'call:delivery-status',
      data: {
        callSessionId: 'call-1',
        status: 'delivered',
        reason: undefined,
        occurredAt: 100
      },
      timestamp: 123
    });
  });

  it('notifies and closes every socket of a revoked device', () => {
    const ws = socket();
    const { publisher, registry, dependencies } = harness();
    registry.register(ws, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-1'
    }, { trackDevice: true });

    publisher.notifyDeviceRevoked('device-1', 'identity-1');

    expect(dependencies.sendError).toHaveBeenCalledWith(
      ws,
      'DEVICE_REVOKED',
      'Device has been revoked'
    );
    expect(ws.close).toHaveBeenCalledWith(4001, 'Device revoked');
  });

  it('notifies and closes every socket of a suspended identity', () => {
    const ws = socket();
    const { publisher, registry, dependencies } = harness();
    registry.register(ws, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-1'
    });

    publisher.notifyIdentitySuspended('family-1', 'identity-1');

    expect(dependencies.sendError).toHaveBeenCalledWith(
      ws,
      'IDENTITY_SUSPENDED',
      'Identity is suspended'
    );
    expect(ws.close).toHaveBeenCalledWith(4003, 'Identity suspended');
  });

  it('notifies and closes every socket of a suspended Circle', () => {
    const memberWs = socket();
    const otherFamilyWs = socket();
    const { publisher, registry, dependencies } = harness();
    registry.register(memberWs, {
      actorType: 'local', familyId: 'family-1', identityId: 'identity-1', deviceId: 'device-1'
    });
    registry.register(otherFamilyWs, {
      actorType: 'local', familyId: 'family-2', identityId: 'identity-2', deviceId: 'device-2'
    });
    registry.setFamilyContext(memberWs, 'family-1');
    registry.setFamilyContext(otherFamilyWs, 'family-2');

    publisher.notifyCircleSuspended('family-1');

    expect(dependencies.sendError).toHaveBeenCalledWith(
      memberWs,
      'CIRCLE_SUSPENDED',
      'Circle is suspended'
    );
    expect(memberWs.close).toHaveBeenCalledWith(4004, 'Circle suspended');
    expect(otherFamilyWs.close).not.toHaveBeenCalled();
  });

  it('excludes the requesting device from identity deletion notifications', () => {
    const excludedWs = socket();
    const notifiedWs = socket();
    const { publisher, registry, dependencies } = harness();
    registry.register(excludedWs, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-excluded'
    });
    registry.register(notifiedWs, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-notified'
    });

    publisher.notifyIdentityServerDataDeleted(
      'family-1',
      'identity-1',
      'device-excluded'
    );

    expect(dependencies.sendMessage).toHaveBeenCalledTimes(1);
    expect(dependencies.sendMessage).toHaveBeenCalledWith(
      notifiedWs,
      expect.objectContaining({ type: 'identity:server-data-deleted' })
    );
    expect(excludedWs.close).not.toHaveBeenCalled();
    expect(notifiedWs.close).toHaveBeenCalled();
  });

  it('notifies every connected identity when a Circle is deleted', () => {
    const excludedWs = socket();
    const memberWs = socket();
    const otherFamilyWs = socket();
    const { publisher, registry, dependencies } = harness();
    registry.register(excludedWs, {
      actorType: 'local', familyId: 'family-1', identityId: 'owner-1', deviceId: 'owner-device'
    });
    registry.register(memberWs, {
      actorType: 'local', familyId: 'family-1', identityId: 'member-1', deviceId: 'member-device'
    });
    registry.register(otherFamilyWs, {
      actorType: 'local', familyId: 'family-2', identityId: 'member-2', deviceId: 'other-device'
    });
    registry.setFamilyContext(excludedWs, 'family-1');
    registry.setFamilyContext(memberWs, 'family-1');
    registry.setFamilyContext(otherFamilyWs, 'family-2');

    publisher.notifyCircleServerDataDeleted('family-1', 'owner-device');

    expect(dependencies.sendMessage).toHaveBeenCalledTimes(1);
    expect(dependencies.sendMessage).toHaveBeenCalledWith(
      memberWs,
      expect.objectContaining({
        type: 'identity:server-data-deleted',
        data: { identityId: 'member-1', scope: 'circle' }
      })
    );
    expect(memberWs.close).toHaveBeenCalled();
    expect(excludedWs.close).not.toHaveBeenCalled();
    expect(otherFamilyWs.close).not.toHaveBeenCalled();
  });

  it('filters direct-chat events for a temporary device by its chat scope', async () => {
    const trustedWs = socket();
    const temporaryWs = socket();
    const { publisher, registry, dependencies } = harness();
    registry.register(trustedWs, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-trusted'
    });
    registry.register(temporaryWs, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-temporary',
      isTemporaryDevice: true
    });
    (dependencies.hasTemporaryChatAccess as jest.Mock).mockResolvedValue(false);
    const message = { type: 'message', data: {}, timestamp: 1 };

    publisher.sendDirectChatEvent('family-1', 'identity-1', 'chat-1', message);
    await Promise.resolve();

    expect(dependencies.sendMessage).toHaveBeenCalledWith(trustedWs, message);
    expect(dependencies.sendMessage).not.toHaveBeenCalledWith(temporaryWs, message);
    expect(dependencies.hasTemporaryChatAccess).toHaveBeenCalledWith(
      'family-1',
      'device-temporary',
      'chat-1',
      'direct'
    );
  });

  it('logs temporary chat access lookup failures with routing context', async () => {
    const temporaryWs = socket();
    const failure = new Error('lookup failed');
    const { publisher, registry, dependencies, logger } = harness();
    registry.register(temporaryWs, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-temporary',
      isTemporaryDevice: true
    });
    (dependencies.hasTemporaryChatAccess as jest.Mock).mockRejectedValue(failure);

    publisher.sendDirectChatEvent('family-1', 'identity-1', 'chat-1', {
      type: 'message:deliver',
      data: {},
      timestamp: 1
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      'ws_temporary_chat_access_check_failed',
      expect.objectContaining({
        familyId: 'family-1',
        identityId: 'identity-1',
        deviceId: 'device-temporary',
        chatId: 'chat-1',
        chatType: 'direct',
        error: failure
      })
    );
  });

  it('does not reveal group reaction targets to temporary devices without chat access', async () => {
    const temporaryWs = socket();
    const { publisher, registry, dependencies } = harness();
    registry.register(temporaryWs, { actorType: 'local', familyId: 'family-1', identityId: 'identity-1',
      deviceId: 'temporary', isTemporaryDevice: true });
    (dependencies.hasTemporaryChatAccess as jest.Mock).mockResolvedValue(false);
    publisher.sendGroupChatEvent({ familyId: 'family-1', participantIdentityIds: ['identity-1'],
      eventType: 'message:reactions-updated', payload: { scope: 'group', chatId: 'group-1', messageId: 'message-1' } });
    await Promise.resolve();
    expect(dependencies.sendMessage).not.toHaveBeenCalled();
    expect(dependencies.hasTemporaryChatAccess).toHaveBeenCalledWith('family-1', 'temporary', 'group-1', 'group');
  });

  it('deduplicates group participants before publishing', () => {
    const ws = socket();
    const { publisher, registry, dependencies } = harness();
    registry.register(ws, {
      actorType: 'local',
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-1'
    });

    publisher.sendGroupChatEvent({
      familyId: 'family-1',
      participantIdentityIds: ['identity-1', 'identity-1'],
      eventType: 'group:chat-updated',
      payload: { chatId: 'group-1' } as any
    });

    expect(dependencies.sendMessage).toHaveBeenCalledTimes(1);
  });
});
