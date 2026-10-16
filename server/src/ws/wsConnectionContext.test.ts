import { nativeCallCommandScopeFailure, callCommandSessionId, nativeCallScopeFailure, isOutboundMessageAllowedForConnection, isIncomingCallRecipient, isMessageAllowedForConnection, type LocalConnectionInfo } from './wsConnectionContext';

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
  const terminal = { ...nativeRuntime, scopedCallSessionId: 'call-a', callRuntimePurpose: 'terminal' as const };
  expect(isIncomingCallRecipient(terminal)).toBe(false);
  for (const type of ['call:cancel', 'call:decline', 'call:hangup', 'ping']) expect(isMessageAllowedForConnection(terminal, type)).toBe(true);
  for (const type of ['register-call-runtime', 'call:offer', 'call:answer', 'call:resume', 'call:ice-config', 'call:ice-candidate', 'message:send']) expect(isMessageAllowedForConnection(terminal, type)).toBe(false);
  for (const type of ['registered', 'pong', 'error', 'call:ended']) expect(isOutboundMessageAllowedForConnection(terminal, type, { callSessionId: 'call-a' })).toBe(true);
  for (const type of ['call:incoming', 'call:answered', 'message:incoming']) expect(isOutboundMessageAllowedForConnection(terminal, type)).toBe(false);
});

describe('native call-runtime v1 explicit command scope', () => {
  const info = { ...nativeRuntime, scopedCallSessionId: 'call-1' };
  it.each(['call:connected', 'call:heartbeat', 'call:finalized'])('uses the declared nested lifecycle format for %s', type => {
    expect(nativeCallCommandScopeFailure(info, type, { payload: { callSessionId: 'call-1' } })).toBeUndefined();
    expect(nativeCallCommandScopeFailure(info, type, { callSessionId: 'call-1', payload: { callSessionId: 'call-1' } })).toBeUndefined();
    expect(nativeCallCommandScopeFailure(info, type, { callSessionId: 'call-1' })?.reason).toBe('CALL_ROUTE_INCOMPLETE');
    expect(nativeCallCommandScopeFailure(info, type, { callSessionId: 'other', payload: { callSessionId: 'call-1' } })?.reason).toBe('CALL_RUNTIME_CALL_MISMATCH');
    expect(nativeCallCommandScopeFailure(info, type, { payload: { callSessionId: 'other' } })?.reason).toBe('CALL_RUNTIME_CALL_MISMATCH');
    expect(callCommandSessionId(type, { callSessionId: 'other' })).toBeUndefined();
  });
  it('does not substitute lifecycle payloads into media/SDP commands or another Circle connection', () => {
    expect(nativeCallCommandScopeFailure(info, 'call:offer', { payload: { callSessionId: 'call-1' } })?.reason).toBe('CALL_ROUTE_INCOMPLETE');
    const otherCircle = { ...info, familyId: 'family-2', identityId: 'identity-2', deviceId: 'device-2', scopedCallSessionId: 'call-2' };
    const data = { payload: { callSessionId: 'call-1' } };
    expect(nativeCallCommandScopeFailure(info, 'call:connected', data)).toBeUndefined();
    expect(nativeCallCommandScopeFailure(otherCircle, 'call:connected', data)?.reason).toBe('CALL_RUNTIME_CALL_MISMATCH');
  });
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

it('keeps native guest sockets confined to their single call and out of general ringing', () => {
  const guest = { actorType: 'external', identityId: 'guest', deviceId: 'ext:guest', familyId: 'family',
    runtimeMode: 'video-native', scopedCallSessionId: 'call-a', scopedRemoteIdentityId: 'peer',
    nativeGuestExpiresAt: Date.now() + 60000, externalPublicKey: { algorithm: 'ed25519', value: 'public' } } as const;
  expect(isIncomingCallRecipient(guest as any)).toBe(false);
  for (const id of [undefined, 'call-b']) {
    expect(isOutboundMessageAllowedForConnection(guest as any, 'call:answered', { callSessionId: id })).toBe(false);
  }
  expect(isOutboundMessageAllowedForConnection(guest as any, 'call:answered', { callSessionId: 'call-a' })).toBe(true);
  expect(isOutboundMessageAllowedForConnection(guest as any, 'message:incoming')).toBe(false);
  expect(nativeCallScopeFailure(guest as any, 'call-b')?.reason).toBe('CALL_RUNTIME_CALL_MISMATCH');
  expect(isMessageAllowedForConnection({ ...guest, nativeGuestExpiresAt: Date.now() - 1 } as any, 'call:offer')).toBe(false);
});

describe('outbound native call-runtime scope', () => {
  const first = { ...nativeRuntime, scopedCallSessionId: 'call-a', scopedRemoteIdentityId: 'peer-a' };
  const second = { ...first, familyId: 'family-2', identityId: 'identity-2', deviceId: 'device-2', scopedCallSessionId: 'call-b' };
  it('keeps two Circles on the same transport origin and two calls of one identity isolated', () => {
    // No origin lookup: the authenticated socket context selects its Circle.
    const contexts = [first, second, { ...first, scopedCallSessionId: 'call-c' },
      { ...first, callRuntimePurpose: 'terminal' as const },
      { ...first, nativeGuestExpiresAt: Date.now() + 60_000 }];
    for (const info of contexts) {
      for (const type of ['call:ended', 'call:delivery-status', 'call:video-state', 'call:ice-candidate', 'call:answered', 'call:resumed', 'call:sdp-committed']) {
        expect(isOutboundMessageAllowedForConnection(info, type, { callSessionId: info.scopedCallSessionId })).toBe(!('callRuntimePurpose' in info) || type === 'call:ended');
        for (const id of ['other-call', undefined, '', null, 1, {}]) {
          expect(isOutboundMessageAllowedForConnection(info, type, { callSessionId: id })).toBe(false);
        }
      }
      for (const type of ['registered', 'pong', 'error']) expect(isOutboundMessageAllowedForConnection(info, type)).toBe(true);
      for (const type of ['message:deliver', 'presence:updated', 'system:event']) expect(isOutboundMessageAllowedForConnection(info, type, {})).toBe(false);
    }
  });
  it('reports bounded field names instead of payloads and never infers a missing bound call', () => {
    const diagnostic = jest.fn();
    expect(isOutboundMessageAllowedForConnection(nativeRuntime, 'call:ended', { token: 'private' }, diagnostic)).toBe(false);
    expect(diagnostic).toHaveBeenLastCalledWith({ reason: 'CALL_ROUTE_INCOMPLETE', missingFields: ['scopedCallSessionId', 'callSessionId'] });
    expect(isOutboundMessageAllowedForConnection(first, 'call:ended', { callSessionId: 'late-old-call', secret: 'private' }, diagnostic)).toBe(false);
    expect(diagnostic).toHaveBeenLastCalledWith({ reason: 'CALL_RUNTIME_CALL_MISMATCH' });
    expect(isOutboundMessageAllowedForConnection({ ...first, nativeGuestExpiresAt: Date.now() - 1 }, 'call:ended', { callSessionId: 'call-a' })).toBe(false);
    const normal = { ...first, runtimeMode: 'default' as const };
    expect(isOutboundMessageAllowedForConnection(normal, 'message:deliver', {})).toBe(true);
    expect(isOutboundMessageAllowedForConnection(normal, 'call:incoming', { callSessionId: 'other' })).toBe(true);
  });
});
