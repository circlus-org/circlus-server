import type { DeviceId, IdentityId } from '@shared/types';
import type { AuthRequest } from '../middleware/auth';

export type AuthenticatedActor = {
  familyId: string;
  identityId: IdentityId;
  deviceId: DeviceId;
  accessLevel?: 'trusted' | 'temporary';
};

export function authenticatedActorFromHttpRequest(req: AuthRequest): AuthenticatedActor | null {
  const familyId = req.familyId;
  const identityId = req.identity?.identityId || req.device?.identityId;
  const deviceId = req.device?.deviceId;
  if (!familyId || !identityId || !deviceId) return null;
  return {
    familyId,
    identityId: identityId as IdentityId,
    deviceId: deviceId as DeviceId,
    accessLevel: req.device?.accessLevel
  };
}
