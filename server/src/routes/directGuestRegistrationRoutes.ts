import type { DirectGuestRevocation } from '../../../shared/directGuestRevocation';
import { versionedAccessOperation } from '../services/versionedAccessOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { verifySignature, requireActiveIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import {
  announcementChannelRepository,
  directGuestLinkRepository,
  directGuestRegistrationRepository
} from '../db/repositories';
import { mapDirectGuestPermissionsFromDb } from '../services/directGuestAccessService';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import {
  canUseGuestServerAttachments,
  mapDirectGuestRegistrationResponse,
  requireGuestLinkManagementAccess
} from './directGuestLinkRouteSupport';
import {
  DirectGuestRegistrationRevocationError,
  revokeDirectGuestRegistration
} from '../services/directGuestRegistrationRevocationService';
import {
  DirectGuestBulkAccessError,
  endDirectGuestAccessByLink
} from '../services/directGuestBulkAccessService';

import { commitDirectGuestDeparture, DirectGuestDepartureError } from '../services/directGuestDepartureService';
import type { DirectGuestDeparture } from '../../../shared/directGuestDeparture';
import { sendToIdentityWs } from '../ws/wsGateway';

const router = Router();
// Read only the authenticated actor's relationship, never arbitrary registrations.
router.post('/registrations/permissions', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const actor = req.device?.identityId;
    const peerIdentityId = getSignedPayload<{ peerIdentityId?: string }>(req)?.peerIdentityId;
    if (!req.familyId || !actor || typeof peerIdentityId !== 'string' || !peerIdentityId.trim() || peerIdentityId.length > 255) {
      return res.status(400).json({status: 'error', error: {code: 'INVALID_REQUEST', message: 'Peer identity is required'}});
    }
    const row = await directGuestRegistrationRepository.findLatestByPair(req.familyId, actor, peerIdentityId);
    return res.json({status: 'ok', result: row ? {
      registrationId: row.registration_id,
      permissions: row.status === 'active'
        ? mapDirectGuestPermissionsFromDb(row)
        : Object.fromEntries(Object.keys(mapDirectGuestPermissionsFromDb(row)).map((key) => [key, false])),
      status: row.status,
      departure: row.departure_proof ?? null,
      revocation: row.revocation_proof ?? null,
      hostIdentityPublicKey: row.host_public_key_algorithm && row.host_public_key_value
        ? { algorithm: row.host_public_key_algorithm, value: row.host_public_key_value } : null,
      guestIdentityPublicKey: row.guest_public_key_algorithm && row.guest_public_key_value
        ? { algorithm: row.guest_public_key_algorithm, value: row.guest_public_key_value } : null,
    } : null});
  } catch (error) {
    routeLogger.error('Read direct guest permissions error:', error);
    return res.status(500).json({status: 'error', error: {code: 'INTERNAL_ERROR', message: 'Internal server error'}});
  }
});

router.post('/:linkId/end-access', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;
    const linkId = String(req.params.linkId || '').trim();
    if (!familyId || !hostIdentityId || !linkId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Link is required' }
      } as ApiResponse);
    }
    if (!(await requireGuestLinkManagementAccess(req, res))) return;
    const outcome = await endDirectGuestAccessByLink({ familyId, linkId, hostIdentityId });
    return res.json({ status: 'ok', result: outcome } as ApiResponse);
  } catch (error) {
    if (error instanceof DirectGuestBulkAccessError) {
      return res.status(error.status).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: error.message }
      } as ApiResponse);
    }
    routeLogger.error('End direct guest access by link error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/registrations/mine', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;
    if (!familyId || !hostIdentityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    if (!(await requireGuestLinkManagementAccess(req, res))) return;

    const payload = getSignedPayload<{ linkIds?: unknown }>(req) || {};
    if (payload.linkIds !== undefined && (
      !Array.isArray(payload.linkIds)
      || payload.linkIds.length > 500
      || payload.linkIds.some((linkId) => typeof linkId !== 'string' || !linkId.trim() || linkId.length > 255)
    )) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'linkIds must contain at most 500 valid link ids' }
      } as ApiResponse);
    }
    const linkIds = Array.isArray(payload.linkIds)
      ? [...new Set(payload.linkIds.map((linkId) => String(linkId).trim()))]
      : null;
    const rows = await directGuestRegistrationRepository.listByHost(familyId, hostIdentityId, linkIds);
    return res.json({
      status: 'ok',
      result: rows.map((row) => mapDirectGuestRegistrationResponse(row))
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List host direct guest registrations error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/:linkId/registrations', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;
    const linkId = String(req.params.linkId || '').trim();
    if (!familyId || !hostIdentityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    if (!(await requireGuestLinkManagementAccess(req, res))) return;
    if (!linkId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'linkId is required' }
      } as ApiResponse);
    }

    const rows = await directGuestRegistrationRepository.listByLink(familyId, linkId, hostIdentityId);
    return res.json({
      status: 'ok',
      result: rows.map((row) => mapDirectGuestRegistrationResponse(row, false))
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List direct guest registrations error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/registrations/:registrationId/revoke', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;
    const registrationId = String(req.params.registrationId || '').trim();
    if (!familyId || !hostIdentityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    if (!(await requireGuestLinkManagementAccess(req, res))) return;
    if (!registrationId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'registrationId is required' }
      } as ApiResponse);
    }

    const payload = getSignedPayload<{ removeFromChannelIds?: unknown; revocation?: DirectGuestRevocation }>(req);
    if (payload.removeFromChannelIds !== undefined && (
      !Array.isArray(payload.removeFromChannelIds)
      || payload.removeFromChannelIds.length > 100
      || payload.removeFromChannelIds.some((value) => typeof value !== 'string' || !value.trim() || value.length > 255)
    )) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'removeFromChannelIds must contain at most 100 valid channel ids' }
      } as ApiResponse);
    }
    const requestedChannelIds = Array.isArray(payload.removeFromChannelIds)
      ? [...new Set(payload.removeFromChannelIds.map((value) => String(value || '').trim()).filter(Boolean))]
      : [];
    const outcome = await revokeDirectGuestRegistration({
      familyId,
      registrationId,
      hostIdentityId,
      revocation: payload.revocation,
      removeFromChannelIds: requestedChannelIds
    });
    const revoked = outcome.revoked;
    try { sendToIdentityWs(familyId, outcome.event.recipientIdentityId, { type: 'system:event', data: outcome.event }); }
    catch (error) { routeLogger.warn('Guest revocation live notification deferred to sync', { error }); }

    return res.json({
      status: 'ok',
      result: {
        registrationId: revoked.registration_id,
        status: revoked.status,
        revokedAt: revoked.revoked_at?.toISOString() || null,
        removedChannels: outcome.removedChannels,
      }
    } as ApiResponse);
  } catch (error) {
    if (error instanceof DirectGuestRegistrationRevocationError) {
      return res.status(error.status).json({
        status: 'error',
        error: { code: error.code as ErrorCode, message: error.message }
      } as ApiResponse);
    }
    routeLogger.error('Revoke direct guest registration error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.post('/registrations/:registrationId/revoke-impact', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;
    const registrationId = String(req.params.registrationId || '').trim();
    if (!familyId || !hostIdentityId || !registrationId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Registration is required' } } as ApiResponse);
    }
    if (!(await requireGuestLinkManagementAccess(req, res))) return;
    const registration = await directGuestRegistrationRepository.findActiveByHost(familyId, registrationId, hostIdentityId);
    if (!registration) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Direct guest registration not found' } } as ApiResponse);
    }
    const impacts = await announcementChannelRepository.listOwnedActiveSubscriptionsForGuest({
      familyId,
      ownerIdentityId: hostIdentityId,
      guestIdentityId: registration.guest_identity_id,
    });
    return res.json({ status: 'ok', result: impacts.map((impact) => ({
      channelId: impact.channel_id,
      keyEpoch: Number(impact.key_epoch || 1),
    })) } as ApiResponse);
  } catch (error) {
    routeLogger.error('Inspect direct guest revoke impact error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/registrations/:registrationId/delete', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;
    const registrationId = String(req.params.registrationId || '').trim();
    if (!familyId || !hostIdentityId || !registrationId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Registration is required' }
      } as ApiResponse);
    }
    if (!(await requireGuestLinkManagementAccess(req, res))) return;

    const existing = await directGuestRegistrationRepository.findByHost(familyId, registrationId, hostIdentityId);
    if (!existing) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Direct guest registration not found' }
      } as ApiResponse);
    }
    if (existing.status === 'active') {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Revoke guest access before deleting the record' }
      } as ApiResponse);
    }

    const deleted = await directGuestRegistrationRepository.deleteInactiveByHost(
      familyId,
      registrationId,
      hostIdentityId
    );
    if (!deleted) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Guest registration changed; refresh and try again' }
      } as ApiResponse);
    }
    return res.json({
      status: 'ok',
      result: { registrationId, linkId: deleted.link_id, status: 'deleted' }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Delete direct guest registration error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.post('/registrations/:registrationId/permissions/update', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;
    const registrationId = String(req.params.registrationId || '').trim();
    if (!familyId || !hostIdentityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    if (!(await requireGuestLinkManagementAccess(req, res))) return;
    if (!registrationId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'registrationId is required' }
      } as ApiResponse);
    }

    const payload = getSignedPayload<{
      canMessage?: boolean;
      canCall?: boolean;
      canDirectFileTransfer?: boolean;
      canServerAttachments?: boolean;
    }>(req);
    const existing = await directGuestRegistrationRepository.findActiveByHost(familyId, registrationId, hostIdentityId);
    if (!existing) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Direct guest registration not found' }
      } as ApiResponse);
    }

    const guestCanMessageHost = payload.canMessage === true;
    const guestCanCallHost = payload.canCall === true;
    if (guestCanMessageHost && !(existing.guest_can_message_host ?? existing.can_message)) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Guest acceptance is required to enable direct chat' }
      } as ApiResponse);
    }
    if (!guestCanMessageHost && guestCanCallHost) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Calls require direct chat' }
      } as ApiResponse);
    }
    const requestedGuestCanDirectFileTransferHost = payload.canDirectFileTransfer === true;
    const requestedGuestCanServerAttachmentsHost = payload.canServerAttachments === true;
    if (!guestCanMessageHost && (requestedGuestCanDirectFileTransferHost || requestedGuestCanServerAttachmentsHost)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'File permissions require message permission' }
      } as ApiResponse);
    }
    const guestCanDirectFileTransferHost = guestCanMessageHost && requestedGuestCanDirectFileTransferHost;
    const guestCanServerAttachmentsHost = (await canUseGuestServerAttachments(familyId, req.identity?.role))
      ? guestCanMessageHost && requestedGuestCanServerAttachmentsHost
      : false;
    const link = await directGuestLinkRepository.findById(familyId, existing.link_id);
    if (!guestCanMessageHost
      && !guestCanCallHost
      && !guestCanDirectFileTransferHost
      && !guestCanServerAttachmentsHost
      && !link?.auto_subscribe_to_channel) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'At least one permission must be enabled' }
      } as ApiResponse);
    }

    const updated = await directGuestRegistrationRepository.updatePermissionsByHost({
      familyId,
      registrationId,
      hostIdentityId,
      canMessage: guestCanMessageHost,
      canCall: guestCanCallHost,
      canDirectFileTransfer: guestCanDirectFileTransferHost,
      canServerAttachments: guestCanServerAttachmentsHost,
      hostCanMessageGuest: guestCanMessageHost,
      guestCanMessageHost,
      hostCanCallGuest: guestCanMessageHost,
      guestCanCallHost,
      hostCanDirectFileTransferGuest: guestCanMessageHost,
      guestCanDirectFileTransferHost,
      hostCanServerAttachmentsGuest: guestCanMessageHost,
      guestCanServerAttachmentsHost,
    });
    if (!updated) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Direct guest registration not found' }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        registrationId: updated.registration_id,
        guestIdentityId: updated.guest_identity_id,
        permissions: mapDirectGuestPermissionsFromDb(updated),
        status: updated.status,
        createdAt: updated.created_at.toISOString(),
        lastSeenAt: updated.last_seen_at?.toISOString() || null,
        revokedAt: updated.revoked_at?.toISOString() || null,
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Update direct guest registration permissions error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.post('/registrations/self-delete', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const guestIdentityId = req.device?.identityId;
    if (!familyId || !guestIdentityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }

    const { registration: deleted, event, guestEvent } = await commitDirectGuestDeparture({
      familyId, guestIdentityId,
      departure: getSignedPayload<{ departure?: DirectGuestDeparture }>(req)?.departure,
    });
    // Persisted event is authoritative for delivery; a disconnected host receives it on sync.
    for (const notice of [event, guestEvent]) {
      if (!notice) continue;
      try { sendToIdentityWs(familyId, notice.recipientIdentityId, { type: 'system:event', data: notice }); }
      catch (error) { routeLogger.warn('Guest departure live notification deferred to sync', { error }); }
    }

    return res.json({
      status: 'ok',
      result: {
        registrationId: deleted.registration_id,
        status: deleted.status,
        revokedAt: deleted.revoked_at?.toISOString() || null,
      }
    } as ApiResponse);
  } catch (error) {
    if (error instanceof DirectGuestDepartureError) {
      return res.status(error.status).json({ status: 'error', error: { code: error.code, message: error.message } });
    }
    routeLogger.error('Self-delete direct guest registration error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});


export default router;
