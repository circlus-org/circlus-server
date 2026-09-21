import type { WebSocket } from 'ws';
import { DirectFileTransferSessionRegistry } from './directFileTransferSessionRegistry';
import {
  DirectFileTransferSignalingService,
  type DirectFileTransferConnectionInfo
} from './directFileTransferSignalingService';

const socket = (name: string) => ({ name }) as unknown as WebSocket;

describe('DirectFileTransferSignalingService device routing', () => {
  const sender = socket('sender');
  const receiver = socket('receiver');
  const receiverSecondTab = socket('receiver-second-tab');
  const otherReceiverDevice = socket('other-receiver-device');
  const nativeSender = socket('native-sender');
  const nativeReceiver = socket('native-receiver');
  const messages: Array<{ ws: WebSocket; message: any }> = [];
  const errors: Array<{ ws: WebSocket; code: string }> = [];
  const wakes: Array<{ sessionId: string; targetDeviceId: string }> = [];
  const identityWakes: Array<{ sessionId: string; targetIdentityId: string }> = [];
  const info = new Map<WebSocket, DirectFileTransferConnectionInfo>([
    [sender, { actorType: 'local', familyId: 'family', identityId: 'sender', deviceId: 'sender-device' }],
    [receiver, { actorType: 'local', familyId: 'family', identityId: 'receiver', deviceId: 'target-device' }],
    [receiverSecondTab, { actorType: 'local', familyId: 'family', identityId: 'receiver', deviceId: 'target-device' }],
    [otherReceiverDevice, { actorType: 'local', familyId: 'family', identityId: 'receiver', deviceId: 'other-device' }],
    [nativeSender, {
      actorType: 'local',
      familyId: 'family',
      identityId: 'sender',
      deviceId: 'sender-device',
      runtimeMode: 'direct-file-native',
      scopedDirectFileTransferSessionId: 'native-session',
      scopedRemoteIdentityId: 'receiver',
      directFileTransferRole: 'sender'
    }],
    [nativeReceiver, {
      actorType: 'local',
      familyId: 'family',
      identityId: 'receiver',
      deviceId: 'target-device',
      runtimeMode: 'direct-file-native',
      scopedDirectFileTransferSessionId: 'session',
      scopedRemoteIdentityId: 'sender',
      directFileTransferRole: 'receiver'
    }]
  ]);
  let registry: DirectFileTransferSessionRegistry;
  let service: DirectFileTransferSignalingService;
  let identityOnline = false;
  let identitySockets = new Set<WebSocket>([receiver]);
  let deviceSockets: Set<WebSocket> | undefined;
  let grantValid = true;

  beforeEach(() => {
    messages.length = 0;
    errors.length = 0;
    wakes.length = 0;
    identityWakes.length = 0;
    identityOnline = false;
    identitySockets = new Set([receiver]);
    deviceSockets = undefined;
    grantValid = true;
    registry = new DirectFileTransferSessionRegistry();
    registry.register({
      familyId: 'family',
      initiatorIdentityId: 'sender',
      initiatorWs: sender,
      targetIdentityId: 'receiver',
      targetDeviceId: 'target-device',
      incomingData: {
        sessionId: 'session',
        fromIdentityId: 'sender',
        metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
        offer: { type: 'offer', sdp: 'sdp' }
      },
      expiresAt: Date.now() + 60_000
    });
    service = new DirectFileTransferSignalingService({
      registry,
      getConnectionInfo: (ws) => info.get(ws),
      getIdentitySockets: () => identityOnline ? identitySockets : undefined,
      getDeviceSockets: () => deviceSockets,
      sendMessage: (ws, message) => messages.push({ ws, message }),
      sendError: (ws, code) => errors.push({ ws, code }),
      resolvePublishedIdentityName: async () => 'Sender',
      resolveAccess: async () => ({ allowed: true, relation: 'circle_member' }) as any,
      findIdentity: async (_familyId, identityId) => ({
        identity_id: identityId,
        status: 'active',
        public_key_algorithm: 'ed25519',
        public_key_value: 'public-key'
      }) as any,
      findDevice: async (_familyId, deviceId) => ({
        device_id: deviceId,
        identity_id: deviceId.startsWith('sender') ? 'sender' : 'receiver',
        status: 'active'
      }) as any,
      validateGrant: () => grantValid,
      wakeTargetDevice: async (params) => {
        wakes.push({ sessionId: params.sessionId, targetDeviceId: params.targetDeviceId });
      },
      wakeTargetIdentity: async (params) => {
        identityWakes.push({ sessionId: params.sessionId, targetIdentityId: params.targetIdentityId });
      },
      notifyTargetIdentityResolution: async () => {}
    });
  });

  it('routes an ordinary online offer and wakes the identity on its other devices', async () => {
    identityOnline = true;
    await service.handleOffer(sender, {
      sessionId: 'online-session',
      targetIdentityId: 'receiver',
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });
    expect(messages.at(-1)?.ws).toBe(receiver);
    expect(messages.at(-1)?.message.type).toBe('file-transfer:incoming');
    expect(wakes).toEqual([]);
    expect(identityWakes).toEqual([{ sessionId: 'online-session', targetIdentityId: 'receiver' }]);
  });

  it('validates sender and receiver runtime registration scopes', () => {
    expect(service.validateRuntimeRegistration({
      familyId: 'family',
      identityId: 'sender',
      deviceId: 'sender-device',
      sessionId: 'new-native-session',
      remoteIdentityId: 'receiver',
      role: 'sender'
    })).toBe(true);
    expect(service.validateRuntimeRegistration({
      familyId: 'family',
      identityId: 'receiver',
      deviceId: 'target-device',
      sessionId: 'session',
      remoteIdentityId: 'sender',
      role: 'receiver'
    })).toBe(true);
    expect(service.validateRuntimeRegistration({
      familyId: 'family',
      identityId: 'receiver',
      deviceId: 'other-device',
      sessionId: 'session',
      remoteIdentityId: 'sender',
      role: 'receiver'
    })).toBe(false);
  });

  it('rejects a native sender message outside its registered session scope', async () => {
    await service.handleOffer(nativeSender, {
      sessionId: 'different-session',
      targetIdentityId: 'receiver',
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });
    expect(errors.at(-1)?.code).toBe('FORBIDDEN');
    expect(registry.get('different-session')).toBeUndefined();
  });

  it('allows a native receiver to bootstrap only its registered session', () => {
    service.handleBootstrap(nativeReceiver, { sessionId: 'session' });
    expect(messages.at(-1)?.ws).toBe(nativeReceiver);
    expect(messages.at(-1)?.message.type).toBe('file-transfer:incoming');

    service.handleBootstrap(nativeReceiver, { sessionId: 'other-session' });
    expect(errors.at(-1)?.code).toBe('FORBIDDEN');
  });

  it('keeps an ordinary offline offer and lets a pushed device bootstrap it', async () => {
    await service.handleOffer(sender, {
      sessionId: 'offline-session',
      targetIdentityId: 'receiver',
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });

    expect(messages).toEqual([]);
    expect(identityWakes).toEqual([{ sessionId: 'offline-session', targetIdentityId: 'receiver' }]);
    expect(registry.get('offline-session')).toBeDefined();

    service.handleBootstrap(otherReceiverDevice, { sessionId: 'offline-session' });
    expect(messages.at(-1)?.ws).toBe(otherReceiverDevice);
    expect(messages.at(-1)?.message.type).toBe('file-transfer:incoming');
  });

  it('re-sends the same pending request when the addressed device comes online', async () => {
    deviceSockets = new Set([receiver]);

    await service.handleRenotify(sender, { sessionId: 'session' });

    expect(messages).toEqual([
      expect.objectContaining({
        ws: receiver,
        message: expect.objectContaining({
          type: 'file-transfer:incoming',
          data: expect.objectContaining({ sessionId: 'session' })
        })
      })
    ]);
    expect(registry.get('session')).toBeDefined();
    expect(wakes).toEqual([]);
  });

  it('keeps a quick offer for bootstrap and wakes only the addressed sleeping device', async () => {
    await service.handleOffer(sender, {
      sessionId: 'sleeping-session',
      targetIdentityId: 'receiver',
      targetDeviceId: 'target-device',
      autoReceiveGrant: {
        type: 'direct-file:auto-receive-grant',
        timestamp: 1,
        nonce: 'nonce',
        signerId: 'receiver',
        signature: 'signature',
        payload: {
          version: 1,
          purpose: 'direct-file-auto-receive-v1',
          grantId: 'grant',
          receiverIdentityId: 'receiver',
          targetDeviceId: 'target-device',
          authorizedSenderIdentityId: 'sender',
          issuedAt: new Date(0).toISOString()
        }
      },
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });
    expect(wakes).toEqual([{ sessionId: 'sleeping-session', targetDeviceId: 'target-device' }]);
    expect(registry.get('sleeping-session')).toBeDefined();
  });

  it('rejects a sleeping-device offer before wake-up when the grant is invalid', async () => {
    grantValid = false;
    await service.handleOffer(sender, {
      sessionId: 'invalid-session',
      targetIdentityId: 'receiver',
      targetDeviceId: 'target-device',
      autoReceiveGrant: {} as any,
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });
    expect(errors.at(-1)?.code).toBe('FORBIDDEN');
    expect(wakes).toEqual([]);
    expect(registry.get('invalid-session')).toBeUndefined();
  });

  it('fans one quick-receive request out to every authorized device without exposing a device choice', async () => {
    const grantFor = (targetDeviceId: string) => ({
      type: 'direct-file:auto-receive-grant' as const,
      timestamp: 1,
      nonce: `nonce-${targetDeviceId}`,
      signerId: 'receiver',
      signature: `signature-${targetDeviceId}`,
      payload: {
        version: 1 as const,
        purpose: 'direct-file-auto-receive-v1' as const,
        grantId: `grant-${targetDeviceId}`,
        receiverIdentityId: 'receiver',
        targetDeviceId,
        authorizedSenderIdentityId: 'sender',
        issuedAt: new Date(0).toISOString()
      }
    });
    await service.handleOffer(sender, {
      sessionId: 'multi-quick-session',
      targetIdentityId: 'receiver',
      quickTargets: [
        { targetDeviceId: 'target-device', autoReceiveGrant: grantFor('target-device') },
        { targetDeviceId: 'other-device', autoReceiveGrant: grantFor('other-device') }
      ],
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });

    expect(wakes).toEqual([
      { sessionId: 'multi-quick-session', targetDeviceId: 'target-device' },
      { sessionId: 'multi-quick-session', targetDeviceId: 'other-device' }
    ]);
    service.handleBootstrap(otherReceiverDevice, { sessionId: 'multi-quick-session' });
    expect(messages.at(-1)?.message.data).toMatchObject({
      targetDeviceId: 'other-device',
      autoReceiveGrant: { payload: { targetDeviceId: 'other-device' } }
    });
  });

  it('allows an exact manual target for another device of the same identity without a grant', async () => {
    grantValid = false;
    await service.handleOffer(sender, {
      sessionId: 'manual-self-session',
      targetIdentityId: 'sender',
      targetDeviceId: 'sender-target-device',
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });
    expect(errors).toEqual([]);
    expect(wakes).toEqual([{ sessionId: 'manual-self-session', targetDeviceId: 'sender-target-device' }]);
    expect(registry.get('manual-self-session')?.incomingData.autoReceiveGrant).toBeUndefined();
  });

  it('still requires a grant when another identity addresses a concrete device', async () => {
    grantValid = false;
    await service.handleOffer(sender, {
      sessionId: 'manual-contact-session',
      targetIdentityId: 'receiver',
      targetDeviceId: 'target-device',
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });
    expect(errors.at(-1)?.code).toBe('FORBIDDEN');
    expect(wakes).toEqual([]);
  });

  it('includes only the source device id when a file is sent to the same identity', async () => {
    await service.handleOffer(sender, {
      sessionId: 'self-session',
      targetIdentityId: 'sender',
      targetDeviceId: 'sender-target-device',
      autoReceiveGrant: {} as any,
      metadata: { fileName: 'photo.png', size: 10, mimeType: 'image/png' },
      offer: { type: 'offer', sdp: 'sdp' }
    });

    expect(registry.get('self-session')?.incomingData).toMatchObject({
      fromDeviceId: 'sender-device'
    });
    expect(registry.get('self-session')?.incomingData).not.toHaveProperty('fromDeviceLabel');

    identityOnline = true;
    await service.handleOffer(sender, {
      sessionId: 'contact-session',
      targetIdentityId: 'receiver',
      metadata: { fileName: 'photo.png', size: 10, mimeType: 'image/png' },
      offer: { type: 'offer', sdp: 'sdp' }
    });
    expect(registry.get('contact-session')?.incomingData.fromDeviceId).toBeUndefined();
  });

  it('allows only the addressed device to accept a quick transfer', () => {
    service.handleAccept(otherReceiverDevice, { sessionId: 'session', answer: { type: 'answer' } });
    expect(errors).toEqual([{ ws: otherReceiverDevice, code: 'FORBIDDEN' }]);
    expect(messages).toHaveLength(0);

    service.handleAccept(receiver, {
      sessionId: 'session',
      answer: { type: 'answer' },
      transferProtocolVersion: 2
    });
    expect(messages.at(-1)?.ws).toBe(sender);
    expect(messages.at(-1)?.message.type).toBe('file-transfer:accepted');
    expect(messages.at(-1)?.message.data.transferProtocolVersion).toBe(2);
  });

  it('forwards only the winning device ICE candidates collected before acceptance', () => {
    service.handleIceCandidate(receiverSecondTab, {
      sessionId: 'session',
      candidate: { candidate: 'losing-tab' }
    });
    service.handleIceCandidate(receiver, {
      sessionId: 'session',
      candidate: { candidate: 'winning-tab' }
    });
    expect(messages).toEqual([]);

    service.handleAccept(receiver, { sessionId: 'session', answer: { type: 'answer' } });
    const senderCandidates = messages.filter((entry) => (
      entry.ws === sender && entry.message.type === 'file-transfer:ice-candidate'
    ));
    expect(senderCandidates).toHaveLength(1);
    expect(senderCandidates[0]?.message.data.candidate).toEqual({ candidate: 'winning-tab' });
  });

  it('ignores a duplicate accept and closes an accept from another tab of the same device', () => {
    service.handleAccept(receiver, { sessionId: 'session', answer: { type: 'answer' } });
    service.handleAccept(receiver, { sessionId: 'session', answer: { type: 'duplicate-answer' } });
    service.handleAccept(receiverSecondTab, { sessionId: 'session', answer: { type: 'other-tab-answer' } });

    expect(messages.filter((entry) => entry.ws === sender && entry.message.type === 'file-transfer:accepted')).toHaveLength(1);
    expect(messages.at(-1)?.ws).toBe(receiverSecondTab);
    expect(messages.at(-1)?.message).toMatchObject({
      type: 'file-transfer:rejected',
      data: { sessionId: 'session', reason: 'accepted_on_another_tab' }
    });
    expect(errors).toEqual([]);
  });

  it('forwards durable receiver completion to the sender and retires the signaling session', () => {
    service.handleAccept(receiver, {
      sessionId: 'session',
      answer: { type: 'answer' },
      transferProtocolVersion: 2
    });
    messages.length = 0;

    service.handleComplete(receiver, { sessionId: 'session', receivedBytes: 10 });

    expect(messages).toEqual([
      expect.objectContaining({
        ws: sender,
        message: expect.objectContaining({
          type: 'file-transfer:completed',
          data: { sessionId: 'session', receivedBytes: 10 }
        })
      }),
      expect.objectContaining({
        ws: receiver,
        message: expect.objectContaining({
          type: 'file-transfer:completed',
          data: { sessionId: 'session', receivedBytes: 10 }
        })
      })
    ]);
    expect(registry.get('session')).toBeUndefined();
    service.handleSocketClosed(receiver);
    expect(messages).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('treats an explicit rejection on one device as rejection for the whole request', async () => {
    identityOnline = true;
    identitySockets = new Set([receiver, otherReceiverDevice]);
    await service.handleOffer(sender, {
      sessionId: 'reject-session',
      targetIdentityId: 'receiver',
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });
    messages.length = 0;

    service.handleReject(receiver, { sessionId: 'reject-session', reason: 'rejected_by_user' });

    expect(registry.get('reject-session')).toBeUndefined();
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ws: sender,
        message: expect.objectContaining({ type: 'file-transfer:rejected' })
      }),
      expect.objectContaining({
        ws: otherReceiverDevice,
        message: expect.objectContaining({
          type: 'file-transfer:rejected',
          data: { sessionId: 'reject-session', reason: 'rejected_on_another_device' }
        })
      })
    ]));
  });

  it('immediately delivers a browser rejection to the native sender socket', async () => {
    identityOnline = true;
    await service.handleOffer(nativeSender, {
      sessionId: 'native-session',
      targetIdentityId: 'receiver',
      metadata: { fileName: 'file.bin', size: 10, mimeType: 'application/octet-stream' },
      offer: { type: 'offer', sdp: 'sdp' }
    });
    messages.length = 0;
    service.handleReject(receiver, { sessionId: 'native-session', reason: 'rejected_by_user' });
    expect(messages).toContainEqual({
      ws: nativeSender,
      message: expect.objectContaining({
        type: 'file-transfer:rejected',
        data: { sessionId: 'native-session', reason: 'rejected_by_user' }
      })
    });
    expect(registry.get('native-session')).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('rejects ICE and cancellation from another device of the target identity', () => {
    service.handleIceCandidate(otherReceiverDevice, {
      sessionId: 'session',
      candidate: { candidate: 'candidate' }
    });
    service.handleCancel(otherReceiverDevice, { sessionId: 'session', reason: 'cancelled' });
    expect(errors.map((entry) => entry.code)).toEqual(['FORBIDDEN', 'FORBIDDEN']);
    expect(registry.get('session')).toBeDefined();
  });

  it('cleans the session and notifies the peer when a bound socket closes', () => {
    service.handleAccept(receiver, { sessionId: 'session', answer: { type: 'answer' } });
    messages.length = 0;
    service.handleSocketClosed(receiver);
    expect(registry.get('session')).toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ws).toBe(sender);
    expect(messages[0]?.message.data.reason).toBe('peer_disconnected');
  });
});
