import { versionedAccessOperation } from '../services/versionedAccessOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { verifySignature, requireActiveIdentity, requireAdmin, type AuthRequest, getSignedPayload } from '../middleware/auth';
import type { ApiResponse, CircleMembershipStateRecord, DeviceId, IdentityId } from '../../../shared/types';
import {
  circleOwnerGuestTreeRepository,
  identityRepository,
  deviceLifecyclePolicyRepository,
  deviceRepository,
} from '../db/repositories';
import { query } from '../db';
import {
  changeCircleOwnerToExistingIdentity,
  CircleOwnershipError,
  deliverCircleOwnerChangedPush
} from '../services/circleOwnershipService';
import {
  AdminDeviceRevocationError,
  revokeDeviceAsAdmin
} from '../services/adminDeviceRevocationService';
import {
  AdminIdentityRemovalError,
  removeIdentityFromCircle
} from '../services/adminIdentityRemovalService';
import { sendApiError } from '../utils/apiResponses';
import { notifyIdentityServerDataDeleted, suspendIdentityWsAccess } from '../ws/wsGateway';
import { publicSiteGeneratorService } from '../services/publicSiteGeneratorService';
import { attachmentStorageService } from '../services/attachmentStorageService';
import { publicSiteAssetStorageService } from '../services/publicSiteAssetStorageService';
import {
  deleteIdentityDataFromCircle,
  IdentityDeletionServiceError
} from '../services/identityDeletionService';
import { listCircleIdentityAdmissionProofs } from '../services/circleMembershipProofService';
import { listCircleMembershipStates } from '../services/circleMembershipStateService';
import { setCircleInvitePermission } from '../services/circleInvitePermissionService';
import { setCircleMemberStatus } from '../services/circleMembershipAdminService';
import { notifyCircleDirectoryChanged } from '../services/circleDirectoryNotificationService';
import { setGuestInvitePermission } from '../services/guestInvitePermissionService';
import { mapDirectGuestPermissionsFromDb } from '../services/directGuestAccessService';

const OWNER_GUEST_TREE_DEFAULT_LIMIT = 25;
const OWNER_GUEST_TREE_MAX_LIMIT = 100;

function encodeGuestTreeCursor(registrationId: string): string {
  return Buffer.from(registrationId, 'utf8').toString('base64url');
}

function decodeGuestTreeCursor(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (!decoded || decoded.length > 255 || encodeGuestTreeCursor(decoded) !== value) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

const router = Router();
router.post(
  '/devices/inactivity-review',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      if (!req.familyId) {
        return res.status(500).json({ status: 'error', error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' } } as ApiResponse);
      }
      const policy = await deviceLifecyclePolicyRepository.get();
      const [devices, unreachableProfiles] = await Promise.all([
        deviceLifecyclePolicyRepository.listReviewDevices(req.familyId, policy),
        deviceLifecyclePolicyRepository.listUnreachableProfiles(req.familyId)
      ]);
      return res.json({
        status: 'ok',
        result: {
          policy,
          devices: devices.map((entry) => ({ ...entry, label: null })),
          unreachableProfiles,
        }
      } as ApiResponse);
    } catch (error) {
      routeLogger.error('Get inactive device review error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to get inactive device review' } } as ApiResponse);
    }
  }
);
router.post(
  '/users',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest<{ role?: string }>, res) => {
    try {
      const familyId = req.familyId;

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const [users, membershipProofs, membershipStates, inviteSummaries, guestCounts] = await Promise.all([
        identityRepository.findAll(familyId),
        listCircleIdentityAdmissionProofs(familyId),
        listCircleMembershipStates(familyId),
        query<{
          created_by: string;
          total: string;
          active_single_use: string;
          active_unlimited: string;
        }>(
          `SELECT created_by,
                  COUNT(*)::text AS total,
                  COUNT(*) FILTER (
                    WHERE status = 'active'
                      AND expires_at > NOW()
                      AND used_count < max_uses
                      AND COALESCE(capability_mode, 'single-use') = 'single-use'
                  )::text AS active_single_use,
                  COUNT(*) FILTER (
                    WHERE status = 'active'
                      AND expires_at > NOW()
                      AND used_count < max_uses
                      AND capability_mode = 'unlimited'
                  )::text AS active_unlimited
             FROM invites
            WHERE family_id = $1
              AND created_by <> 'system'
            GROUP BY created_by`,
          [familyId]
        ),
        query<{ host_identity_id: string; active_guest_count: string }>(
          `SELECT registration.host_identity_id,
                  COUNT(DISTINCT registration.guest_identity_id)::text AS active_guest_count
             FROM direct_guest_registrations registration
             JOIN identities guest
               ON guest.family_id = registration.family_id
              AND guest.identity_id = registration.guest_identity_id
              AND guest.status = 'active'
            WHERE registration.family_id = $1
              AND registration.status = 'active'
            GROUP BY registration.host_identity_id`,
          [familyId]
        ),
      ]);
      const inviteSummaryByCreator = new Map(inviteSummaries.rows.map((summary) => [summary.created_by, summary]));
      const guestCountByHost = new Map(guestCounts.rows.map((entry) => [entry.host_identity_id, Number(entry.active_guest_count || '0')]));

      return res.json({
        status: 'ok',
        result: {
          users: users.filter((u) => u.role !== 'guest').map(u => ({
            identityId: u.identity_id,
            identityName: null,
            publicKey: {
              algorithm: u.public_key_algorithm as 'ed25519' | 'x25519',
              value: u.public_key_value
            },
            role: u.role || 'member',
            status: u.status,
            publishIdentity: false,
            createdAt: u.created_at.toISOString(),
            canCreateInvites: u.role === 'owner'
              || Boolean((u as typeof u & { can_create_invites?: boolean }).can_create_invites),
            canCreateGuestInvites: u.role === 'owner'
              || Boolean((u as typeof u & { can_create_guest_invites?: boolean }).can_create_guest_invites),
            activeGuestCount: guestCountByHost.get(u.identity_id) || 0,
            invitationSummary: (() => {
              const summary = inviteSummaryByCreator.get(u.identity_id);
              return {
                total: Number(summary?.total || 0),
                activeSingleUse: Number(summary?.active_single_use || 0),
                activeUnlimited: Number(summary?.active_unlimited || 0)
              };
            })()
          })),
          membershipProofs,
          membershipStates,
        }
      } as ApiResponse);

    } catch (error) {
      routeLogger.error('Get users error:', error);
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to get users'
        }
      } as ApiResponse);
    }
  }
);

/**
 * Load one level of the Circle guest tree. Names and device labels remain
 * private to the identity that owns them; the owner receives only operational
 * metadata needed to audit and revoke Circle access.
 */
router.post(
  '/guests/children',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;
      const payload = getSignedPayload<{
        hostIdentityId?: unknown;
        cursor?: unknown;
        limit?: unknown;
        includeInactive?: unknown;
      }>(req);
      const hostIdentityId = typeof payload.hostIdentityId === 'string'
        ? payload.hostIdentityId.trim()
        : '';
      const cursor = decodeGuestTreeCursor(payload.cursor);
      const requestedLimit = payload.limit === undefined
        ? OWNER_GUEST_TREE_DEFAULT_LIMIT
        : Number(payload.limit);
      if (!familyId) {
        return sendApiError(res, 500, 'MISSING_FAMILY_ID', 'Family context not set');
      }
      if (!hostIdentityId || hostIdentityId.length > 255) {
        return sendApiError(res, 400, 'INVALID_REQUEST', 'hostIdentityId is required');
      }
      if (cursor === undefined) {
        return sendApiError(res, 400, 'INVALID_REQUEST', 'Invalid guest tree cursor');
      }
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > OWNER_GUEST_TREE_MAX_LIMIT) {
        return sendApiError(res, 400, 'INVALID_REQUEST', `limit must be between 1 and ${OWNER_GUEST_TREE_MAX_LIMIT}`);
      }
      if (payload.includeInactive !== undefined && typeof payload.includeInactive !== 'boolean') {
        return sendApiError(res, 400, 'INVALID_REQUEST', 'includeInactive must be boolean');
      }

      const host = await identityRepository.findByIdentityId(familyId, hostIdentityId as IdentityId);
      if (!host) return sendApiError(res, 404, 'NOT_FOUND', 'Guest host not found');

      const rows = await circleOwnerGuestTreeRepository.listChildren({
        familyId,
        hostIdentityId,
        afterRegistrationId: cursor,
        limit: requestedLimit,
        includeInactive: payload.includeInactive === true,
      });
      const hasMore = rows.length > requestedLimit;
      const page = hasMore ? rows.slice(0, requestedLimit) : rows;
      return res.json({
        status: 'ok',
        result: {
          host: {
            identityId: host.identity_id,
            role: host.role || 'member',
            status: host.status,
          },
          guests: page.map((row) => ({
            registrationId: row.registration_id,
            linkId: row.link_id,
            hostIdentityId: row.host_identity_id,
            guestIdentityId: row.guest_identity_id,
            guestIdentityPublicKey: {
              algorithm: row.guest_public_key_algorithm,
              value: row.guest_public_key_value,
            },
            identityStatus: row.guest_status,
            accessStatus: row.registration_status,
            canCreateGuestInvites: row.can_create_guest_invites === true,
            permissions: mapDirectGuestPermissionsFromDb(row),
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
            revokedAt: row.revoked_at?.toISOString() || null,
            lastSeenAt: row.last_seen_at?.toISOString() || null,
            activeConnectionCount: Number(row.active_device_count || 0),
            revokedConnectionCount: Number(row.revoked_device_count || 0),
            activeChildGuestCount: Number(row.active_child_guest_count || 0),
          })),
          nextCursor: hasMore && page.length > 0
            ? encodeGuestTreeCursor(page[page.length - 1].registration_id)
            : null,
        }
      } as ApiResponse);
    } catch (error) {
      routeLogger.error('Get Circle guest tree children error:', error);
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to load Circle guests');
    }
  }
);

/** Grant or revoke guest-invitation delegation independently of Circle role. */
router.post(
  '/users/:identityId/guest-invite-permission',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  versionedAccessOperation(async (req: AuthRequest<{ enabled?: boolean }>, res) => {
    try {
      const familyId = req.familyId;
      const identityId = String(req.params.identityId || '').trim();
      const { enabled } = getSignedPayload<{ enabled?: boolean }>(req);
      if (!familyId) {
        return res.status(500).json({ status: 'error', error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' } } as ApiResponse);
      }
      if (!identityId || typeof enabled !== 'boolean') {
        return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST', message: 'identityId and enabled are required' } } as ApiResponse);
      }

      const result = await setGuestInvitePermission({ familyId, identityId, enabled });
      if (result.kind === 'not_found') return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'User not found' } } as ApiResponse);
      if (result.kind === 'owner') return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Owner permission is always enabled' } } as ApiResponse);
      if (result.kind === 'invalid') return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE', message: 'Only active members and guests can receive this permission' } } as ApiResponse);
      if (result.kind !== 'updated') return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Unexpected permission result' } } as ApiResponse);
      return res.json({ status: 'ok', result: { identityId, canCreateGuestInvites: enabled, revokedLinks: result.revokedLinks } } as ApiResponse);
    } catch (error) {
      routeLogger.error('Update guest invite permission error:', error);
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'Failed to update guest invitation permission' } } as ApiResponse);
    }
  })
);

/**
 * Transfer Circle ownership to another active member.
 */
router.post(
  '/owner/transfer',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest<{ newOwnerIdentityId?: string; membershipState?: CircleMembershipStateRecord }>, res) => {
    try {
      const familyId = req.familyId;
      const currentOwnerIdentityId = req.identity!.identityId;
      const { newOwnerIdentityId: rawTargetIdentityId, membershipState } = getSignedPayload<{ newOwnerIdentityId?: string; membershipState?: CircleMembershipStateRecord }>(req);
      const newOwnerIdentityId = typeof rawTargetIdentityId === 'string' ? rawTargetIdentityId.trim() : '';
      if (!membershipState) return sendApiError(res, 400, 'INVALID_REQUEST', 'Signed ownership transition is required');

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }
      const result = await changeCircleOwnerToExistingIdentity({
        familyId,
        expectedOwnerIdentityId: currentOwnerIdentityId,
        newOwnerIdentityId,
        method: 'voluntary_transfer',
        initiatedByIdentityId: currentOwnerIdentityId,
        initiatedByDeviceId: req.device!.deviceId,
        signedAuthorization: req.signedRequest,
        membershipState
      });
      await notifyCircleDirectoryChanged(familyId, 'membership');
      void deliverCircleOwnerChangedPush(result);
      return res.json({
        status: 'ok',
        result: { previousOwnerIdentityId: currentOwnerIdentityId, newOwnerIdentityId, ownershipChangeId: result.changeId }
      } as ApiResponse);
    } catch (error) {
      if (error instanceof CircleOwnershipError) {
        return res.status(error.status).json({
          status: 'error',
          error: { code: error.code, message: error.message }
        } as ApiResponse);
      }
      routeLogger.error('Transfer Circle ownership error:', error);
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'Failed to transfer Circle ownership' }
      } as ApiResponse);
    }
  }
);

/**
 * Allow or disallow a member to create Circle invitations (owner only).
 * Disabling the permission revokes active invitations created by the member
 * atomically.
 */
router.post(
  '/users/:identityId/invite-permission',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  versionedAccessOperation(async (req: AuthRequest<{ enabled?: boolean; membershipState?: CircleMembershipStateRecord }>, res) => {
    try {
      const { identityId } = req.params;
      const { enabled, membershipState } = getSignedPayload<{
        enabled?: boolean;
        membershipState?: CircleMembershipStateRecord;
      }>(req);
      const familyId = req.familyId;

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'enabled must be a boolean' }
        } as ApiResponse);
      }

      const targetUser = await identityRepository.findByIdentityId(familyId, identityId);
      if (!targetUser) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'NOT_FOUND', message: 'User not found' }
        } as ApiResponse);
      }

      if (targetUser.role === 'owner') {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN', message: 'Cannot modify owner invitation permission' }
        } as ApiResponse);
      }

      if (targetUser.role !== 'member') {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN', message: 'Only members can receive invitation creation permission' }
        } as ApiResponse);
      }

      if (targetUser.status === 'removed') {
        return res.status(409).json({
          status: 'error',
          error: { code: 'INVALID_STATE', message: 'Cannot modify a removed user' }
        } as ApiResponse);
      }

      const signedPermissionEntry = membershipState?.claim?.payload?.members
        ?.find((entry) => entry.identityId === identityId);
      const signedPermissionEnabled = signedPermissionEntry
        ? signedPermissionEntry.role === 'owner' || signedPermissionEntry.permissions?.canCreateInvites === true
        : null;
      if (
        membershipState !== undefined
        && (
          membershipState.claim?.payload?.action !== 'set_invite_permission'
          || membershipState.claim.payload.subjectIdentityId !== identityId
          || signedPermissionEnabled !== enabled
        )
      ) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'Invalid signed invitation permission transition' }
        } as ApiResponse);
      }

      const result = await setCircleInvitePermission({
        familyId,
        identityId,
        enabled,
        membershipState
      });

      if (!result) {
        return res.status(404).json({
          status: 'error',
          error: { code: 'NOT_FOUND', message: 'User not found' }
        } as ApiResponse);
      }

      if (membershipState) void notifyCircleDirectoryChanged(familyId, 'membership');

      return res.json({
        status: 'ok',
        result: {
          identityId: result.identityId,
          canCreateInvites: result.canCreateInvites,
          revokedInvites: result.revokedInvites
        }
      } as ApiResponse);
    } catch (error) {
      routeLogger.error('Update invite permission error:', error);
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to update invitation permission'
        }
      } as ApiResponse);
    }
  })
);

/**
 * Disable user (owner only)
 */
router.post(
  '/users/:identityId/disable',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  versionedAccessOperation(async (req: AuthRequest<{ membershipState?: CircleMembershipStateRecord }>, res) => {
    try {
      const { identityId } = req.params;
      const familyId = req.familyId;

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const membershipState = getSignedPayload<{ membershipState?: CircleMembershipStateRecord }>(req).membershipState;
      const result = await setCircleMemberStatus({
        familyId, ownerIdentityId: req.identity!.identityId, subjectIdentityId: identityId,
        status: 'disabled', membershipState
      });
      if (result === 'not_found') return sendApiError(res, 404, 'NOT_FOUND', 'User not found');
      if (result !== 'updated') return sendApiError(res, 409, 'INVALID_STATE', 'Signed membership transition does not match user status');
      await suspendIdentityWsAccess(familyId, identityId as IdentityId);
      await notifyCircleDirectoryChanged(familyId, 'membership');

      return res.json({
        status: 'ok',
        result: {
          identityId,
          status: 'disabled'
        }
      } as ApiResponse);

    } catch (error) {
      routeLogger.error('Disable user error:', error);
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to disable user'
        }
      } as ApiResponse);
    }
  })
);

/**
 * Enable user (owner only)
 */
router.post(
  '/users/:identityId/enable',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  versionedAccessOperation(async (req: AuthRequest<{ membershipState?: CircleMembershipStateRecord }>, res) => {
    try {
      const { identityId } = req.params;
      const familyId = req.familyId;

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const membershipState = getSignedPayload<{ membershipState?: CircleMembershipStateRecord }>(req).membershipState;
      if (!membershipState) return sendApiError(res, 400, 'INVALID_REQUEST', 'Signed membership transition is required');
      const result = await setCircleMemberStatus({
        familyId, ownerIdentityId: req.identity!.identityId, subjectIdentityId: identityId,
        status: 'active', membershipState
      });
      if (result === 'not_found') return sendApiError(res, 404, 'NOT_FOUND', 'User not found');
      if (result !== 'updated') return sendApiError(res, 409, 'INVALID_STATE', 'Signed membership transition does not match user status');
      await notifyCircleDirectoryChanged(familyId, 'membership');

      return res.json({
        status: 'ok',
        result: {
          identityId,
          status: 'active'
        }
      } as ApiResponse);

    } catch (error) {
      routeLogger.error('Enable user error:', error);
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to enable user'
        }
      } as ApiResponse);
    }
  })
);

/**
 * Permanently remove a blocked user from Circle membership while retaining
 * historical message and audit references.
 */
router.post(
  '/users/:identityId/remove',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const familyId = req.familyId;
      const identityId = req.params.identityId as IdentityId;
      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const removed = await removeIdentityFromCircle({
        familyId,
        identityId,
        removedByIdentityId: req.identity!.identityId as IdentityId
      });
      await suspendIdentityWsAccess(familyId, identityId);
      void publicSiteGeneratorService.regenerateSite(familyId).catch((error) => {
        routeLogger.error('Refresh public site after user removal error:', error);
      });

      return res.json({
        status: 'ok',
        result: {
          identityId: removed.identity_id,
          status: removed.status,
          removedAt: removed.removed_at.toISOString()
        }
      } as ApiResponse);
    } catch (error) {
      if (error instanceof AdminIdentityRemovalError) {
        return sendApiError(res, error.status, error.code, error.message);
      }
      routeLogger.error('Remove user error:', error);
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to remove user');
    }
  }
);

/**
 * Irreversibly delete a server-side profile that is not present in the
 * current owner-signed Circle membership state.
 */
router.post(
  '/users/:identityId/purge-unverified',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest<{
    expectedIdentityId?: string;
    expectedMembershipStateId?: string;
  }>, res) => {
    try {
      const familyId = req.familyId;
      const identityId = String(req.params.identityId || '').trim();
      const payload = getSignedPayload<{
        expectedIdentityId?: string;
        expectedMembershipStateId?: string;
      }>(req);
      const expectedIdentityId = String(payload.expectedIdentityId || '').trim();
      const expectedMembershipStateId = String(payload.expectedMembershipStateId || '').trim();
      const ownerIdentityId = req.identity!.identityId;
      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }
      if (!identityId || expectedIdentityId !== identityId || !expectedMembershipStateId) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST', message: 'Exact profile and membership state confirmation are required' }
        } as ApiResponse);
      }
      if (identityId === ownerIdentityId) {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN', message: 'The Circle owner cannot be deleted' }
        } as ApiResponse);
      }

      const result = await deleteIdentityDataFromCircle({
        familyId,
        identityId,
        unverifiedMembershipGuard: {
          expectedMembershipStateId,
          expectedOwnerIdentityId: ownerIdentityId,
        },
      });
      notifyIdentityServerDataDeleted(familyId, identityId as IdentityId);
      await suspendIdentityWsAccess(familyId, identityId as IdentityId);
      for (const storageKey of result.attachmentStorageKeys) {
        try {
          await attachmentStorageService.deleteBlob(storageKey);
        } catch (error) {
          routeLogger.error('Delete unverified profile attachment payload failed', error);
        }
      }
      for (const storageKey of result.publicSiteAssetStorageKeys) {
        await publicSiteAssetStorageService.deleteAsset(storageKey).catch((error) => {
          routeLogger.error('Delete unverified profile public site asset failed', error);
        });
      }
      return res.json({
        status: 'ok',
        result: { identityId, deleted: true }
      } as ApiResponse<{ identityId: string; deleted: true }>);
    } catch (error) {
      if (error instanceof IdentityDeletionServiceError) {
        return sendApiError(res, error.status, error.code, error.message);
      }
      routeLogger.error('Purge unverified Circle profile error', error);
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to delete unverified profile data');
    }
  }
);

/**
 * Get devices for a user (admin only)
 */
router.post(
  '/users/:identityId/devices',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const { identityId } = req.params;
      const familyId = req.familyId;

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const targetIdentity = await identityRepository.findByIdentityId(familyId, identityId as IdentityId);
      if (!targetIdentity || targetIdentity.role === 'guest') {
        return sendApiError(res, 404, 'NOT_FOUND', 'Circle member not found');
      }

      const devices = await deviceRepository.findByIdentityId(familyId, identityId);

      return res.json({
        status: 'ok',
        result: {
          devices: devices.map(d => ({
            deviceId: d.device_id,
            identityId: d.identity_id,
            publicKey: {
              algorithm: d.public_key_algorithm as 'ed25519' | 'x25519',
              value: d.public_key_value
            },
            label: null,
            status: d.status,
            createdAt: d.created_at.toISOString(),
            lastSeenAt: d.last_seen_at?.toISOString()
          }))
        }
      } as ApiResponse);

    } catch (error) {
      routeLogger.error('Get user devices error:', error);
      return res.status(500).json({
        status: 'error',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to get user devices'
        }
      } as ApiResponse);
    }
  }
);

/**
 * Revoke device (admin only)
 */
router.post(
  '/devices/:deviceId/revoke',
  verifySignature,
  requireActiveIdentity,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const { deviceId } = req.params;
      const familyId = req.familyId;

      if (!familyId) {
        return res.status(500).json({
          status: 'error',
          error: { code: 'MISSING_FAMILY_ID', message: 'Family context not set' }
        } as ApiResponse);
      }

      const outcome = await revokeDeviceAsAdmin({ familyId, deviceId: deviceId as DeviceId });

      return res.json({
        status: 'ok',
        result: {
          deviceId,
          status: 'revoked',
          rekeyJobId: outcome.rekey.jobId,
          rekeyStatus: outcome.rekey.status,
          affectedGroupChats: outcome.rekey.groupTargets,
          affectedDirectChats: outcome.rekey.directTargets
        }
      } as ApiResponse);

    } catch (error) {
      if (error instanceof AdminDeviceRevocationError) {
        return sendApiError(res, error.status, error.code, error.message);
      }
      routeLogger.error('Revoke device error:', error);
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to revoke device');
    }
  }
);

/**
 * Get all invites (admin only)
 */

export default router;
