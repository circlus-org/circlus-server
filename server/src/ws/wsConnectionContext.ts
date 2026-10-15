import type {
  CallSessionId,
  DeviceId,
  DirectFileTransferSessionId,
  FileTransferRuntimeRole,
  IdentityId
} from '@shared/types';
import type { LinkCapabilityDescriptor, LinkCapabilityProof } from '@shared/linkCapability';

export type LocalConnectionInfo = {
  actorType: 'local';
  identityId: IdentityId;
  deviceId: DeviceId;
  familyId: string;
  isTemporaryDevice?: boolean;
  runtimeMode?: 'default' | 'video-native' | 'direct-file-native';
  clientRuntime?: 'web' | 'android_webview' | 'ios_webview';
  /** Authenticated ws:register payload. Absent retains existing client behavior. */
  callsEnabled?: boolean;
  scopedCallSessionId?: CallSessionId;
  callRuntimePurpose?: 'terminal';
  callRuntimeRole?: 'caller' | 'callee';
  sdpRecoveryVersion?: 1;
  scopedDirectFileTransferSessionId?: DirectFileTransferSessionId;
  scopedRemoteIdentityId?: IdentityId;
  directFileTransferRole?: FileTransferRuntimeRole;
};

export type ExternalConnectionInfo = {
  actorType: 'external';
  identityId: IdentityId;
  deviceId: DeviceId;
  familyId: string;
  externalPublicKey: {
    algorithm: 'ed25519' | 'x25519';
    value: string;
  };
  externalDisplayName?: string;
  callGrant?: {
    kind: 'call_link' | 'whitelist_key';
    admissionId: string;
    targetIdentityId: IdentityId;
    callLinkTitle?: string | null;
    capabilityGrant?: {
      descriptor: LinkCapabilityDescriptor;
      proof: LinkCapabilityProof;
    };
  };
};

export type ConnectionInfo = LocalConnectionInfo | ExternalConnectionInfo;

/** Native call-runtime registration v1 never authorizes an unscoped command. */
export function nativeCallScopeFailure(info: ConnectionInfo | undefined, callSessionId: unknown): {
  reason: string; missingFields?: string[];
} | undefined {
  if (info?.actorType !== 'local' || info.runtimeMode !== 'video-native') return;
  const missingFields = [
    ...(!info.scopedCallSessionId ? ['scopedCallSessionId'] : []),
    ...(typeof callSessionId !== 'string' || !callSessionId.trim() ? ['callSessionId'] : [])
  ];
  if (missingFields.length) return { reason: 'CALL_ROUTE_INCOMPLETE', missingFields };
  if (info.scopedCallSessionId !== callSessionId) return { reason: 'CALL_RUNTIME_CALL_MISMATCH' };
}

/** The existing lifecycle wire contract carries its authority in payload;
 * SDP/media commands carry it directly. Never substitute between formats. */
export function callCommandSessionId(type: string, data: any): unknown {
  return ['call:connected', 'call:heartbeat', 'call:finalized'].includes(type)
    ? data?.payload?.callSessionId : data?.callSessionId;
}

export function nativeCallCommandScopeFailure(info: ConnectionInfo | undefined, type: string, data: any) {
  const callSessionId = callCommandSessionId(type, data);
  const failure = nativeCallScopeFailure(info, callSessionId);
  if (failure) return failure;
  if (info?.actorType === 'local' && info.runtimeMode === 'video-native'
      && ['call:connected', 'call:heartbeat', 'call:finalized'].includes(type)
      && data?.callSessionId !== undefined && data.callSessionId !== callSessionId) {
    return { reason: 'CALL_RUNTIME_CALL_MISMATCH' };
  }
}

export function isIncomingCallRecipient(info: ConnectionInfo | undefined): boolean {
  return Boolean(info && (info.actorType !== 'local' || (info.callsEnabled !== false && info.callRuntimePurpose !== 'terminal')));
}

const NATIVE_CALL_RUNTIME_MESSAGE_TYPES = new Set([
  'ping',
  'register-call-runtime',
  'call:offer',
  'call:answer',
  'call:renegotiate-offer',
  'call:renegotiate-answer',
  'call:ice-candidate',
  'call:video-state',
  'call:connected',
  'call:heartbeat',
  'call:resume',
  'call:sdp-ack',
  'call:ice-config',
  'call:finalized',
  'call:cancel',
  'call:decline',
  'call:hangup'
]);

const NATIVE_DIRECT_FILE_RUNTIME_MESSAGE_TYPES = new Set([
  'ping',
  'register-file-transfer-runtime',
  'file-transfer:offer',
  'file-transfer:bootstrap',
  'file-transfer:renotify',
  'file-transfer:accept',
  'file-transfer:reject',
  'file-transfer:ice-candidate',
  'file-transfer:complete',
  'file-transfer:cancel'
]);

export function isMessageAllowedForConnection(
  info: ConnectionInfo | undefined,
  messageType: string
): boolean {
  if (info?.actorType === 'local' && info.callsEnabled === false
      && (messageType.startsWith('call:') || messageType === 'register-call-runtime')) return false;
  if (info?.actorType === 'external') {
    return messageType === 'register-external'
      || (messageType !== 'register-call-runtime' && NATIVE_CALL_RUNTIME_MESSAGE_TYPES.has(messageType));
  }
  if (!info) return true;
  if (info.actorType === 'local' && info.callRuntimePurpose === 'terminal') {
    return ['ping', 'call:cancel', 'call:decline', 'call:hangup'].includes(messageType);
  }
  if (info.runtimeMode === 'video-native') {
    return NATIVE_CALL_RUNTIME_MESSAGE_TYPES.has(messageType);
  }
  if (info.runtimeMode === 'direct-file-native') {
    return NATIVE_DIRECT_FILE_RUNTIME_MESSAGE_TYPES.has(messageType);
  }
  return true;
}

/** Registering the same identity as a member never upgrades its old call socket. */
export function isOutboundMessageAllowedForConnection(info: ConnectionInfo | undefined, messageType: string): boolean {
  if (info?.actorType === 'local' && info.callRuntimePurpose === 'terminal') {
    return ['registered', 'pong', 'error', 'call:ended'].includes(messageType);
  }
  if (info?.actorType === 'local' && info.callsEnabled === false && messageType.startsWith('call:')) return false;
  return info?.actorType !== 'external' || messageType.startsWith('call:')
    || ['registered', 'pong', 'error'].includes(messageType);
}
