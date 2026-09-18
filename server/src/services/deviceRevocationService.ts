import type {
  DeviceId,
  DeviceLocalCircleDataDeletionAuthorization,
  IdentityId
} from '../../../shared/types';
import { transaction } from '../db';
import {
  deviceRepository,
  identityRepository,
  trustedDeviceRekeyRepository
} from '../db/repositories';
import { verifySignedRequest } from '../utils/crypto';
import { notifyDeviceRevoked } from '../ws/wsGateway';
import { requestTrustedDeviceRekeyProcessing } from './trustedDeviceRekeyService';

const LOCAL_DELETION_AUTHORIZATION_TYPE = 'identity:device-local-circle-data-deletion-after-revoke';
const LOCAL_DELETION_AUTHORIZATION_MAX_AGE_MS = 5 * 60 * 1000;
const LOCAL_DELETION_AUTHORIZATION_MAX_FUTURE_SKEW_MS = 30 * 1000;

export class IdentityDeviceRevocationError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_STATE' | 'INVALID_SIGNATURE',
    message: string
  ) {
    super(message);
  }
}

export async function commitDeviceRevocation(params: {
  familyId: string;
  deviceId: DeviceId;
  identityId: IdentityId;
  localDeletionAuthorization?: DeviceLocalCircleDataDeletionAuthorization;
  inactivityGuard?: {
    inactiveBefore: Date;
    warningBefore: Date;
  };
}) {
  const outcome = await transaction(async (client) => {
    const revoked = params.inactivityGuard
      ? await deviceRepository.revokeForInactivity(
          params.familyId,
          params.deviceId,
          params.inactivityGuard.inactiveBefore,
          params.inactivityGuard.warningBefore,
          client
        )
      : await deviceRepository.revoke(params.familyId, params.deviceId, client);
    if (!revoked) return null;
    const rekey = await trustedDeviceRekeyRepository.enqueue(client, {
      familyId: params.familyId,
      identityId: params.identityId,
      deviceId: params.deviceId,
      reason: 'device_revoked'
    });
    return { rekey };
  });
  if (!outcome) return null;

  if (params.localDeletionAuthorization) {
    notifyDeviceRevoked(params.deviceId, params.identityId, params.localDeletionAuthorization);
  } else {
    notifyDeviceRevoked(params.deviceId, params.identityId);
  }
  if (outcome.rekey.status === 'pending') requestTrustedDeviceRekeyProcessing();
  return outcome;
}

export async function revokeIdentityDevice(params: {
  familyId: string;
  currentDeviceId: DeviceId;
  currentIdentityId: IdentityId;
  deviceId: DeviceId;
  deleteLocalCircleData: boolean;
  localDeletionAuthorization?: DeviceLocalCircleDataDeletionAuthorization;
  now?: number;
  allowCurrentDevice?: boolean;
}) {
  if (params.deviceId === params.currentDeviceId && !params.allowCurrentDevice) {
    throw new IdentityDeviceRevocationError(403, 'FORBIDDEN', 'Cannot revoke current device');
  }

  const device = await deviceRepository.findByDeviceId(params.familyId, params.deviceId);
  if (!device) {
    throw new IdentityDeviceRevocationError(404, 'NOT_FOUND', 'Device not found');
  }
  if (device.identity_id !== params.currentIdentityId) {
    throw new IdentityDeviceRevocationError(403, 'FORBIDDEN', 'Device does not belong to your identity');
  }
  if (device.status === 'revoked') {
    throw new IdentityDeviceRevocationError(400, 'INVALID_STATE', 'Device is already revoked');
  }

  if (params.deleteLocalCircleData) {
    const authorization = params.localDeletionAuthorization;
    const identity = await identityRepository.findByIdentityId(params.familyId, params.currentIdentityId);
    const now = params.now ?? Date.now();
    const validAuthorization = !!authorization
      && authorization.type === LOCAL_DELETION_AUTHORIZATION_TYPE
      && authorization.signerId === params.currentIdentityId
      && authorization.payload?.version === 1
      && authorization.payload.purpose === 'device-local-circle-data-deletion-after-revoke-v1'
      && authorization.payload.identityId === params.currentIdentityId
      && authorization.payload.targetDeviceId === params.deviceId
      && authorization.timestamp <= now + LOCAL_DELETION_AUTHORIZATION_MAX_FUTURE_SKEW_MS
      && authorization.timestamp >= now - LOCAL_DELETION_AUTHORIZATION_MAX_AGE_MS
      && !!identity
      && identity.public_key_algorithm === 'ed25519'
      && verifySignedRequest(authorization, {
        algorithm: 'ed25519',
        value: identity.public_key_value
      });
    if (!validAuthorization) {
      throw new IdentityDeviceRevocationError(
        400,
        'INVALID_SIGNATURE',
        'Valid identity authorization is required to delete local device data'
      );
    }
  }

  const outcome = await commitDeviceRevocation({
    familyId: params.familyId,
    deviceId: params.deviceId,
    identityId: params.currentIdentityId,
    localDeletionAuthorization: params.deleteLocalCircleData
      ? params.localDeletionAuthorization
      : undefined
  });
  if (!outcome) {
    throw new IdentityDeviceRevocationError(400, 'INVALID_STATE', 'Device is already revoked');
  }
  return outcome;
}
