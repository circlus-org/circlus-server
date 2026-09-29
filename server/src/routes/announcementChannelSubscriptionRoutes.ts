import { versionedAccessOperation } from '../services/versionedAccessOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { announcementChannelRepository, directGuestLinkRepository, identityRepository } from '../db/repositories';
import { getSignedPayload, requireActiveIdentity, verifySignature, type AuthRequest } from '../middleware/auth';
import type { ApiResponse, ChannelSubscriptionAcceptance, ErrorCode } from '../../../shared/types';
import type { LinkCapabilityDescriptor, LinkCapabilityProof } from '../../../shared/linkCapability';
import { verifyCapabilityProof } from '../services/linkCapabilityService';
import { verifySignedRequest } from '../utils/crypto';

const router = Router();
router.post('/:channelId/subscribe', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    if (!familyId || !identityId || !channelId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'channelId is required' }
      } as ApiResponse);
    }
    const payload = getSignedPayload<{
      notificationsEnabled?: unknown;
      sourceLinkId?: unknown;
      sourceLinkCapabilityId?: unknown;
      sourceLinkProof?: LinkCapabilityProof;
      subscriptionAcceptance?: ChannelSubscriptionAcceptance;
    }>(req);
    const sourceLinkId = typeof payload.sourceLinkId === 'string' && payload.sourceLinkId.trim()
      ? payload.sourceLinkId.trim()
      : null;
    const sourceLinkCapabilityId = typeof payload.sourceLinkCapabilityId === 'string'
      ? payload.sourceLinkCapabilityId.trim()
      : '';
    const subscriptionAcceptance = payload.subscriptionAcceptance;
    const subscriberIdentity = await identityRepository.findByIdentityId(familyId, identityId);
    const acceptancePayload = subscriptionAcceptance?.payload;
    if (
      !subscriberIdentity
      || subscriptionAcceptance?.type !== 'announcement-channel:subscription'
      || subscriptionAcceptance.signerId !== identityId
      || acceptancePayload?.version !== 1
      || acceptancePayload.purpose !== 'circlus-channel-subscription-v1'
      || acceptancePayload.channelId !== channelId
      || acceptancePayload.subscriberIdentityId !== identityId
      || acceptancePayload.sourceLinkId !== sourceLinkId
      || acceptancePayload.sourceLinkCapabilityId !== (sourceLinkCapabilityId || null)
      || JSON.stringify(acceptancePayload.sourceLinkProof) !== JSON.stringify(payload.sourceLinkProof || null)
      || !verifySignedRequest(subscriptionAcceptance, {
        algorithm: subscriberIdentity.public_key_algorithm as 'ed25519',
        value: subscriberIdentity.public_key_value,
      })
    ) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'A valid identity-signed channel subscription is required' }
      } as ApiResponse);
    }
    let hasSourceLinkCapability = false;
    if (sourceLinkId) {
      const [sourceChannel, sourceLink] = await Promise.all([
        announcementChannelRepository.findByLink(familyId, sourceLinkId),
        directGuestLinkRepository.findById(familyId, sourceLinkId),
      ]);
      const descriptor = sourceLink?.capability_descriptor as LinkCapabilityDescriptor | null | undefined;
      hasSourceLinkCapability = Boolean(
        sourceChannel?.channel_id === channelId
        && sourceLink?.status === 'active'
        && sourceLink.auto_subscribe_to_channel === true
        && sourceLink.expires_at
        && sourceLink.expires_at.getTime() > Date.now()
        && descriptor
        && sourceLinkCapabilityId === sourceLink.capability_id
        && payload.sourceLinkProof
        && verifyCapabilityProof({
          proof: payload.sourceLinkProof,
          descriptor,
          expectedAction: 'direct-guest:subscribe',
          expectedSubjectIdentityId: identityId
        })
        && payload.sourceLinkProof.payload.context?.channelId === channelId
      );
      if (!hasSourceLinkCapability) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid channel invitation' }
        } as ApiResponse);
      }
    }
    const existingSubscription = await announcementChannelRepository.findSubscriptionForIdentity(
      familyId,
      channelId,
      identityId
    );
    if (existingSubscription?.status === 'removed_by_author') {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'The channel author removed this subscription' }
      } as ApiResponse);
    }
    const canAccess = hasSourceLinkCapability || await announcementChannelRepository.canIdentityAccess({
      familyId,
      channelId,
      identityId,
      role: req.identity?.role,
    });
    if (!canAccess) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' }
      } as ApiResponse);
    }
    const subscription = await announcementChannelRepository.subscribe({
      familyId,
      channelId,
      identityId,
      sourceLinkId,
      notificationsEnabled: payload.notificationsEnabled !== false,
      subscriptionClaim: subscriptionAcceptance,
    });
    return res.json({
      status: 'ok',
      result: {
        subscriptionId: subscription.subscription_id,
        channelId: subscription.channel_id,
        status: subscription.status,
        notificationsEnabled: subscription.notifications_enabled,
        sourceLinkId: subscription.source_link_id,
        subscribedAt: subscription.subscribed_at.toISOString(),
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Subscribe to announcement channel error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.post('/:channelId/unsubscribe', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    if (!familyId || !identityId || !channelId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'channelId is required' }
      } as ApiResponse);
    }
    const subscription = await announcementChannelRepository.unsubscribe(familyId, channelId, identityId);
    if (!subscription) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Active channel subscription not found' }
      } as ApiResponse);
    }
    return res.json({
      status: 'ok',
      result: {
        subscriptionId: subscription.subscription_id,
        channelId: subscription.channel_id,
        status: subscription.status,
        notificationsEnabled: false,
        unsubscribedAt: subscription.unsubscribed_at?.toISOString() || null,
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Unsubscribe from announcement channel error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.post('/:channelId/notifications', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const payload = getSignedPayload<{ notificationsEnabled?: unknown }>(req);
    if (!familyId || !identityId || !channelId || typeof payload.notificationsEnabled !== 'boolean') {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: 'channelId and notificationsEnabled are required'
        }
      } as ApiResponse);
    }
    const subscription = await announcementChannelRepository.updateNotifications(
      familyId,
      channelId,
      identityId,
      payload.notificationsEnabled
    );
    if (!subscription) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Active channel subscription not found' }
      } as ApiResponse);
    }
    return res.json({
      status: 'ok',
      result: {
        subscriptionId: subscription.subscription_id,
        channelId: subscription.channel_id,
        status: subscription.status,
        notificationsEnabled: subscription.notifications_enabled,
        sourceLinkId: subscription.source_link_id,
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Update announcement channel notifications error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/:channelId/recipients', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    if (!familyId || !identityId || !channelId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'channelId is required' }
      } as ApiResponse);
    }
    const channel = await announcementChannelRepository.findById(familyId, channelId);
    if (!channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' }
      } as ApiResponse);
    }
    const recipients = await announcementChannelRepository.listActiveRecipients(
      familyId,
      channelId,
      identityId
    );
    return res.json({
      status: 'ok',
      result: recipients.map((recipient) => ({
        subscriptionId: recipient.subscription_id,
        registrationId: recipient.registration_id,
        canMessage: recipient.can_message,
        guestIdentityId: recipient.guest_identity_id,
        guestIdentityName: null,
        guestIdentityPublicKey: recipient.guest_public_key_algorithm && recipient.guest_public_key_value
          ? {
              algorithm: recipient.guest_public_key_algorithm,
              value: recipient.guest_public_key_value,
            }
          : null,
        sourceLinkId: recipient.source_link_id,
      })),
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List announcement channel recipients error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/:channelId/removed-recipients', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const channel = familyId ? await announcementChannelRepository.findById(familyId, channelId) : null;
    if (!familyId || !identityId || !channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' } } as ApiResponse);
    }
    const recipients = await announcementChannelRepository.listRemovedRecipients(familyId, channelId, identityId);
    return res.json({
      status: 'ok',
      result: recipients.map((recipient) => ({
        subscriptionId: recipient.subscription_id,
        registrationId: null,
        guestIdentityId: recipient.guest_identity_id,
        guestIdentityName: null,
        guestIdentityPublicKey: recipient.guest_public_key_algorithm && recipient.guest_public_key_value
          ? { algorithm: recipient.guest_public_key_algorithm, value: recipient.guest_public_key_value }
          : null,
        sourceLinkId: recipient.source_link_id,
      })),
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List removed channel recipients error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/recipients/:subscriberIdentityId/remove', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const subscriberIdentityId = String(req.params.subscriberIdentityId || '').trim();
    if (!familyId || !identityId || !channelId || !subscriberIdentityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Channel and subscriber are required' } } as ApiResponse);
    }
    const removed = await announcementChannelRepository.removeSubscriberByAuthor({
      familyId,
      channelId,
      ownerIdentityId: identityId,
      subscriberIdentityId,
    });
    if (!removed) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Active channel subscriber not found' } } as ApiResponse);
    }
    const channel = await announcementChannelRepository.findById(familyId, channelId);
    return res.json({ status: 'ok', result: {
      channelId,
      subscriberIdentityId,
      status: removed.status,
      keyEpoch: Number(channel?.key_epoch || 1),
    } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Remove channel subscriber error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
}));

router.post('/:channelId/recipients/:subscriberIdentityId/restore', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const subscriberIdentityId = String(req.params.subscriberIdentityId || '').trim();
    if (!familyId || !identityId || !channelId || !subscriberIdentityId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Channel and subscriber are required' } } as ApiResponse);
    }
    const restored = await announcementChannelRepository.restoreSubscriberByAuthor({
      familyId,
      channelId,
      ownerIdentityId: identityId,
      subscriberIdentityId,
    });
    if (!restored) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Removed channel subscriber not found' } } as ApiResponse);
    }
    return res.json({ status: 'ok', result: { channelId, subscriberIdentityId, status: restored.status } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Restore channel subscriber error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
}));


export default router;
