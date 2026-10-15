import { nativeCallScopeFailure, isOutboundMessageAllowedForConnection, isIncomingCallRecipient, isMessageAllowedForConnection, type LocalConnectionInfo } from './wsConnectionContext';

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
    'call:video-state', 'call:connected', 'call:heartbeat', 'call:resume', 'call:ice-config', 'call:finalized',
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


describe('authenticated no-call app sessions', () => {
  it('blocks call signaling while preserving message and direct-file traffic', () => {
    const info = { ...nativeRuntime, runtimeMode: 'default' as const, callsEnabled: false };
    for (const type of ['call:offer', 'call:answer', 'call:ice-candidate', 'register-call-runtime']) {
      expect(isMessageAllowedForConnection(info, type)).toBe(false);
    }
    for (const type of ['message:send', 'system:sync', 'file-transfer:offer', 'ping']) {
      expect(isMessageAllowedForConnection(info, type)).toBe(true);
    }
  });
  it('keeps call permission specific to the exact connection and Circle', () => {
    const noCalls = { ...nativeRuntime, runtimeMode: 'default' as const, callsEnabled: false };
    const sameIdentityOtherDevice = { ...noCalls, deviceId: 'device-2', callsEnabled: true };
    const otherCircle = { ...sameIdentityOtherDevice, familyId: 'family-2' };
    expect(isIncomingCallRecipient(noCalls)).toBe(false);
    expect(isIncomingCallRecipient(sameIdentityOtherDevice)).toBe(true);
    expect(isIncomingCallRecipient(otherCircle)).toBe(true);
    expect(isIncomingCallRecipient(undefined)).toBe(false);
  });
});

it('terminal runtime cannot receive incoming calls, bind media, resume or send messages', () => {
  const terminal = { ...nativeRuntime, callRuntimePurpose: 'terminal' as const };
  expect(isIncomingCallRecipient(terminal)).toBe(false);
  for (const type of ['call:cancel', 'call:decline', 'call:hangup', 'ping']) expect(isMessageAllowedForConnection(terminal, type)).toBe(true);
  for (const type of ['register-call-runtime', 'call:offer', 'call:answer', 'call:resume', 'call:ice-config', 'call:ice-candidate', 'message:send']) expect(isMessageAllowedForConnection(terminal, type)).toBe(false);
  for (const type of ['registered', 'pong', 'error', 'call:ended']) expect(isOutboundMessageAllowedForConnection(terminal, type)).toBe(true);
  for (const type of ['call:incoming', 'call:answered', 'message:incoming']) expect(isOutboundMessageAllowedForConnection(terminal, type)).toBe(false);
});

describe('native call-runtime v1 explicit command scope', () => {
  const info = { ...nativeRuntime, scopedCallSessionId: 'call-1' };
  it.each([undefined, null, '', '  ', 1, {}, ['call-1']])('rejects absent or malformed call ID %p', id => {
    expect(nativeCallScopeFailure(info, id)).toEqual({ reason: 'CALL_ROUTE_INCOMPLETE', missingFields: ['callSessionId'] });
  });
  it('does not infer a missing registered call from the command', () => {
    expect(nativeCallScopeFailure(nativeRuntime, 'call-1')).toEqual({ reason: 'CALL_ROUTE_INCOMPLETE', missingFields: ['scopedCallSessionId'] });
  });
  it('requires an exact registered call ID', () => {
    expect(nativeCallScopeFailure(info, 'call-2')).toEqual({ reason: 'CALL_RUNTIME_CALL_MISMATCH' });
    expect(nativeCallScopeFailure(info, 'call-1')).toBeUndefined();
  });
  it('retains the separate general WebSocket protocol', () => {
    expect(nativeCallScopeFailure({ ...info, runtimeMode: 'default' }, undefined)).toBeUndefined();
  });
});
