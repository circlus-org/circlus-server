import type { Response } from 'express';
import { getRequestAuthorization, type AuthRequest } from '../middleware/auth';
import { directGuestRegistrationRepository } from '../db/repositories';
import { mapDirectGuestPermissionsFromDb } from '../services/directGuestAccessService';
import { configService } from '../services/configService';
import { sendApiError } from '../utils/apiResponses';

export function mapDirectGuestRegistrationResponse(
  row: Awaited<ReturnType<typeof directGuestRegistrationRepository.listByHost>>[number],
  includeLinkId: boolean = true
) {
  return {
    registrationId: row.registration_id,
    ...(includeLinkId ? { linkId: row.link_id } : {}),
    guestIdentityId: row.guest_identity_id,
    guestIdentityName: null,
    guestIdentityPublicKey: row.guest_public_key_algorithm && row.guest_public_key_value
      ? { algorithm: row.guest_public_key_algorithm, value: row.guest_public_key_value }
      : null,
    capabilityId: row.capability_id ?? null,
    admissionClaim: row.admission_claim ?? null,
    departure: row.departure_proof ?? null,
    permissions: mapDirectGuestPermissionsFromDb(row),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() || null,
    revokedAt: row.revoked_at?.toISOString() || null
  };
}

export async function requireGuestLinkManagementAccess(req: AuthRequest, res: Response): Promise<boolean> {
  if (getRequestAuthorization(req).manageOwnGuestLinks) return true;
  sendApiError(res, 403, 'FORBIDDEN', 'Registered identity required');
  return false;
}

export async function requireGuestLinkCreationAccess(req: AuthRequest, res: Response): Promise<boolean> {
  if (getRequestAuthorization(req).createGuestInvites) return true;
  sendApiError(res, 403, 'FORBIDDEN', 'Guest invitation permission required');
  return false;
}

export async function canUseGuestServerAttachments(familyId: string, role?: string | null): Promise<boolean> {
  if (role === 'owner') return true;
  if (role !== 'member') return false;
  const config = await configService.getFamilyConfig(familyId);
  return config?.members_can_use_guest_server_attachments !== false;
}
