import type { WebSocket } from 'ws';
import type { ConnectionInfo } from './wsConnectionContext';
import type { CallSessionRoute } from '../services/callSessionRoutingRegistry';

/** Delegated video-native registration v1 selects one call and peer. A valid
 * limited key is not permission to inject media from a replaced runtime. */
export function nativeCallMediaAuthority(params: {
  ws: WebSocket; info: ConnectionInfo; currentInfo: ConnectionInfo | undefined;
  callSessionId: string; route: CallSessionRoute | undefined;
  call: { initiator: string; participants: string[] };
}): string | undefined {
  const { ws, info, currentInfo, callSessionId, route, call } = params;
  if (currentInfo !== info) return 'CALL_MEDIA_AUTHORITY_CHANGED';
  if (info.runtimeMode !== 'video-native') return;
  if (!info.scopedCallSessionId || !info.scopedRemoteIdentityId || !info.deviceId || !info.callRuntimeRole) return 'CALL_MEDIA_SCOPE_REQUIRED';
  if ((info.actorType === 'local' && (info.callRuntimePurpose || info.callsEnabled === false)) || info.scopedCallSessionId !== callSessionId) return 'CALL_MEDIA_SCOPE_MISMATCH';
  if (!route) return 'CALL_MEDIA_ROUTE_REQUIRED';
  if (route.familyId !== info.familyId || call.participants.length !== 2 || new Set(call.participants).size !== 2
      || !call.participants.includes(info.identityId) || !call.participants.includes(info.scopedRemoteIdentityId)
      || call.initiator !== route.initiatorIdentityId) return 'CALL_MEDIA_ROUTE_MISMATCH';
  const caller = info.callRuntimeRole === 'caller';
  if (caller ? route.initiatorIdentityId !== info.identityId || route.targetIdentityId !== info.scopedRemoteIdentityId
    : route.targetIdentityId !== info.identityId || route.initiatorIdentityId !== info.scopedRemoteIdentityId) return 'CALL_MEDIA_PEER_MISMATCH';
  const selectedSocket = caller ? route.initiatorWs : route.acceptedTargetWs;
  const selectedDevice = caller ? route.initiatorDeviceId : route.acceptedTargetDeviceId;
  if (!selectedDevice) return 'CALL_MEDIA_DEVICE_REQUIRED';
  if (selectedDevice !== info.deviceId || selectedSocket !== ws) return 'CALL_MEDIA_ENDPOINT_MISMATCH';
}
