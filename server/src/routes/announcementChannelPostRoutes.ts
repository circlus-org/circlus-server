import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import {
  announcementChannelRepository,
  circleSitePublicationRepository,
  circleSiteSettingsRepository
} from '../db/repositories';
import { getSignedPayload, requireActiveIdentity, verifySignature, type AuthRequest } from '../middleware/auth';
import type { ApiResponse, ErrorCode, PublicKey, SignedRequest } from '../../../shared/types';
import { circleSitePublicationService } from '../services/circleSitePublicationService';
import { sendMessagesReadPush } from '../utils/push';
import { configService } from '../services/configService';
import { canReadAnnouncementChannel } from './announcementChannelAccess';
import {
  buildPublicChannelUrl,
  buildPublicPublicationUrl,
  channelPostResult,
  validateChannelPostClaim
} from './announcementChannelPostSupport';

const router = Router();

function normalizeText(value: unknown, maxLength: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
}

function isCurrentChannelCiphertext(value: string | null): boolean {
  return value !== null && value.startsWith('gcm1:');
}

function isValidChannelPreview(value: string | null): boolean {
  return value === null || (value.length <= 65_536 && value.startsWith('npv2:'));
}
router.post('/:channelId/posts/create', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const deviceId = req.device?.deviceId;
    const channelId = String(req.params.channelId || '').trim();
    const channel = familyId ? await announcementChannelRepository.findById(familyId, channelId) : null;
    if (!familyId || !identityId || !deviceId || !channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' } } as ApiResponse);
    }
    const payload = getSignedPayload<{
      clientPostId?: unknown;
      clientCreatedAt?: unknown;
      epoch?: unknown;
      ciphertext?: unknown;
      notificationPreviewCiphertext?: unknown;
      authorClaim?: SignedRequest<Record<string, unknown>>;
      publicPost?: { publish?: unknown; title?: unknown; summary?: unknown; body?: unknown; bodyFormat?: unknown };
    }>(req);
    const clientPostId = String(payload.clientPostId || '').trim();
    const ciphertext = String(payload.ciphertext || '');
    const epoch = Number(payload.epoch);
    const preview = typeof payload.notificationPreviewCiphertext === 'string' ? payload.notificationPreviewCiphertext : null;
    if (!clientPostId || clientPostId.length > 160 || !ciphertext || ciphertext.length > 1_000_000 || !isCurrentChannelCiphertext(ciphertext) || !isValidChannelPreview(preview) || epoch !== Number(channel.key_epoch)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Encrypted channel post is invalid' } } as ApiResponse);
    }
    const claimPayload = {
      version: 1,
      channelId,
      clientPostId,
      clientCreatedAt: typeof payload.clientCreatedAt === 'number' ? payload.clientCreatedAt : null,
      epoch,
      ciphertext,
      notificationPreviewCiphertext: preview,
    };
    if (!validateChannelPostClaim({
      claim: payload.authorClaim,
      type: 'channel:post:create',
      expectedPayload: claimPayload,
      deviceId,
      devicePublicKey: req.device!.publicKey as PublicKey,
    })) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Channel post author signature is invalid' } } as ApiResponse);
    }
    const epochKey = await announcementChannelRepository.findEpochKey(familyId, channelId, epoch);
    const ownerEnvelope = await announcementChannelRepository.findKeyEnvelope(familyId, channelId, epoch, identityId);
    if (!epochKey || !ownerEnvelope) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Channel key is not initialized' } } as ApiResponse);
    }
    const created = await announcementChannelRepository.createPost({
      familyId,
      channelId,
      ownerIdentityId: identityId,
      authorDeviceId: deviceId,
      clientPostId,
      clientCreatedAt: typeof payload.clientCreatedAt === 'number' ? payload.clientCreatedAt : null,
      epoch,
      ciphertext,
      notificationPreviewCiphertext: preview,
      authorSignature: payload.authorClaim!.signature,
      authorSignedClaim: payload.authorClaim,
    });
    let publicPost: { published: boolean; reason?: string; url?: string; bodyFormat?: 'plain_text' | 'markdown' } | undefined;
    if (!created.deduplicated && payload.publicPost?.publish === true) {
      const siteSettings = await circleSiteSettingsRepository.findByFamilyId(familyId);
      if (channel.public_site_visible && siteSettings?.enabled === true) {
        const title = normalizeText(payload.publicPost.title, 200);
        const body = normalizeText(payload.publicPost.body, 50_000);
        if (title && body) {
          try {
            const publication = await circleSitePublicationService.publishChannelPost({
              familyId,
              channelId,
              sourceChannelPostId: created.post.post_id,
              authorIdentityId: identityId,
              title,
              summary: normalizeText(payload.publicPost.summary, 500),
              body,
              bodyFormat: payload.publicPost.bodyFormat === 'markdown' ? 'markdown' : 'plain_text',
              assetIds: [],
              existingPublishedBehavior: 'return',
            });
            const resolvedConfig = await configService.getResolvedFamilyConfig(familyId);
            publicPost = {
              published: true,
              bodyFormat: publication.body_format,
              url: buildPublicPublicationUrl(
                resolvedConfig.config?.public_base_url,
                channel.public_site_slug,
                publication.slug
              ),
            };
          } catch (error) {
            routeLogger.error('Publish channel post public copy error:', error);
            publicPost = { published: false, reason: 'PUBLISH_FAILED' };
          }
        } else {
          publicPost = { published: false, reason: 'INVALID_CONTENT' };
        }
      } else {
        publicPost = { published: false, reason: 'CHANNEL_NOT_PUBLISHED' };
      }
    }
    return res.json({ status: 'ok', result: { ...channelPostResult(created.post), deduplicated: created.deduplicated, publicPost } } as ApiResponse);
  } catch (error: any) {
    if (error?.code === 'CHANNEL_EPOCH_MISMATCH') {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Channel key epoch mismatch' } } as ApiResponse);
    }
    routeLogger.error('Create channel post error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/posts/:postId/edit', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const postId = String(req.params.postId || '').trim();
    const channel = familyId ? await announcementChannelRepository.findById(familyId, channelId) : null;
    if (!familyId || !identityId || !channel || channel.owner_identity_id !== identityId || channel.status !== 'active') {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' } } as ApiResponse);
    }
    const payload = getSignedPayload<{
      epoch?: unknown;
      expectedRevision?: unknown;
      ciphertext?: unknown;
      notificationPreviewCiphertext?: unknown;
      authorClaim?: SignedRequest<Record<string, unknown>>;
    }>(req);
    const epoch = Number(payload.epoch);
    const expectedRevision = Number(payload.expectedRevision);
    const ciphertext = String(payload.ciphertext || '');
    const preview = typeof payload.notificationPreviewCiphertext === 'string' ? payload.notificationPreviewCiphertext : null;
    if (epoch !== Number(channel.key_epoch) || !Number.isInteger(expectedRevision) || expectedRevision < 1 || !isCurrentChannelCiphertext(ciphertext) || !isValidChannelPreview(preview) || ciphertext.length > 1_000_000) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Encrypted channel post revision is invalid' } } as ApiResponse);
    }
    const claimPayload = {
      version: 1,
      channelId,
      postId,
      expectedRevision,
      epoch,
      ciphertext,
      notificationPreviewCiphertext: preview,
    };
    if (!validateChannelPostClaim({
      claim: payload.authorClaim,
      type: 'channel:post:edit',
      expectedPayload: claimPayload,
      deviceId: req.device!.deviceId,
      devicePublicKey: req.device!.publicKey as PublicKey,
    })) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Channel post edit signature is invalid' } } as ApiResponse);
    }
    const edited = await announcementChannelRepository.editPost({
      familyId,
      channelId,
      postId,
      ownerIdentityId: identityId,
      authorDeviceId: req.device!.deviceId,
      epoch,
      ciphertext,
      notificationPreviewCiphertext: preview,
      authorSignature: payload.authorClaim!.signature,
      authorSignedClaim: payload.authorClaim,
      expectedRevision,
    });
    if (!edited) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Channel post revision conflict' } } as ApiResponse);
    }
    return res.json({ status: 'ok', result: channelPostResult(edited) } as ApiResponse);
  } catch (error) {
    routeLogger.error('Edit channel post error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/posts/list', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    if (!familyId || !identityId || !await canReadAnnouncementChannel(familyId, channelId, identityId)) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Announcement channel not found' } } as ApiResponse);
    }
    const payload = getSignedPayload<{ afterSequence?: unknown; beforeSequence?: unknown; limit?: unknown; latest?: unknown }>(req);
    const afterSequence = Math.max(0, Number.isSafeInteger(payload.afterSequence) ? Number(payload.afterSequence) : 0);
    const beforeSequence = Number.isSafeInteger(payload.beforeSequence) && Number(payload.beforeSequence) > 0
      ? Number(payload.beforeSequence)
      : null;
    const limit = Math.min(200, Math.max(1, Number.isSafeInteger(payload.limit) ? Number(payload.limit) : 100));
    const latest = payload.latest === true;
    const rows = beforeSequence !== null
      ? await announcementChannelRepository.listPostsBefore({ familyId, channelId, beforeSequence, limit: limit + 1 })
      : latest
      ? await announcementChannelRepository.listLatestPosts({ familyId, channelId, limit: limit + 1 })
      : await announcementChannelRepository.listPosts({ familyId, channelId, afterSequence, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const posts = hasMore ? ((latest || beforeSequence !== null) ? rows.slice(1) : rows.slice(0, limit)) : rows;
    const publishedPublications = await circleSitePublicationRepository.listPublishedSourceChannelPostLinks(
      familyId,
      posts.map((post) => post.post_id)
    );
    const channel = await announcementChannelRepository.findById(familyId, channelId);
    const publicBaseUrl = publishedPublications.length > 0 || (channel?.public_site_visible && channel.public_site_slug)
      ? (await configService.getResolvedFamilyConfig(familyId)).config?.public_base_url || null
      : null;
    const publicChannelUrl = channel?.public_site_visible
      ? buildPublicChannelUrl(publicBaseUrl, channel.public_site_slug)
      : undefined;
    const publicationByPostId = new Map(
      publishedPublications.map((publication) => [publication.source_channel_post_id, publication])
    );
    const engagement = channel?.owner_identity_id === identityId
      ? await announcementChannelRepository.listPostEngagement({
          familyId,
          channelId,
          ownerIdentityId: identityId,
          sequences: posts.map((post) => Number(post.post_sequence)),
        })
      : new Map<number, { receivedCount: number; viewedCount: number }>();
    return res.json({
      status: 'ok',
      result: {
        channelId,
        ...(publicChannelUrl ? { publicChannelUrl } : {}),
        posts: posts.map((post) => {
          const publication = publicationByPostId.get(post.post_id);
          const url = publication
            ? buildPublicPublicationUrl(publicBaseUrl, channel?.public_site_slug, publication.slug)
            : undefined;
          return {
            ...channelPostResult(post),
            alreadyPublished: Boolean(publication),
            ...(publication ? { publicPost: { published: true, url, bodyFormat: publication.body_format } } : {}),
            ...(engagement.get(Number(post.post_sequence)) || {}),
          };
        }),
        syncedThrough: posts.length ? Number(posts[posts.length - 1].post_sequence) : afterSequence,
        hasMore,
      },
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List channel posts error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/read', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const payload = getSignedPayload<{ sequence?: unknown }>(req);
    const sequence = Number(payload.sequence);
    if (!familyId || !identityId || !Number.isSafeInteger(sequence) || sequence < 0) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'A valid channel sequence is required' } } as ApiResponse);
    }
    const readThrough = await announcementChannelRepository.markRead({ familyId, channelId, identityId, sequence });
    if (readThrough === null) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Active channel subscription not found' } } as ApiResponse);
    }
    void sendMessagesReadPush(familyId, identityId, { dialogId: channelId }).catch((error) => {
      routeLogger.error('Channel read push failed:', error);
    });
    return res.json({ status: 'ok', result: { channelId, readThrough } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Mark channel read error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/received', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const payload = getSignedPayload<{ sequence?: unknown }>(req);
    const sequence = Number(payload.sequence);
    if (!familyId || !identityId || !Number.isSafeInteger(sequence) || sequence < 0) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'A valid channel sequence is required' } } as ApiResponse);
    }
    const receivedThrough = await announcementChannelRepository.markReceived({ familyId, channelId, identityId, sequence });
    if (receivedThrough === null) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Active channel subscription or post not found' } } as ApiResponse);
    }
    return res.json({ status: 'ok', result: { channelId, receivedThrough } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Mark channel posts received error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/:channelId/posts/:postId/engagement', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.identity?.identityId;
    const channelId = String(req.params.channelId || '').trim();
    const postId = String(req.params.postId || '').trim();
    const payload = getSignedPayload<{ cursor?: unknown; limit?: unknown }>(req);
    const cursor = typeof payload.cursor === 'string' ? payload.cursor.trim() : '';
    const requestedLimit = Number(payload.limit || 20);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.max(1, Math.min(50, requestedLimit))
      : 20;
    if (!familyId || !identityId || !channelId || !postId) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Channel post context is required' } } as ApiResponse);
    }
    const [channel, post] = await Promise.all([
      announcementChannelRepository.findById(familyId, channelId),
      announcementChannelRepository.findPostById(familyId, postId),
    ]);
    if (!channel || channel.owner_identity_id !== identityId || !post || post.channel_id !== channelId) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Channel post not found' } } as ApiResponse);
    }
    const recipients = await announcementChannelRepository.listPostEngagementRecipients({
      familyId,
      channelId,
      ownerIdentityId: identityId,
      sequence: Number(post.post_sequence),
      afterSubscriberIdentityId: cursor || null,
      limit: limit + 1,
    });
    const hasMore = recipients.length > limit;
    const page = recipients.slice(0, limit);
    return res.json({
      status: 'ok',
      result: {
        channelId,
        postId,
        sequence: Number(post.post_sequence),
        recipients: page.map((recipient) => ({
          subscriptionId: recipient.subscription_id,
          subscriberIdentityId: recipient.subscriber_identity_id,
          subscriberIdentityName: null,
          sourceLinkId: recipient.source_link_id,
          subscriptionStatus: recipient.subscription_status,
          received: recipient.received,
          viewed: recipient.viewed,
        })),
        hasMore,
        nextCursor: hasMore ? page[page.length - 1]?.subscriber_identity_id || null : null,
      },
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List channel post engagement recipients error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});


export default router;
