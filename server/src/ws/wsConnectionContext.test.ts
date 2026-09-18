import { isMessageAllowedForConnection, type LocalConnectionInfo } from './wsConnectionContext';

const nativeRuntime: LocalConnectionInfo = {
  actorType: 'local',
  familyId: 'family-1',
  identityId: 'identity-1',
  deviceId: 'device-1',
  runtimeMode: 'video-native'
};

const directFileRuntime: LocalConnectionInfo = {
  actorType: 'local',
  familyId: 'family-1',
  identityId: 'identity-1',
  deviceId: 'device-1',
  runtimeMode: 'direct-file-native',
  scopedDirectFileTransferSessionId: 'transfer-1',
  scopedRemoteIdentityId: 'identity-2',
  directFileTransferRole: 'sender'
};

describe('WebSocket connection context policy', () => {
  it.each([
    'ping', 'register-call-runtime', 'call:offer', 'call:answer',
    'call:renegotiate-offer', 'call:renegotiate-answer', 'call:ice-candidate',
    'call:video-state', 'call:connected', 'call:heartbeat', 'call:resume', 'call:finalized',
    'call:cancel', 'call:decline', 'call:hangup'
  ])('allows %s on a native call runtime socket', (type) => {
    expect(isMessageAllowedForConnection(nativeRuntime, type)).toBe(true);
  });

  it('rejects unrelated messages on a native call runtime socket', () => {
    expect(isMessageAllowedForConnection(nativeRuntime, 'message:send')).toBe(false);
  });

  it.each([
    'ping', 'register-file-transfer-runtime', 'file-transfer:offer',
    'file-transfer:bootstrap', 'file-transfer:accept', 'file-transfer:reject',
    'file-transfer:ice-candidate', 'file-transfer:complete', 'file-transfer:cancel'
  ])('allows %s on a native direct-file runtime socket', (type) => {
    expect(isMessageAllowedForConnection(directFileRuntime, type)).toBe(true);
  });

  it('rejects unrelated messages on a native direct-file runtime socket', () => {
    expect(isMessageAllowedForConnection(directFileRuntime, 'message:send')).toBe(false);
    expect(isMessageAllowedForConnection(directFileRuntime, 'call:offer')).toBe(false);
  });

  it('does not restrict normal or unauthenticated sockets', () => {
    expect(isMessageAllowedForConnection({ ...nativeRuntime, runtimeMode: 'default' }, 'message:send')).toBe(true);
    expect(isMessageAllowedForConnection(undefined, 'register')).toBe(true);
  });
});

it('keeps an external call identity restricted even after that identity becomes a member', () => {
  const external = { actorType: 'external', identityId: 'new-member', deviceId: 'ext:new-member',
    familyId: 'family', externalPublicKey: { algorithm: 'ed25519', value: 'key' } } as const;
  for (const type of ['call:offer', 'call:ice-candidate', 'call:resume', 'call:hangup', 'register-external', 'ping']) {
    expect(isMessageAllowedForConnection(external, type)).toBe(true);
  }
  for (const type of ['message:send', 'message:sync', 'system:sync', 'register', 'register-call-runtime', 'file-transfer:offer']) {
    expect(isMessageAllowedForConnection(external, type)).toBe(false);
  }
});
