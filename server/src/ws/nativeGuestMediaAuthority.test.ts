import { nativeCallMediaAuthority } from './nativeCallMediaAuthority';
import type { ExternalConnectionInfo } from './wsConnectionContext';

it.each(['circle-a', 'circle-b'])('binds the external native endpoint in %s without membership or sibling authority', circle => {
  const ws = {} as any, sibling = {} as any;
  const info: ExternalConnectionInfo = { actorType: 'external', identityId: 'guest', deviceId: 'ext:guest',
    familyId: circle, runtimeMode: 'video-native', scopedCallSessionId: `call-${circle}`,
    scopedRemoteIdentityId: 'peer', callRuntimeRole: 'caller', externalPublicKey: { algorithm: 'ed25519', value: 'public' } };
  const route = { familyId: circle, initiatorIdentityId: 'guest', targetIdentityId: 'peer',
    initiatorWs: ws, initiatorDeviceId: 'ext:guest' } as any;
  const params = { ws, info, currentInfo: info, route, callSessionId: `call-${circle}`,
    call: { initiator: 'guest', participants: ['guest', 'peer'] } };
  expect(nativeCallMediaAuthority(params)).toBeUndefined();
  expect(nativeCallMediaAuthority({ ...params, ws: sibling })).toBe('CALL_MEDIA_ENDPOINT_MISMATCH');
  expect(nativeCallMediaAuthority({ ...params, route: { ...route, familyId: 'another-circle' } })).toBe('CALL_MEDIA_ROUTE_MISMATCH');
  expect(nativeCallMediaAuthority({ ...params, info: { ...info, deviceId: '' }, currentInfo: undefined })).toBe('CALL_MEDIA_AUTHORITY_CHANGED');
  expect(nativeCallMediaAuthority({ ...params, route: { ...route, initiatorDeviceId: undefined } })).toBe('CALL_MEDIA_DEVICE_REQUIRED');
  expect(nativeCallMediaAuthority({ ...params, call: { initiator: 'guest', participants: ['guest', 'peer', 'extra'] } })).toBe('CALL_MEDIA_ROUTE_MISMATCH');
});
