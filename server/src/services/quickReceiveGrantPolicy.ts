import type { DeviceId, IdentityId, PublicKey, QuickReceiveGrant } from '@shared/types';
import { verifySignedRequest } from '../utils/crypto';

export function validateQuickReceiveGrant(params: {
  grant: QuickReceiveGrant | null | undefined;
  senderIdentityId: IdentityId;
  targetIdentityId: IdentityId;
  targetDeviceId: DeviceId;
  fileSize: number;
  targetIdentity: {
    status: string;
    publicKey: PublicKey;
  } | null;
  targetDevice: {
    status: string;
    identityId: IdentityId;
  } | null;
  verify?: (grant: QuickReceiveGrant, publicKey: PublicKey) => boolean;
}): boolean {
  const { grant } = params;
  const payload = grant?.payload;
  const allowedPayloadFields = new Set([
    'version',
    'purpose',
    'grantId',
    'receiverIdentityId',
    'targetDeviceId',
    'authorizedSenderIdentityId',
    'issuedAt',
    'maxFileSizeBytes'
  ]);
  if (
    !grant
    || !payload
    || !params.targetIdentity
    || params.targetIdentity.status !== 'active'
    || params.targetIdentity.publicKey.algorithm !== 'ed25519'
    || !params.targetDevice
    || params.targetDevice.status !== 'active'
    || params.targetDevice.identityId !== params.targetIdentityId
    || grant.type !== 'direct-file:auto-receive-grant'
    || grant.signerId !== params.targetIdentityId
    || payload.version !== 1
    || payload.purpose !== 'direct-file-auto-receive-v1'
    || payload.receiverIdentityId !== params.targetIdentityId
    || payload.targetDeviceId !== params.targetDeviceId
    || payload.authorizedSenderIdentityId !== params.senderIdentityId
    || (!!payload.maxFileSizeBytes && params.fileSize > payload.maxFileSizeBytes)
    || Object.keys(payload).some((field) => !allowedPayloadFields.has(field))
  ) return false;
  return (params.verify || verifySignedRequest)(grant, params.targetIdentity.publicKey);
}
