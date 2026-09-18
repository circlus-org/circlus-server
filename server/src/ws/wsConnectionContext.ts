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
  clientRuntime?: 'web' | 'android_webview';
  scopedCallSessionId?: CallSessionId;
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
  if (info?.actorType === 'external') {
    return messageType === 'register-external'
      || (messageType !== 'register-call-runtime' && NATIVE_CALL_RUNTIME_MESSAGE_TYPES.has(messageType));
  }
  if (!info) return true;
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
  return info?.actorType !== 'external' || messageType.startsWith('call:')
    || ['registered', 'pong', 'error'].includes(messageType);
}
