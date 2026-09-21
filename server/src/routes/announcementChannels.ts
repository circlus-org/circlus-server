import announcementChannelReactionRoutes from './announcementChannelReactionRoutes';
import { versionedAccessOperation } from '../services/versionedAccessOperation';
import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  announcementChannelRepository,
  directGuestLinkRepository,
  identityRepository,
  serverAdminRepository,
} from '../db/repositories';
import {
  getSignedPayload,
  requireActiveIdentity,
  verifySignature,
  type AuthRequest,
} from '../middleware/auth';
import type { ApiResponse, ErrorCode, PublicKey, SignedRequest } from '../../../shared/types';
import { verifySignedRequest } from '../utils/crypto';
import { publicSiteGeneratorService } from '../services/publicSiteGeneratorService';
import { getRequestHost } from '../middleware/tenancy';
import { isBlockedManagedHost } from '../utils/publicSiteDomainPolicy';
import { normalizeSelfHostedPublicSiteImageUrl } from '../utils/publicSiteImageUrl';
import announcementChannelKeyRoutes from './announcementChannelKeyRoutes';
import announcementChannelPostRoutes from './announcementChannelPostRoutes';
import announcementChannelSubscriptionRoutes from './announcementChannelSubscriptionRoutes';
import { sendChannelPublicationRequestPush } from '../utils/push';
import { channelPostResult } from './announcementChannelPostSupport';

const router = Router();

function channelResult(
  channel: Awaited<ReturnType<typeof announcementChannelRepository.listVisibleForIdentity>>[number],
  viewerIdentityId: string,
  viewerRole?: string | null
) {
  const isChannelOwner = channel.owner_identity_id === viewerIdentityId;
  const canManagePublicSite = isChannelOwner || viewerRole === 'owner';
  const authorManagesServer = channel.disclose_server_admin_status === true
    && channel.author_is_circle_owner === true
    && channel.author_is_server_admin === true;
  return {
    channelId: channel.channel_id,
    ownerIdentityId: channel.owner_identity_id,
    // Display metadata is resolved from the encrypted payload by clients.
    title: '',
    description: null,
    authorIsCircleOwner: channel.author_is_circle_owner === true,
    authorManagesServer,
    metadata: channel.metadata_ciphertext && channel.metadata_epoch && channel.metadata_author_claim
      ? {
          epoch: Number(channel.metadata_epoch),
          revision: Number(channel.metadata_revision),
          ciphertext: channel.metadata_ciphertext,
          authorDeviceId: channel.metadata_author_device_id,
          authorClaim: channel.metadata_author_claim,
          authorDevicePublicKey: channel.metadata_author_device_public_key_algorithm
            && channel.metadata_author_device_public_key_value
            ? {
                algorithm: channel.metadata_author_device_public_key_algorithm,
                value: channel.metadata_author_device_public_key_value,
              }
            : null,
          authorDeviceEncryptionPublicKey: channel.metadata_author_device_encryption_public_key_algorithm
            && channel.metadata_author_device_encryption_public_key_value
            ? {
                algorithm: channel.metadata_author_device_encryption_public_key_algorithm,
                value: channel.metadata_author_device_encryption_public_key_value,
              }
            : null,
          authorDeviceRegistrationAttestation: channel.metadata_author_device_registration_attestation || null,
          authorIdentityPublicKey: channel.metadata_author_identity_public_key_algorithm
            && channel.metadata_author_identity_public_key_value
            ? {
                algorithm: channel.metadata_author_identity_public_key_algorithm,
                value: channel.metadata_author_identity_public_key_value,
              }
            : null,
        }
      : null,
    reactionsEnabled: channel.reactions_enabled === true,
    subscription: channel.subscription_id
      ? {
          subscriptionId: channel.subscription_id,
          status: channel.subscription_status,
          notificationsEnabled: channel.notifications_enabled === true,
          sourceLinkId: channel.source_link_id,
          keyStatus: channel.key_status || 'pending',
          lastReceivedSequence: channel.last_received_sequence === null ? null : Number(channel.last_received_sequence),
          lastReadSequence: channel.last_read_sequence === null ? null : Number(channel.last_read_sequence),
        }
      : null,
    createdAt: channel.created_at.toISOString(),
    keyEpoch: Number(channel.key_epoch || 1),
    ...(isChannelOwner
      ? {
          isDefault: channel.is_default,
          status: channel.status,
          linkCount: Number(channel.link_count || 0),
          subscriberCount: Number(channel.subscriber_count || 0),
          updatedAt: channel.updated_at.toISOString(),
          serverAdminDisclosureEnabled: channel.disclose_server_admin_status === true,
          canDiscloseServerAdmin: channel.author_is_circle_owner === true
            && channel.author_is_server_admin === true,
        }
      : {}),
    ...(canManagePublicSite
      ? {
          publicSite: {
            state: channel.public_site_state,
            visible: channel.public_site_visible,
            slug: channel.public_site_slug,
            ctaLabel: channel.public_site_cta_label,
            introTitle: channel.public_site_intro_title,
            introText: channel.public_site_intro_text,
            introImageUrl: normalizeSelfHostedPublicSiteImageUrl(channel.public_site_intro_image_url),
            guestLinkId: channel.public_site_guest_link_id,
            guestLinkUrl: channel.public_site_guest_link_url,
            requestedByIdentityId: channel.public_site_requested_by_identity_id,
            requestedAt: channel.public_site_requested_at?.toISOString() || null,
            approvedByIdentityId: channel.public_site_approved_by_identity_id,
            approvedAt: channel.public_site_approved_at?.toISOString() || null,
          },
        }
      : {}),
  };
}

function normalizeText(value: unknown, maxLength: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
}

function normalizeSlug(value: unknown, fallback: string): string {
  const raw = (typeof value === 'string' ? value : fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return raw || `channel-${fallback.replace(/[^a-z0-9]/gi, '').slice(-12).toLowerCase()}`;
}

function normalizeHttpUrl(value: unknown): string | null {
  const text = normalizeText(value, 1000);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

router.post('/mine', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Identity context is missing' }
      } as ApiResponse);
    }
    const channels = await announcementChannelRepository.listVisibleForIdentity({
      familyId,
      identityId,
      role: req.identity?.role,
    });
    return res.json({
      status: 'ok',
      result: channels.map((channel) => channelResult(channel, identityId, req.identity?.role)),
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List visible announcement channels error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/posts/activity', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Identity context is missing' } } as ApiResponse);
    }
    const payload = getSignedPayload<{ channelIds?: unknown }>(req);
    const channelIds = Array.isArray(payload.channelIds)
      ? [...new Set(payload.channelIds.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 500)
      : [];
    const activity = await announcementChannelRepository.listLatestPostActivity({ familyId, identityId, channelIds });
    return res.json({
      status: 'ok',
      result: {
        activity: activity.map((row) => ({
          channelId: row.channel_id,
          post: channelPostResult(row),
          unreadCount: Number(row.unread_count || 0),
        })),
      },
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Load channel post activity error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/create', verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Identity context is missing' }
      } as ApiResponse);
    }
    if (req.identity?.role !== 'owner' && req.identity?.role !== 'member') {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only Circle members can create channels' }
      } as ApiResponse);
    }
    const channel = await announcementChannelRepository.create({
      familyId,
      ownerIdentityId: identityId,
    });
    const visible = await announcementChannelRepository.listVisibleForIdentity({
      familyId,
      identityId,
      role: req.identity?.role,
    });
    const result = visible.find((item) => item.channel_id === channel.channel_id);
    if (!result) throw new Error('Created channel is not visible to its owner');
    return res.json({
      status: 'ok',
      result: channelResult(result, identityId, req.identity?.role),
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Create announcement channel error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.post('/:channelId/update', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
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
      epoch?: unknown;
      expectedRevision?: unknown;
      ciphertext?: unknown;
      authorClaim?: SignedRequest<Record<string, unknown>>;
    }>(req);
    const epoch = Number(payload.epoch);
    const expectedRevision = Number(payload.expectedRevision);
    const ciphertext = typeof payload.ciphertext === 'string' ? payload.ciphertext : '';
    const claimPayload = { version: 1, channelId, epoch, expectedRevision, ciphertext };
    if (!Number.isSafeInteger(epoch) || epoch < 1
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !ciphertext.startsWith('gcm1:') || ciphertext.length > 65_536
      || !payload.authorClaim
      || payload.authorClaim.type !== 'channel:metadata:update'
      || payload.authorClaim.signerId !== req.device?.deviceId
      || JSON.stringify(payload.authorClaim.payload) !== JSON.stringify(claimPayload)
      || !verifySignedRequest(payload.authorClaim, req.device?.publicKey as PublicKey)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Valid encrypted channel metadata is required' }
      } as ApiResponse);
    }
    const channel = await announcementChannelRepository.findById(familyId, channelId);
    if (!channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' }
      } as ApiResponse);
    }
    const updated = await announcementChannelRepository.updateMetadata({
      familyId,
      channelId,
      ownerIdentityId: identityId,
      epoch,
      expectedRevision,
      ciphertext,
      authorDeviceId: req.device!.deviceId,
      authorClaim: payload.authorClaim,
    });
    if (!updated) {
      return res.status(409).json({ status: 'error', error: {
        code: 'INVALID_STATE' as ErrorCode,
        message: 'Channel metadata revision or key epoch changed'
      } } as ApiResponse);
    }
    const visible = await announcementChannelRepository.listVisibleForIdentity({
      familyId,
      identityId,
      role: req.identity?.role,
    });
    const result = visible.find((item) => item.channel_id === channelId);
    if (!result) throw new Error('Updated channel is not visible to its owner');
    return res.json({
      status: 'ok',
      result: channelResult(result, identityId, req.identity?.role),
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Update announcement channel error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/:channelId/server-admin-disclosure', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const payload = getSignedPayload<{ enabled?: unknown }>(req);
    if (!familyId || !identityId || !channelId || typeof payload.enabled !== 'boolean') {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'channelId and enabled are required' }
      } as ApiResponse);
    }

    const channel = await announcementChannelRepository.findById(familyId, channelId);
    if (!channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' }
      } as ApiResponse);
    }

    if (payload.enabled) {
      const isServerAdmin = await serverAdminRepository.isActiveServerAdmin(identityId);
      if (req.identity?.role !== 'owner' || !isServerAdmin) {
        return res.status(403).json({
          status: 'error',
          error: {
            code: 'FORBIDDEN' as ErrorCode,
            message: 'Circle owner and server admin access are required'
          }
        } as ApiResponse);
      }
    }

    const updated = await announcementChannelRepository.updateServerAdminDisclosure({
      familyId,
      channelId,
      ownerIdentityId: identityId,
      enabled: payload.enabled,
    });
    if (!updated) throw new Error('Failed to update server admin disclosure');

    const visible = await announcementChannelRepository.listVisibleForIdentity({
      familyId,
      identityId,
      role: req.identity?.role,
    });
    const result = visible.find((item) => item.channel_id === channelId);
    if (!result) throw new Error('Updated channel is not visible to its owner');
    return res.json({
      status: 'ok',
      result: channelResult(result, identityId, req.identity?.role),
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Update channel server admin disclosure error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.post('/by-link/:linkId/ensure', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const linkId = String(req.params.linkId || '').trim();
    if (!familyId || !identityId || !linkId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'linkId is required' }
      } as ApiResponse);
    }
    if (req.identity?.role !== 'owner' && req.identity?.role !== 'member') {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'Member access required' }
      } as ApiResponse);
    }

    const link = await directGuestLinkRepository.findById(familyId, linkId);
    if (!link || link.host_identity_id !== identityId) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Direct guest link not found' }
      } as ApiResponse);
    }
    if (!link.auto_subscribe_to_channel) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Automatic channel subscription is not enabled for this link' }
      } as ApiResponse);
    }

    const channel = await announcementChannelRepository.ensureDefaultForLink({
      familyId,
      linkId,
      ownerIdentityId: identityId,
    });
    const visible = await announcementChannelRepository.listVisibleForIdentity({
      familyId,
      identityId,
      role: req.identity?.role,
    });
    const result = visible.find((item) => item.channel_id === channel.channel_id);
    if (!result) throw new Error('Created channel is not visible to its owner');
    return res.json({
      status: 'ok',
      result: channelResult(result, identityId, req.identity?.role),
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Ensure announcement channel for guest link error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/:channelId/public-site', verifySignature, requireActiveIdentity, versionedAccessOperation(async (req: AuthRequest, res) => {
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
    if (!channel || channel.status !== 'active') {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' }
      } as ApiResponse);
    }
    const isChannelOwner = channel.owner_identity_id === identityId;
    const isCircleOwner = req.identity?.role === 'owner';
    if (!isChannelOwner && !isCircleOwner) {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'Channel author or Circle owner access required' }
      } as ApiResponse);
    }
    const payload = getSignedPayload<{
      action?: unknown;
      slug?: unknown;
      ctaLabel?: unknown;
      introTitle?: unknown;
      introText?: unknown;
      guestLinkId?: unknown;
      guestLinkUrl?: unknown;
    }>(req);
    const requestedAction = typeof payload.action === 'string' ? payload.action : '';
    const allowedActions = new Set(['publish', 'request', 'cancel', 'approve', 'reject', 'hide', 'update']);
    if (!allowedActions.has(requestedAction)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'A valid public-site action is required' }
      } as ApiResponse);
    }

    let state = channel.public_site_state;
    const isApprovedAuthorUpdate = isChannelOwner
      && !isCircleOwner
      && requestedAction === 'update'
      && channel.public_site_state === 'published';
    if (isChannelOwner && isCircleOwner) {
      if (requestedAction === 'publish' || requestedAction === 'approve') state = 'published';
      else if (requestedAction === 'hide' || requestedAction === 'cancel' || requestedAction === 'reject') state = 'hidden';
    } else if (isChannelOwner) {
      if (requestedAction === 'request' || requestedAction === 'publish') state = 'requested';
      else if (requestedAction === 'update') state = channel.public_site_state;
      else if (requestedAction === 'cancel' || requestedAction === 'hide') state = 'hidden';
      else {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only the Circle owner can approve publication' }
        } as ApiResponse);
      }
    } else if (isCircleOwner) {
      if (requestedAction === 'approve' || requestedAction === 'publish') {
        if (channel.public_site_state !== 'requested') {
          return res.status(409).json({
            status: 'error',
            error: { code: 'INVALID_STATE' as ErrorCode, message: 'The channel author has not requested publication' }
          } as ApiResponse);
        }
        state = 'published';
      }
      else if (requestedAction === 'reject' || requestedAction === 'hide') state = 'hidden';
      else {
        return res.status(403).json({
          status: 'error',
          error: { code: 'FORBIDDEN' as ErrorCode, message: 'The Circle owner can approve, reject or hide this channel' }
        } as ApiResponse);
      }
    }

    if (state !== 'hidden' && isBlockedManagedHost(getRequestHost(req as any))) {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'Public site publishing is not available on this domain' }
      } as ApiResponse);
    }
    if (state === 'published' && !isCircleOwner && !isApprovedAuthorUpdate) {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only the Circle owner can publish a channel' }
      } as ApiResponse);
    }

    const guestLinkId = payload.guestLinkId === undefined
      ? channel.public_site_guest_link_id
      : normalizeText(payload.guestLinkId, 120);
    if (guestLinkId && state !== 'hidden') {
      const [sourceChannel, sourceLink] = await Promise.all([
        announcementChannelRepository.findByLink(familyId, guestLinkId),
        directGuestLinkRepository.findById(familyId, guestLinkId),
      ]);
      if (sourceChannel?.channel_id !== channelId || sourceLink?.status !== 'active') {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'The public guest link must be active and attached to this channel' }
        } as ApiResponse);
      }
    }
    const guestLinkUrl = payload.guestLinkUrl === undefined
      ? channel.public_site_guest_link_url
      : normalizeHttpUrl(payload.guestLinkUrl);
    if (!guestLinkId && guestLinkUrl) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'A public guest URL requires an attached guest link' }
      } as ApiResponse);
    }

    const updated = await announcementChannelRepository.updatePublicSite({
      familyId,
      channelId,
      visible: state === 'published',
      state,
      slug: payload.slug === undefined
        ? (channel.public_site_slug || normalizeSlug(channel.public_site_intro_title, channel.channel_id))
        : normalizeSlug(payload.slug, channel.channel_id),
      ctaLabel: payload.ctaLabel === undefined
        ? channel.public_site_cta_label
        : normalizeText(payload.ctaLabel, 80),
      introTitle: payload.introTitle === undefined
        ? channel.public_site_intro_title
        : normalizeText(payload.introTitle, 160),
      introText: payload.introText === undefined
        ? channel.public_site_intro_text
        : normalizeText(payload.introText, 1200),
      // Updated only by the authenticated self-hosted site-image upload flow.
      introImageUrl: normalizeSelfHostedPublicSiteImageUrl(channel.public_site_intro_image_url),
      guestLinkId,
      guestLinkUrl,
      requestedByIdentityId: state === 'requested'
        ? channel.owner_identity_id
        : (channel.public_site_requested_by_identity_id || channel.owner_identity_id),
      approvedByIdentityId: state === 'published'
        ? (isApprovedAuthorUpdate ? channel.public_site_approved_by_identity_id : identityId)
        : null,
    });
    if (!updated) throw new Error('Failed to update announcement channel public-site state');
    if (channel.public_site_state !== 'requested' && updated.public_site_state === 'requested') {
      const owners = await identityRepository.findByRole(familyId, 'owner');
      const circleOwner = owners.find((owner) => owner.status === 'active');
      if (circleOwner && circleOwner.identity_id !== identityId) {
        void sendChannelPublicationRequestPush(familyId, circleOwner.identity_id, {
          channelId,
          channelTitle: channel.public_site_intro_title || 'Channel',
          requestingIdentityId: identityId,
          requestingIdentityName: undefined,
        }).catch((error) => {
          routeLogger.error('Channel publication request push failed:', error);
        });
      }
    }
    if (channel.public_site_visible || updated.public_site_visible) {
      await publicSiteGeneratorService.regenerateSite(familyId);
    }
    const visible = await announcementChannelRepository.listVisibleForIdentity({
      familyId,
      identityId,
      role: req.identity?.role,
    });
    const result = visible.find((item) => item.channel_id === channelId);
    if (!result) throw new Error('Updated channel is not visible to the viewer');
    return res.json({
      status: 'ok',
      result: channelResult(result, identityId, req.identity?.role),
    } as ApiResponse);
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'This public channel address is already in use' }
      } as ApiResponse);
    }
    routeLogger.error('Update announcement channel public site error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.use(announcementChannelReactionRoutes);
router.use(announcementChannelKeyRoutes);


router.use(announcementChannelPostRoutes);
router.use(announcementChannelSubscriptionRoutes);
export default router;
