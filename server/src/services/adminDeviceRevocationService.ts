import type { DeviceId, IdentityId } from '../../../shared/types';
import { deviceRepository } from '../db/repositories';
import { commitDeviceRevocation } from './deviceRevocationService';

export class AdminDeviceRevocationError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'NOT_FOUND' | 'INVALID_STATE',
    message: string
  ) {
    super(message);
  }
}

export async function revokeDeviceAsAdmin(params: {
  familyId: string;
  deviceId: DeviceId;
}) {
  const targetDevice = await deviceRepository.findByDeviceId(params.familyId, params.deviceId);
  if (!targetDevice) {
    throw new AdminDeviceRevocationError(404, 'NOT_FOUND', 'Device not found');
  }

  const outcome = await commitDeviceRevocation({
    familyId: params.familyId,
    deviceId: params.deviceId,
    identityId: targetDevice.identity_id as IdentityId
  });
  if (!outcome) {
    throw new AdminDeviceRevocationError(400, 'INVALID_STATE', 'Device is already revoked');
  }
  return outcome;
}
