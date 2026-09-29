import { reliableOperation } from '../services/reliableOperation';
import { createHash } from 'node:crypto';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { verifySignature, requireActiveIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import { getRequestHost } from '../middleware/tenancy';
import { isBlockedManagedHost } from '../utils/publicSiteDomainPolicy';
import {
  attachmentRepository,
  announcementChannelRepository,
  circleFileAccessRepository,
  directGuestLinkRepository,
  identityRepository,
} from '../db/repositories';
import { mapDirectGuestPermissionsFromDb, normalizeDirectGuestPermissions } from '../services/directGuestAccessService';
import { attachmentStorageService } from '../services/attachmentStorageService';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import type { TenancyRequest } from '../middleware/tenancy';
import directGuestRegistrationRoutes from './directGuestRegistrationRoutes';
import directGuestChatOfferRoutes from './directGuestChatOfferRoutes';
import {
  canUseGuestServerAttachments,
  requireGuestLinkCreationAccess,
  requireGuestLinkManagementAccess
} from './directGuestLinkRouteSupport';
import {
  createDirectGuestLink,
  DirectGuestLinkMutationError,
  revokeDirectGuestLink
} from '../services/directGuestLinkMutationService';
import type { LinkCapabilityDescriptor, LinkCapabilityMode, LinkCapabilityRevocation } from '../../../shared/linkCapability';
import { verifyCapabilityDescriptor, verifyCapabilityRevocation } from '../services/linkCapabilityService';

const router = Router();
const DIRECT_GUEST_PRESENTATION_IMAGE_URL_MAX_LEN = 1000;
const PUBLIC_SITE_CHANNEL_SLUG_MAX_LEN = 80;
const PUBLIC_SITE_CTA_LABEL_MAX_LEN = 80;
const PUBLIC_SITE_INTRO_TITLE_MAX_LEN = 160;
const PUBLIC_SITE_INTRO_TEXT_MAX_LEN = 1200;
const PUBLIC_SITE_GUEST_LINK_URL_MAX_LEN = 2000;
const PUBLIC_SITE_CHANNEL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRESENTATION_IMAGE_MAX_DECODED_BYTES = 512 * 1024;
const ALLOWED_PRESENTATION_IMAGE_MIME_PREFIXES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function isEncryptedBlob(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const blob = value as Record<string, unknown>;
  return blob.cipher === 'aes-256-gcm'
    && typeof blob.data === 'string'
    && typeof blob.nonce === 'string'
    && blob.version === 1;
}

function normalizeText(value: unknown, maxLength: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
}

function normalizeImageUrl(value: unknown): string | null {
  const text = normalizeText(value, DIRECT_GUEST_PRESENTATION_IMAGE_URL_MAX_LEN);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeHttpUrl(value: unknown, maxLength: number): string | null {
  const text = normalizeText(value, maxLength);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const normalized = url.toString();
    return normalized.length <= maxLength ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeChannelSlug(value: unknown): string | null {
  const slug = normalizeText(value, PUBLIC_SITE_CHANNEL_SLUG_MAX_LEN)?.toLowerCase() ?? null;
  return slug && PUBLIC_SITE_CHANNEL_SLUG_PATTERN.test(slug) ? slug : null;
}

function buildRequestBaseUrl(req: AuthRequest): string {
  return String(req.protocol || 'https') + '://' + String(req.get('host') || '').replace(/\/$/, '');
}

router.get('/presentation-images/:blobId', async (req: TenancyRequest, res) => {
  try {
    const familyId = req.familyId;
    const blobId = String(req.params.blobId || '').trim();
    if (!familyId || !blobId) return res.status(404).end();

    const blob = await attachmentRepository.findBlobById(familyId, blobId);
    if (!blob || blob.status !== 'committed') return res.status(404).end();

    const stream = await attachmentStorageService.readBlob(blob.storage_key);
    res.setHeader('Content-Type', blob.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', blob.plaintext_size_bytes);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    stream.pipe(res);
  } catch (error) {
    routeLogger.error('Direct guest presentation image fetch error:', error);
    return res.status(500).end();
  }
});

router.post('/create', verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;

    if (!familyId || !hostIdentityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    if (!(await requireGuestLinkCreationAccess(req, res))) return;

    const payload = getSignedPayload<{
      canMessage?: boolean;
      canCall?: boolean;
      canDirectFileTransfer?: boolean;
      canServerAttachments?: boolean;
      hostCanMessageGuest?: boolean;
      guestCanMessageHost?: boolean;
      hostCanCallGuest?: boolean;
      guestCanCallHost?: boolean;
      hostCanDirectFileTransferGuest?: boolean;
      guestCanDirectFileTransferHost?: boolean;
      hostCanServerAttachmentsGuest?: boolean;
      guestCanServerAttachmentsHost?: boolean;
      autoSubscribeToChannel?: boolean;
      channelId?: string | null;
      privateMetadataCiphertext?: unknown;
      mode?: LinkCapabilityMode;
      expiresAt?: string;
      capabilityDescriptor?: LinkCapabilityDescriptor;
      encryptedSecret?: unknown;
      hostIdentityNameCiphertext?: unknown;
      presentationImageUrl?: unknown;
      publicSiteVisible?: unknown;
      publicSiteChannelSlug?: unknown;
      publicSiteCtaLabel?: unknown;
      publicSiteIntroTitle?: unknown;
      publicSiteIntroText?: unknown;
      publicSiteGuestLinkUrl?: unknown;
    }>(req);
    const autoSubscribeToChannel = payload.autoSubscribeToChannel === true;
    const requestedChannelId = autoSubscribeToChannel
      ? normalizeText(payload.channelId, 120)
      : null;
    if (autoSubscribeToChannel && !requestedChannelId) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'An existing channel is required for channel subscription' }
      } as ApiResponse);
    }
    const normalizedPermissions = normalizeDirectGuestPermissions({
      ...payload,
      autoSubscribeToChannel,
    });
    const guestServerAttachmentsAllowed = await canUseGuestServerAttachments(familyId, req.identity?.role);
    const permissions = normalizedPermissions
      ? {
          ...normalizedPermissions,
          canServerAttachments: guestServerAttachmentsAllowed ? normalizedPermissions.canServerAttachments : false,
          guestCanServerAttachmentsHost: guestServerAttachmentsAllowed ? normalizedPermissions.guestCanServerAttachmentsHost : false,
        }
      : null;
    if (!permissions) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'At least one permission must be enabled' }
      } as ApiResponse);
    }
    const mode: LinkCapabilityMode = payload.mode === 'single-use' ? 'single-use' : 'unlimited';
    const expiresAt = new Date(String(payload.expiresAt || ''));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'expiresAt must be within the next 365 days' }
      } as ApiResponse);
    }
    const presentationImageUrl = normalizeImageUrl(payload.presentationImageUrl);
    if (!isEncryptedBlob(payload.privateMetadataCiphertext)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Encrypted private link metadata is required' }
      } as ApiResponse);
    }
    if (payload.hostIdentityNameCiphertext !== undefined && !isEncryptedBlob(payload.hostIdentityNameCiphertext)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Encrypted host identity name is invalid' }
      } as ApiResponse);
    }

    // Public-site fields on /create are honored only for the owner on an eligible
    // domain. Members creating links must not be able to make them public.
    const canSetPublicSite = req.identity?.role === 'owner' && !isBlockedManagedHost(getRequestHost(req as any));
    const publicSiteVisible = canSetPublicSite ? payload.publicSiteVisible === true : false;
    const requestedPublicSiteChannelSlug = canSetPublicSite
      ? normalizeText(payload.publicSiteChannelSlug, PUBLIC_SITE_CHANNEL_SLUG_MAX_LEN)?.toLowerCase() ?? null
      : null;
    const publicSiteChannelSlug = canSetPublicSite ? normalizeChannelSlug(payload.publicSiteChannelSlug) : null;
    if (
      canSetPublicSite
      && (
        (requestedPublicSiteChannelSlug !== null && publicSiteChannelSlug === null)
        || (publicSiteVisible && publicSiteChannelSlug === null)
      )
    ) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: 'publicSiteChannelSlug must contain only lowercase letters, numbers, and hyphens'
        }
      } as ApiResponse);
    }
    const publicSiteCtaLabel = canSetPublicSite ? normalizeText(payload.publicSiteCtaLabel, PUBLIC_SITE_CTA_LABEL_MAX_LEN) : null;
    const publicSiteIntroTitle = canSetPublicSite ? normalizeText(payload.publicSiteIntroTitle, PUBLIC_SITE_INTRO_TITLE_MAX_LEN) : null;
    const publicSiteIntroText = canSetPublicSite ? normalizeText(payload.publicSiteIntroText, PUBLIC_SITE_INTRO_TEXT_MAX_LEN) : null;
    // Channel intro images are attached later through the authenticated,
    // self-hosted Circle Site image upload flow.
    const publicSiteIntroImageUrl = null;
    const publicSiteGuestLinkUrl = canSetPublicSite
      ? normalizeHttpUrl(payload.publicSiteGuestLinkUrl, PUBLIC_SITE_GUEST_LINK_URL_MAX_LEN)
      : null;

    if (requestedChannelId) {
      const requestedChannel = await announcementChannelRepository.findById(familyId, requestedChannelId);
      if (
        !requestedChannel
        || requestedChannel.owner_identity_id !== hostIdentityId
        || requestedChannel.status !== 'active'
      ) {
        return res.status(400).json({
          status: 'error',
          error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'The selected channel is not available for this guest link' }
        } as ApiResponse);
      }
    }

    const linkId = `dgl_${nanoid(22)}`;
    if (payload.encryptedSecret !== undefined && !isEncryptedBlob(payload.encryptedSecret)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'encryptedSecret must be an encrypted blob' }
      } as ApiResponse);
    }
    if (!payload.capabilityDescriptor || !isEncryptedBlob(payload.encryptedSecret)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Signed capability descriptor and encrypted secret are required' }
      } as ApiResponse);
    }
    const issuer = await identityRepository.findByIdentityId(familyId, hostIdentityId);
    if (!issuer || !(await verifyCapabilityDescriptor({
      descriptor: payload.capabilityDescriptor,
      issuerPublicKey: { algorithm: issuer.public_key_algorithm as 'ed25519', value: issuer.public_key_value },
      expectedKind: 'direct-guest',
      expectedIssuerIdentityId: hostIdentityId,
      expectedTargetIdentityId: hostIdentityId
    }))) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid capability descriptor' }
      } as ApiResponse);
    }
    const descriptorPayload = payload.capabilityDescriptor.payload;
    const expectedScope = {
      privateMetadataCiphertext: payload.privateMetadataCiphertext,
      permissions,
      channelId: autoSubscribeToChannel ? requestedChannelId : null,
      ...(payload.hostIdentityNameCiphertext !== undefined
        ? { hostIdentityNameCiphertext: payload.hostIdentityNameCiphertext }
        : {}),
    };
    if (
      descriptorPayload.mode !== mode
      || descriptorPayload.expiresAt !== expiresAt.toISOString()
      || JSON.stringify(descriptorPayload.scope) !== JSON.stringify(expectedScope)
    ) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Capability descriptor does not match guest-link settings' }
      } as ApiResponse);
    }

    const { created, announcementChannel } = await createDirectGuestLink({
      link: {
        linkId,
        familyId,
        hostIdentityId,
        createdByIdentityId: hostIdentityId,
        secretHash: descriptorPayload.capabilityId,
        encryptedSecret: payload.encryptedSecret ?? null,
        canMessage: permissions.canMessage,
        canCall: permissions.canCall,
        canDirectFileTransfer: permissions.canDirectFileTransfer,
        canServerAttachments: permissions.canServerAttachments,
        hostCanMessageGuest: permissions.hostCanMessageGuest,
        guestCanMessageHost: permissions.guestCanMessageHost,
        hostCanCallGuest: permissions.hostCanCallGuest,
        guestCanCallHost: permissions.guestCanCallHost,
        hostCanDirectFileTransferGuest: permissions.hostCanDirectFileTransferGuest,
        guestCanDirectFileTransferHost: permissions.guestCanDirectFileTransferHost,
        hostCanServerAttachmentsGuest: permissions.hostCanServerAttachmentsGuest,
        guestCanServerAttachmentsHost: permissions.guestCanServerAttachmentsHost,
        autoSubscribeToChannel: permissions.autoSubscribeToChannel,
        title: null,
        presentationTitle: null,
        presentationDescription: null,
        presentationImageUrl,
        maxUses: mode === 'single-use' ? 1 : null,
        capabilityId: descriptorPayload.capabilityId,
        capabilityMode: mode,
        capabilityDescriptor: payload.capabilityDescriptor,
        expiresAt,
        publicSiteVisible,
        publicSiteChannelSlug,
        publicSiteCtaLabel,
        publicSiteIntroTitle,
        publicSiteIntroText,
        publicSiteIntroImageUrl,
        publicSiteGuestLinkUrl,
      },
      requestedChannelId
    });

    return res.json({
      status: 'ok',
      result: {
        linkId: created.link_id,
        channelId: announcementChannel?.channel_id || null,
        permissions: mapDirectGuestPermissionsFromDb(created),
        title: null,
        presentation: {
          title: null,
          description: null,
          imageUrl: created.presentation_image_url || null,
        },
        publicSite: {
          visible: created.public_site_visible,
          channelSlug: created.public_site_channel_slug,
          ctaLabel: created.public_site_cta_label,
          introTitle: created.public_site_intro_title,
          introText: created.public_site_intro_text,
          introImageUrl: created.public_site_intro_image_url,
          guestLinkUrl: created.public_site_guest_link_url,
        },
        maxUses: created.max_uses,
        capabilityId: created.capability_id,
        capabilityMode: created.capability_mode,
        expiresAt: created.expires_at?.toISOString() || null,
        createdAt: created.created_at.toISOString(),
      }
    } as ApiResponse);
  } catch (error: any) {
    if (error instanceof DirectGuestLinkMutationError) {
      return res.status(error.status).json({
        status: 'error',
        error: { code: error.code as ErrorCode, message: error.message }
      } as ApiResponse);
    }
    if (error?.code === '23505') {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'This channel slug is already in use' }
      } as ApiResponse);
    }
    routeLogger.error('Create direct guest link error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.post('/presentation-image', verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    if (!(await requireGuestLinkManagementAccess(req, res))) return;

    const payload = getSignedPayload<{ imageBase64?: unknown; mimeType?: unknown; fileName?: unknown }>(req);
    const mimeType = (typeof payload.mimeType === 'string' ? payload.mimeType : '').toLowerCase();
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : 'guest-link-image';
    const imageBase64 = typeof payload.imageBase64 === 'string' ? payload.imageBase64 : '';

    if (!ALLOWED_PRESENTATION_IMAGE_MIME_PREFIXES.some((allowed) => mimeType.startsWith(allowed))) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Only JPEG, PNG, WebP and GIF images are supported' }
      } as ApiResponse);
    }
    if (!imageBase64) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'imageBase64 is required' }
      } as ApiResponse);
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(imageBase64, 'base64');
    } catch {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid base64 data' }
      } as ApiResponse);
    }
    if (imageBuffer.length === 0 || imageBuffer.length > PRESENTATION_IMAGE_MAX_DECODED_BYTES) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Image is empty or too large' }
      } as ApiResponse);
    }

    const blobId = `dglimg_${createHash('sha256').update(JSON.stringify([
      familyId, req.signedRequest!.signerId, req.signedRequest!.operationId
    ])).digest('hex')}`;
    const storageKey = attachmentStorageService.buildStorageKey(familyId, blobId);
    await attachmentStorageService.writeUploadBuffer({
      reservationId: `direct-guest-link-image-${blobId}`,
      storageKey,
      body: imageBuffer,
    });
    await attachmentRepository.createAvatarBlob({
      blobId,
      familyId,
      uploaderIdentityId: identityId,
      purpose: 'public_presentation',
      originalFileName: fileName,
      mimeType,
      sizeBytes: imageBuffer.length,
      storageKey,
    });
    await circleFileAccessRepository.grantAccess({ familyId, blobId, purpose: 'direct_guest_link_presentation' });

    const imageUrl = `${buildRequestBaseUrl(req)}/api/direct-guest-links/presentation-images/${encodeURIComponent(blobId)}`;
    return res.json({ status: 'ok', result: { blobId, imageUrl } } as ApiResponse<{ blobId: string; imageUrl: string }>);
  } catch (error) {
    routeLogger.error('Upload direct guest presentation image error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
}));

router.post('/presentation-image/:blobId/delete', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const blobId = String(req.params.blobId || '').trim();
    if (!familyId || !identityId) {
      return res.status(500).json({
        status: 'error',
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' }
      } as ApiResponse);
    }
    if (!(await requireGuestLinkManagementAccess(req, res))) return;
    if (!blobId.startsWith('dglimg_')) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Invalid presentation image' }
      } as ApiResponse);
    }

    const blob = await attachmentRepository.findBlobById(familyId, blobId);
    if (!blob) {
      return res.status(404).json({
        status: 'error',
        error: { code: 'NOT_FOUND' as ErrorCode, message: 'Presentation image not found' }
      } as ApiResponse);
    }
    if (blob.uploader_identity_id !== identityId) {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'Only the uploader can delete this image' }
      } as ApiResponse);
    }

    await directGuestLinkRepository.clearPresentationImageReferences(familyId, blobId);
    await circleFileAccessRepository.revokeAccess(familyId, blobId);
    const marked = await attachmentRepository.requestDeletion({
      familyId,
      blobId,
      deletedByIdentityId: identityId,
      deleteReason: 'user_request'
    });
    if (marked && marked.status !== 'deleted' && marked.status !== 'expired') {
      await attachmentStorageService.deleteBlob(marked.storage_key);
      await attachmentRepository.finalizeDeletion({ familyId, blobId, finalStatus: 'deleted' });
    }
    return res.json({ status: 'ok', result: { blobId, status: 'deleted' } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Delete direct guest presentation image error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to delete presentation image' }
    } as ApiResponse);
  }
});

router.post('/mine', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
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

    const links = await directGuestLinkRepository.listByHostIdentity(familyId, hostIdentityId);
    const channelMappings = await announcementChannelRepository.ensureHostLinkChannelMappings({
      familyId,
      ownerIdentityId: hostIdentityId,
      linkIds: links.map((link) => link.link_id),
      autoSubscribeLinkIds: links
        .filter((link) => link.status === 'active' && link.auto_subscribe_to_channel)
        .map((link) => link.link_id),
    });
    const channelIds = new Map(channelMappings.map((mapping) => [mapping.link_id, mapping.channel_id]));
    return res.json({
      status: 'ok',
      result: links.map((link) => ({
        linkId: link.link_id,
        channelId: channelIds.get(link.link_id) || null,
        permissions: mapDirectGuestPermissionsFromDb(link),
        encryptedSecret: link.encrypted_secret ?? null,
        capabilityId: link.capability_id ?? null,
        capabilityMode: link.capability_mode ?? null,
        capabilityDescriptor: link.capability_descriptor ?? null,
        expiresAt: link.expires_at?.toISOString() || null,
        status: link.status,
        title: null,
        presentation: {
          title: null,
          description: null,
          imageUrl: link.presentation_image_url || null,
        },
        publicSite: {
          visible: link.public_site_visible,
          channelSlug: link.public_site_channel_slug,
          ctaLabel: link.public_site_cta_label,
          introTitle: link.public_site_intro_title,
          introText: link.public_site_intro_text,
          introImageUrl: link.public_site_intro_image_url,
          guestLinkUrl: link.public_site_guest_link_url,
        },
        maxUses: link.max_uses,
        createdAt: link.created_at.toISOString(),
        revokedAt: link.revoked_at?.toISOString() || null,
        registrationCount: Number(link.registration_count || '0'),
        activeRegistrationCount: Number(link.active_registration_count || '0'),
      }))
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('List direct guest links error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/:linkId/revoke', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const hostIdentityId = req.device?.identityId;
    const linkId = String(req.params.linkId || '').trim();
    const payload = getSignedPayload<{ revocation: LinkCapabilityRevocation }>(req);
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

    const existing = await directGuestLinkRepository.findById(familyId, linkId);
    const issuer = await identityRepository.findByIdentityId(familyId, hostIdentityId);
    if (!existing || !existing.capability_id || !issuer || !payload.revocation || !verifyCapabilityRevocation({
      revocation: payload.revocation,
      issuerPublicKey: { algorithm: issuer.public_key_algorithm as 'ed25519', value: issuer.public_key_value },
      capabilityId: existing.capability_id,
      issuerIdentityId: hostIdentityId
    })) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Valid identity-signed revocation is required' }
      } as ApiResponse);
    }
    const outcome = await revokeDirectGuestLink({
      familyId,
      linkId,
      hostIdentityId
    });
    const revoked = outcome.revoked;
    await directGuestLinkRepository.setCapabilityRevocation(familyId, linkId, payload.revocation);

    return res.json({
      status: 'ok',
      result: {
        linkId: revoked.link_id,
        status: revoked.status,
        revokedAt: revoked.revoked_at?.toISOString() || null,
      }
    } as ApiResponse);
  } catch (error) {
    if (error instanceof DirectGuestLinkMutationError) {
      return res.status(error.status).json({
        status: 'error',
        error: { code: error.code as ErrorCode, message: error.message }
      } as ApiResponse);
    }
    routeLogger.error('Revoke direct guest link error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.post('/:linkId/delete', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
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

    const deleted = await directGuestLinkRepository.deleteRevokedEmpty(familyId, linkId, hostIdentityId);
    if (!deleted) {
      return res.status(409).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'Only revoked guest links without guests can be deleted'
        }
      } as ApiResponse);
    }

    return res.json({
      status: 'ok',
      result: {
        linkId: deleted.link_id,
        status: 'deleted'
      }
    } as ApiResponse<{ linkId: string; status: 'deleted' }>);
  } catch (error) {
    routeLogger.error('Delete empty direct guest link error:', error);
    return res.status(500).json({
      status: 'error',
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' }
    } as ApiResponse);
  }
});

router.use(directGuestRegistrationRoutes);
router.use(directGuestChatOfferRoutes);
export default router;
