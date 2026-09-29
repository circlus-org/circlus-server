import { Router } from 'express';
import type { ApiResponse, ErrorCode, SystemEventRecord } from '../../../shared/types';
import { query } from '../db';
import { announcementChannelRepository, directGuestRegistrationRepository, systemEventRepository } from '../db/repositories';
import { getSignedPayload, requireActiveIdentity, verifySignature, type AuthRequest } from '../middleware/auth';
import { mapDirectGuestPermissionsFromDb } from '../services/directGuestAccessService';
import { versionedAccessOperation } from '../services/versionedAccessOperation';
import { routeLogger } from '../utils/routeLogger';
import { sendToIdentityWs } from '../ws/wsGateway';

const router = Router();
const OFFER_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

router.post('/registrations/:registrationId/chat-offer', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;
    const registrationId = String(req.params.registrationId || '').trim();
    const channelId = getSignedPayload<{ channelId?: string }>(req)?.channelId?.trim() || '';
    if (!familyId || !hostIdentityId || !registrationId || !channelId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Registration and channel are required' } } as ApiResponse);
    }
    const [registration, channel] = await Promise.all([
      directGuestRegistrationRepository.findActiveByHost(familyId, registrationId, hostIdentityId),
      announcementChannelRepository.findById(familyId, channelId),
    ]);
    if (!registration || !channel || channel.status !== 'active' || channel.owner_identity_id !== hostIdentityId) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Subscriber not found' } } as ApiResponse);
    }
    const subscription = await announcementChannelRepository.findSubscriptionForIdentity(familyId, channelId, registration.guest_identity_id);
    if (subscription?.status !== 'active') {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Active subscription not found' } } as ApiResponse);
    }
    if (registration.guest_can_message_host ?? registration.can_message) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Direct chat is already available' } } as ApiResponse);
    }
    const previous = await query<{ event_id: string }>(
      `SELECT event_id FROM system_events
        WHERE family_id = $1 AND recipient_identity_id = $2 AND type = 'invite:direct-chat'
          AND payload->>'registrationId' = $3 AND payload->>'channelId' = $4
          AND (payload->>'expiresAt')::timestamptz > NOW()
          AND payload->>'declinedAt' IS NULL AND payload->>'acceptedAt' IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [familyId, registration.guest_identity_id, registrationId, channelId]
    );
    if (previous.rows[0]) return res.json({ status: 'ok', result: { eventId: previous.rows[0].event_id } } as ApiResponse);
    const config = await query<{ circle_id: string }>('SELECT circle_id FROM family_config WHERE family_id = $1', [familyId]);
    if (!config.rows[0]) throw new Error('Circle configuration is missing');
    const event: SystemEventRecord<'invite:direct-chat'> = {
      eventId: systemEventRepository.createEventId(),
      circleId: config.rows[0].circle_id,
      recipientIdentityId: registration.guest_identity_id,
      type: 'invite:direct-chat',
      payload: {
        hostIdentityId,
        guestIdentityId: registration.guest_identity_id,
        registrationId,
        channelId,
        expiresAt: new Date(Date.now() + OFFER_LIFETIME_MS).toISOString(),
      },
      serverTimestamp: Date.now(),
    };
    await systemEventRepository.insertEvent({ ...event, familyId, createdAt: event.serverTimestamp });
    try { sendToIdentityWs(familyId, event.recipientIdentityId, { type: 'system:event', data: event }); } catch { /* Durable sync delivers the offer. */ }
    return res.json({ status: 'ok', result: { eventId: event.eventId } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Offer direct chat to channel subscriber error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
}));

router.post('/chat-offers/:eventId/accept', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const guestIdentityId = req.device?.identityId;
    const eventId = String(req.params.eventId || '').trim();
    if (!familyId || !guestIdentityId || !eventId || req.identity?.role !== 'guest') {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Guest identity is required' } } as ApiResponse);
    }
    const events = await query<{ payload: SystemEventRecord<'invite:direct-chat'>['payload'] }>(
      `SELECT payload FROM system_events WHERE family_id = $1 AND event_id = $2
         AND recipient_identity_id = $3 AND type = 'invite:direct-chat' LIMIT 1`,
      [familyId, eventId, guestIdentityId]
    );
    const offer = events.rows[0]?.payload;
    if (!offer || offer.guestIdentityId !== guestIdentityId || offer.declinedAt || Date.parse(offer.expiresAt) <= Date.now()) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Chat offer is unavailable' } } as ApiResponse);
    }
    const [registration, channel] = await Promise.all([
      directGuestRegistrationRepository.findActiveByHost(familyId, offer.registrationId, offer.hostIdentityId),
      announcementChannelRepository.findById(familyId, offer.channelId),
    ]);
    if (!registration || registration.guest_identity_id !== guestIdentityId || !channel || channel.status !== 'active'
      || channel.owner_identity_id !== offer.hostIdentityId) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Chat offer is unavailable' } } as ApiResponse);
    }
    const subscription = await announcementChannelRepository.findSubscriptionForIdentity(familyId, offer.channelId, guestIdentityId);
    if (subscription?.status !== 'active') {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Channel subscription is no longer active' } } as ApiResponse);
    }
    if (offer.acceptedAt) {
      if (!(registration.guest_can_message_host ?? registration.can_message)) {
        return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Chat offer has already been used' } } as ApiResponse);
      }
      return res.json({ status: 'ok', result: {
        registrationId: offer.registrationId,
        hostIdentityId: offer.hostIdentityId,
        permissions: mapDirectGuestPermissionsFromDb(registration),
      } } as ApiResponse);
    }
    const updated = (registration.guest_can_message_host ?? registration.can_message)
      ? registration
      : await directGuestRegistrationRepository.updatePermissionsByHost({
          familyId, registrationId: offer.registrationId, hostIdentityId: offer.hostIdentityId,
          canMessage: true, canCall: false, canDirectFileTransfer: false, canServerAttachments: false,
          hostCanMessageGuest: true, guestCanMessageHost: true,
          hostCanCallGuest: true, guestCanCallHost: false,
          hostCanDirectFileTransferGuest: true, guestCanDirectFileTransferHost: false,
          hostCanServerAttachmentsGuest: true, guestCanServerAttachmentsHost: false,
        });
    if (!updated) throw new Error('Failed to grant accepted chat access');
    await query(`UPDATE system_events SET payload = payload || jsonb_build_object('acceptedAt', NOW()::text) WHERE family_id = $1 AND event_id = $2`, [familyId, eventId]);
    const notification: SystemEventRecord<'direct-chat:accepted'> = {
      eventId: systemEventRepository.createEventId(),
      circleId: (await query<{ circle_id: string }>('SELECT circle_id FROM family_config WHERE family_id = $1', [familyId])).rows[0].circle_id,
      recipientIdentityId: offer.hostIdentityId,
      type: 'direct-chat:accepted',
      payload: {
        hostIdentityId: offer.hostIdentityId,
        guestIdentityId,
        registrationId: offer.registrationId,
        channelId: offer.channelId,
      },
      serverTimestamp: Date.now(),
    };
    await systemEventRepository.insertEvent({ ...notification, familyId, createdAt: notification.serverTimestamp });
    try { sendToIdentityWs(familyId, offer.hostIdentityId, { type: 'system:event', data: notification }); } catch { /* Durable sync delivers it. */ }
    return res.json({ status: 'ok', result: {
      registrationId: offer.registrationId,
      hostIdentityId: offer.hostIdentityId,
      permissions: mapDirectGuestPermissionsFromDb(updated),
    } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Accept channel subscriber chat offer error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
}));

router.post('/chat-offers/:eventId/decline', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  const familyId = req.familyId;
  const guestIdentityId = req.device?.identityId;
  const eventId = String(req.params.eventId || '').trim();
  if (!familyId || !guestIdentityId || !eventId || req.identity?.role !== 'guest') {
    return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'Guest identity is required' } } as ApiResponse);
  }
  const result = await query<{ event_id: string }>(
    `UPDATE system_events SET payload = payload || jsonb_build_object('declinedAt', NOW()::text)
      WHERE family_id = $1 AND event_id = $2 AND recipient_identity_id = $3
        AND type = 'invite:direct-chat' AND payload->>'acceptedAt' IS NULL
      RETURNING event_id`,
    [familyId, eventId, guestIdentityId]
  );
  if (!result.rows[0]) return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Chat offer is unavailable' } } as ApiResponse);
  return res.json({ status: 'ok', result: { eventId } } as ApiResponse);
}));

router.post('/registrations/:registrationId/chat-end', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const actorId = req.device?.identityId;
    const registrationId = String(req.params.registrationId || '').trim();
    const hostIdentityId = getSignedPayload<{ hostIdentityId?: string }>(req)?.hostIdentityId?.trim() || '';
    if (!familyId || !actorId || !registrationId || !hostIdentityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Registration and host are required' } } as ApiResponse);
    }
    const registration = await directGuestRegistrationRepository.findActiveByHost(familyId, registrationId, hostIdentityId);
    if (!registration || (actorId !== hostIdentityId && actorId !== registration.guest_identity_id)) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Direct chat not found' } } as ApiResponse);
    }
    if (!(registration.guest_can_message_host ?? registration.can_message)) {
      return res.json({ status: 'ok', result: { registrationId, permissions: mapDirectGuestPermissionsFromDb(registration) } } as ApiResponse);
    }
    const updated = await directGuestRegistrationRepository.updatePermissionsByHost({
      familyId, registrationId, hostIdentityId,
      canMessage: false, canCall: false, canDirectFileTransfer: false, canServerAttachments: false,
      hostCanMessageGuest: false, guestCanMessageHost: false,
      hostCanCallGuest: false, guestCanCallHost: false,
      hostCanDirectFileTransferGuest: false, guestCanDirectFileTransferHost: false,
      hostCanServerAttachmentsGuest: false, guestCanServerAttachmentsHost: false,
    });
    if (!updated) throw new Error('Failed to end direct chat');
    const config = await query<{ circle_id: string }>('SELECT circle_id FROM family_config WHERE family_id = $1', [familyId]);
    if (!config.rows[0]) throw new Error('Circle configuration is missing');
    for (const recipientIdentityId of [hostIdentityId, registration.guest_identity_id]) {
      const event: SystemEventRecord<'direct-chat:ended'> = {
        eventId: systemEventRepository.createEventId(), circleId: config.rows[0].circle_id,
        recipientIdentityId, type: 'direct-chat:ended',
        payload: { hostIdentityId, guestIdentityId: registration.guest_identity_id, registrationId },
        serverTimestamp: Date.now(),
      };
      await systemEventRepository.insertEvent({ ...event, familyId, createdAt: event.serverTimestamp });
      try { sendToIdentityWs(familyId, recipientIdentityId, { type: 'system:event', data: event }); } catch { /* Durable sync delivers it. */ }
    }
    return res.json({ status: 'ok', result: { registrationId, permissions: mapDirectGuestPermissionsFromDb(updated) } } as ApiResponse);
  } catch (error) {
    routeLogger.error('End direct guest chat error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
}));

export default router;
