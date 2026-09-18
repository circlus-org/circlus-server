import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import express, { Router } from 'express';
import { nanoid } from 'nanoid';
import { verifySignature, requireActiveIdentity, requireAdmin, getSignedPayload, type AuthRequest } from '../middleware/auth';
import { getRequestHost } from '../middleware/tenancy';
import {
  circleSiteSettingsRepository,
  announcementChannelRepository,
  circleSitePublicationAssetRepository,
  circleSitePublicationRepository,
  directGuestLinkRepository,
} from '../db/repositories';
import { publicSiteGeneratorService } from '../services/publicSiteGeneratorService';
import { isBlockedManagedHost } from '../utils/publicSiteDomainPolicy';
import { normalizeSelfHostedPublicSiteImageUrl } from '../utils/publicSiteImageUrl';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import { getStorageRuntimeConfig } from '../config/serverRuntimeConfig';
import { configService } from '../services/configService';
import { publicSiteAssetStorageService } from '../services/publicSiteAssetStorageService';
import {
  createAttachmentUploadToken,
  hashAttachmentUploadToken,
  verifyAttachmentUploadToken
} from '../utils/attachmentTokens';
import { getAttachmentsHttpBodyLimitBytes } from '../utils/attachmentHttpBodyLimit';
import { tryAcquireUploadSlot, UploadStreamError } from '../services/uploadStreamService';
import {
  circleSitePublicationService,
  PublicationAlreadyPublishedError,
  PublicationAssetsNotReadyError,
  PublicationStateChangedError,
} from '../services/circleSitePublicationService';
import { isCircleSiteImageMimeType } from '../../../shared/circleSiteAssets';
import type { CircleSiteImageSlot } from '../db/repositories/circleSitePublicationAssetRepository';

const router = Router();

const SITE_TITLE_MAX_LEN = 200;
const SITE_DESCRIPTION_MAX_LEN = 2000;
const PUBLICATION_TITLE_MAX_LEN = 200;
const PUBLICATION_SUMMARY_MAX_LEN = 500;
const PUBLICATION_BODY_MAX_LEN = 50000;
const PUBLIC_ASSET_NAME_MAX_LEN = 255;
const PUBLIC_ASSET_ALT_MAX_LEN = 500;
// Ten visible media items plus one generated poster for every video.
const PUBLICATION_ASSET_ID_LIMIT = 20;

function normalizeText(value: unknown, maxLength: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
}

function normalizeAssetIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  )).slice(0, PUBLICATION_ASSET_ID_LIMIT);
}

function buildSiteImageUrl(assetId: string, fileName: string): string {
  return `/site-images/${encodeURIComponent(assetId)}/${encodeURIComponent(fileName)}`;
}

async function assertPublicAssetCapacity(
  familyId: string,
  sizeBytes: number,
  res: express.Response
): Promise<boolean> {
  if (sizeBytes > getAttachmentsHttpBodyLimitBytes()) {
    res.status(400).json({
      status: 'error',
      error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'File exceeds HTTP upload limit' }
    } as ApiResponse);
    return false;
  }
  const config = await configService.getFamilyConfig(familyId);
  if (!config?.attachments_enabled) {
    res.status(403).json({
      status: 'error',
      error: { code: 'FORBIDDEN' as ErrorCode, message: 'Attachments are disabled' }
    } as ApiResponse);
    return false;
  }
  const maxFileSize = config.max_attachment_file_size_bytes === null
    ? null
    : Number(config.max_attachment_file_size_bytes);
  const maxStorage = config.attachment_storage_quota_bytes === null
    ? null
    : Number(config.attachment_storage_quota_bytes);
  const usedStorage = Number(config.used_attachment_storage_bytes || 0);
  const reservedStorage = Number(config.reserved_attachment_storage_bytes || 0);
  if (maxFileSize !== null && sizeBytes > maxFileSize) {
    res.status(400).json({
      status: 'error',
      error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'File exceeds max size' }
    } as ApiResponse);
    return false;
  }
  if (maxStorage !== null && usedStorage + reservedStorage + sizeBytes > maxStorage) {
    res.status(409).json({
      status: 'error',
      error: { code: 'QUOTA_EXCEEDED' as ErrorCode, message: 'Attachment storage quota exceeded' }
    } as ApiResponse);
    return false;
  }
  const minFreeBytes = getStorageRuntimeConfig().attachments.minFreeDiskBytes;
  const freeBytes = await publicSiteAssetStorageService.getFreeBytes();
  if (freeBytes - sizeBytes < minFreeBytes) {
    res.status(507).json({
      status: 'error',
      error: { code: 'INSUFFICIENT_STORAGE' as ErrorCode, message: 'Host free-space safety floor reached' }
    } as ApiResponse);
    return false;
  }
  return true;
}

async function canManageSiteImage(
  req: AuthRequest,
  slot: CircleSiteImageSlot,
  channelId: string | null
): Promise<boolean> {
  if (slot === 'cover') return canManageAllPublications(req);
  if (!channelId || !req.familyId || !req.identity?.identityId) return false;
  const channel = await announcementChannelRepository.findById(req.familyId, channelId);
  return Boolean(
    channel
    && channel.status === 'active'
    && channel.owner_identity_id === req.identity.identityId
  );
}

/**
 * Public-site publishing must be blocked in code for Circlus-managed subdomains,
 * even from a modified client. Applied to every write endpoint below.
 */
function assertPublicSiteAllowed(req: AuthRequest, res: { status: (code: number) => { json: (body: ApiResponse) => unknown } }): boolean {
  const host = getRequestHost(req as any);
  if (isBlockedManagedHost(host)) {
    res.status(403).json({
      status: 'error',
      error: { code: 'FORBIDDEN' as ErrorCode, message: 'Public site publishing is not available on this domain' }
    } as ApiResponse);
    return false;
  }
  return true;
}

function canManageAllPublications(req: AuthRequest): boolean {
  return req.identity?.role === 'owner' || req.identity?.role === 'admin' || req.identity?.role === 'superadmin';
}

async function ensurePublicSiteEnabled(
  familyId: string,
  res: { status: (code: number) => { json: (body: ApiResponse) => unknown } }
): Promise<boolean> {
  const settings = await circleSiteSettingsRepository.findByFamilyId(familyId);
  if (settings?.enabled === true) return true;
  res.status(409).json({
    status: 'error',
    error: { code: 'INVALID_STATE' as ErrorCode, message: 'The Circle public site is disabled' }
  } as ApiResponse);
  return false;
}

function settingsResult(familyId: string, isEligible: boolean, settings: Awaited<ReturnType<typeof circleSiteSettingsRepository.findByFamilyId>>) {
  return {
    familyId,
    eligible: isEligible,
    enabled: settings?.enabled ?? false,
    indexingEnabled: settings?.indexing_enabled ?? false,
    siteTitle: settings?.site_title ?? null,
    siteDescription: settings?.site_description ?? null,
    coverImageUrl: normalizeSelfHostedPublicSiteImageUrl(settings?.cover_image_url),
    theme: settings?.theme ?? 'default',
  };
}

function publicationResult(pub: NonNullable<Awaited<ReturnType<typeof circleSitePublicationRepository.findById>>>) {
  return {
    publicationId: pub.publication_id,
    familyId: pub.family_id,
    channelId: pub.channel_id,
    sourceLinkId: pub.source_link_id,
    sourceChannelPostId: pub.source_channel_post_id,
    authorIdentityId: pub.author_identity_id,
    slug: pub.slug,
    title: pub.title,
    summary: pub.summary,
    body: pub.body,
    bodyFormat: pub.body_format,
    status: pub.status,
    publishedAt: pub.published_at?.toISOString() ?? null,
    createdAt: pub.created_at.toISOString(),
    updatedAt: pub.updated_at.toISOString(),
  };
}

router.post('/settings/get', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    const host = getRequestHost(req as any);
    const settings = await circleSiteSettingsRepository.findByFamilyId(familyId);
    return res.json({ status: 'ok', result: settingsResult(familyId, !isBlockedManagedHost(host), settings) } as ApiResponse);
  } catch (error) {
    routeLogger.error('Get circle site settings error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/settings/update', verifySignature, requireActiveIdentity, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (!assertPublicSiteAllowed(req, res)) return;

    const payload = getSignedPayload<{
      enabled?: unknown;
      indexingEnabled?: unknown;
      siteTitle?: unknown;
      siteDescription?: unknown;
    }>(req);

    const settings = await circleSiteSettingsRepository.upsert({
      familyId,
      enabled: payload.enabled === true,
      indexingEnabled: payload.indexingEnabled === true,
      siteTitle: normalizeText(payload.siteTitle, SITE_TITLE_MAX_LEN),
      siteDescription: normalizeText(payload.siteDescription, SITE_DESCRIPTION_MAX_LEN),
    });

    await publicSiteGeneratorService.regenerateSite(familyId);

    return res.json({ status: 'ok', result: settingsResult(familyId, true, settings) } as ApiResponse);
  } catch (error) {
    routeLogger.error('Update circle site settings error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/publications/list', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    const publications = (await circleSitePublicationRepository.listAllByFamily(familyId)).filter(
      (publication) => canManageAllPublications(req)
        || publication.author_identity_id === req.identity?.identityId
    );
    return res.json({ status: 'ok', result: { publications: publications.map(publicationResult) } } as ApiResponse);
  } catch (error) {
    routeLogger.error('List circle site publications error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/site-images/reservations', verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const uploaderIdentityId = req.identity?.identityId;
    if (!familyId || !uploaderIdentityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (!assertPublicSiteAllowed(req, res)) return;
    const payload = getSignedPayload<{
      slot?: unknown;
      channelId?: unknown;
      fileName?: unknown;
      mimeType?: unknown;
      sizeBytes?: unknown;
      width?: unknown;
      height?: unknown;
    }>(req);
    const slot: CircleSiteImageSlot | null = payload.slot === 'cover' || payload.slot === 'channel_intro'
      ? payload.slot
      : null;
    const channelId = typeof payload.channelId === 'string' && payload.channelId.trim()
      ? payload.channelId.trim()
      : null;
    const fileName = normalizeText(payload.fileName, PUBLIC_ASSET_NAME_MAX_LEN);
    const mimeType = normalizeText(payload.mimeType, 200) || '';
    const sizeBytes = Number(payload.sizeBytes || 0);
    const width = Number(payload.width || 0);
    const height = Number(payload.height || 0);
    if (
      !slot
      || !fileName
      || !isCircleSiteImageMimeType(mimeType)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes <= 0
      || (slot === 'cover' && channelId !== null)
      || (slot === 'channel_intro' && channelId === null)
    ) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Valid self-hosted site image metadata is required' }
      } as ApiResponse);
    }
    if (!await canManageSiteImage(req, slot, channelId)) {
      return res.status(403).json({
        status: 'error',
        error: { code: 'FORBIDDEN' as ErrorCode, message: 'You cannot change this public site image' }
      } as ApiResponse);
    }
    if (!await assertPublicAssetCapacity(familyId, sizeBytes, res)) return;

    const assetId = `siteimg_${nanoid(24)}`;
    const uploadToken = createAttachmentUploadToken();
    const reservedUntil = new Date(
      Date.now() + getStorageRuntimeConfig().attachments.reservationTtlMs
    );
    const asset = await circleSitePublicationAssetRepository.createSiteImageReservation({
      assetId,
      familyId,
      uploaderIdentityId,
      slot,
      channelId,
      originalFileName: fileName,
      mimeType,
      sizeBytes,
      width: Number.isInteger(width) && width > 0 ? width : null,
      height: Number.isInteger(height) && height > 0 ? height : null,
      storageKey: publicSiteAssetStorageService.buildStorageKey(familyId, assetId),
      uploadTokenHash: hashAttachmentUploadToken(uploadToken),
      reservedUntil,
    });
    return res.json({
      status: 'ok',
      result: {
        assetId: asset.asset_id,
        uploadToken,
        uploadUrl: `/api/circle-site/assets/uploads/${encodeURIComponent(asset.asset_id)}`,
        reservedUntil: reservedUntil.toISOString(),
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Create public site image reservation error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to reserve public site image' } } as ApiResponse);
  }
}));

router.post('/site-images/remove', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (!assertPublicSiteAllowed(req, res)) return;
    const payload = getSignedPayload<{ slot?: unknown; channelId?: unknown }>(req);
    const slot: CircleSiteImageSlot | null = payload.slot === 'cover' || payload.slot === 'channel_intro'
      ? payload.slot
      : null;
    const channelId = typeof payload.channelId === 'string' && payload.channelId.trim()
      ? payload.channelId.trim()
      : null;
    if (!slot || (slot === 'cover' && channelId !== null) || (slot === 'channel_intro' && channelId === null)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Valid site image slot is required' } } as ApiResponse);
    }
    if (!await canManageSiteImage(req, slot, channelId)) {
      return res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN' as ErrorCode, message: 'You cannot change this public site image' } } as ApiResponse);
    }
    await circleSitePublicationAssetRepository.removeSiteImage({ familyId, slot, channelId });
    await publicSiteGeneratorService.regenerateSite(familyId);
    return res.json({ status: 'ok', result: { slot, channelId, imageUrl: null } } as ApiResponse);
  } catch (error) {
    routeLogger.error('Remove public site image error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to remove public site image' } } as ApiResponse);
  }
});

router.post('/assets/reservations', verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const uploaderIdentityId = req.identity?.identityId;
    if (!familyId || !uploaderIdentityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (!assertPublicSiteAllowed(req, res)) return;
    if (!await ensurePublicSiteEnabled(familyId, res)) return;

    const payload = getSignedPayload<{
      sourceChannelPostId?: unknown;
      kind?: unknown;
      fileName?: unknown;
      mimeType?: unknown;
      sizeBytes?: unknown;
      width?: unknown;
      height?: unknown;
      altText?: unknown;
    }>(req);
    const sourceChannelPostId = String(payload.sourceChannelPostId || '').trim();
    const kind = payload.kind === 'image' || payload.kind === 'download'
      ? payload.kind
      : null;
    const fileName = normalizeText(payload.fileName, PUBLIC_ASSET_NAME_MAX_LEN);
    const mimeType = normalizeText(payload.mimeType, 200) || 'application/octet-stream';
    const sizeBytes = Number(payload.sizeBytes || 0);
    const width = Number(payload.width || 0);
    const height = Number(payload.height || 0);
    if (!sourceChannelPostId || !kind || !fileName || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Valid public asset metadata is required' }
      } as ApiResponse);
    }
    if (kind === 'image' && !isCircleSiteImageMimeType(mimeType)) {
      return res.status(400).json({
        status: 'error',
        error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Unsupported public image type' }
      } as ApiResponse);
    }

    const channelPost = await announcementChannelRepository.findPostById(familyId, sourceChannelPostId);
    const channel = channelPost
      ? await announcementChannelRepository.findById(familyId, channelPost.channel_id)
      : null;
    if (
      !channelPost
      || channelPost.author_identity_id !== uploaderIdentityId
      || Boolean(channelPost.deleted_at)
      || !channel?.public_site_visible
    ) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'The source post must belong to a published channel' }
      } as ApiResponse);
    }

    if (!await assertPublicAssetCapacity(familyId, sizeBytes, res)) return;

    const assetId = `pubasset_${nanoid(24)}`;
    const uploadToken = createAttachmentUploadToken();
    const reservedUntil = new Date(
      Date.now() + getStorageRuntimeConfig().attachments.reservationTtlMs
    );
    const asset = await circleSitePublicationAssetRepository.createReservation({
      assetId,
      familyId,
      sourceChannelPostId,
      uploaderIdentityId,
      kind,
      originalFileName: fileName,
      mimeType,
      sizeBytes,
      width: kind === 'image' && Number.isInteger(width) && width > 0 ? width : null,
      height: kind === 'image' && Number.isInteger(height) && height > 0 ? height : null,
      altText: kind === 'image'
        ? normalizeText(payload.altText, PUBLIC_ASSET_ALT_MAX_LEN)
        : null,
      storageKey: publicSiteAssetStorageService.buildStorageKey(familyId, assetId),
      uploadTokenHash: hashAttachmentUploadToken(uploadToken),
      reservedUntil,
    });
    return res.json({
      status: 'ok',
      result: {
        assetId: asset.asset_id,
        uploadToken,
        uploadUrl: `/api/circle-site/assets/uploads/${encodeURIComponent(asset.asset_id)}`,
        reservedUntil: reservedUntil.toISOString(),
      }
    } as ApiResponse);
  } catch (error) {
    routeLogger.error('Create public asset reservation error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to reserve public asset' } } as ApiResponse);
  }
}));

router.put('/assets/uploads/:assetId', async (req: AuthRequest, res) => {
  let releaseUploadSlot: (() => void) | null = null;
  try {
    const familyId = req.familyId;
    const assetId = String(req.params.assetId || '').trim();
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (!familyId || !assetId || !token) {
      return res.status(401).json({ status: 'error', error: { code: 'UNAUTHORIZED' as ErrorCode, message: 'Upload token is required' } } as ApiResponse);
    }
    if (contentType !== 'application/octet-stream') {
      return res.status(415).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Content-Type must be application/octet-stream' } } as ApiResponse);
    }
    const asset = await circleSitePublicationAssetRepository.findById(familyId, assetId);
    if (
      !asset
      || asset.status !== 'reserved'
      || !asset.upload_token_hash
      || !verifyAttachmentUploadToken(token, asset.upload_token_hash)
    ) {
      return res.status(401).json({ status: 'error', error: { code: 'UNAUTHORIZED' as ErrorCode, message: 'Invalid upload token' } } as ApiResponse);
    }
    if (!asset.reserved_until || asset.reserved_until.getTime() < Date.now()) {
      return res.status(410).json({ status: 'error', error: { code: 'EXPIRED' as ErrorCode, message: 'Upload reservation expired' } } as ApiResponse);
    }

    const maxBytes = getAttachmentsHttpBodyLimitBytes();
    const expectedBytes = Number(asset.size_bytes);
    const contentLengthHeader = req.headers['content-length'];
    const contentLength = contentLengthHeader === undefined ? null : Number(contentLengthHeader);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'Content-Length must be a non-negative integer' } } as ApiResponse);
    }
    if (expectedBytes > maxBytes || (contentLength !== null && contentLength > maxBytes)) {
      return res.status(413).json({ status: 'error', error: { code: 'PAYLOAD_TOO_LARGE' as ErrorCode, message: 'Asset upload body exceeds HTTP body limit' } } as ApiResponse);
    }
    if (contentLength !== null && contentLength !== expectedBytes) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: `Upload size must be exactly ${expectedBytes} bytes` } } as ApiResponse);
    }

    const slot = tryAcquireUploadSlot(`public-site-asset:${familyId}:${assetId}`);
    if (!slot.acquired) {
      const status = slot.reason === 'duplicate' ? 409 : 503;
      const message = slot.reason === 'duplicate'
        ? 'This asset is already being uploaded'
        : 'Upload capacity is temporarily exhausted';
      return res.status(status).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message } } as ApiResponse);
    }
    releaseUploadSlot = slot.release;

    const upload = await publicSiteAssetStorageService.writeUploadStream({
      assetId,
      storageKey: asset.storage_key,
      source: req,
      maxBytes,
      expectedBytes
    });
    const ready = asset.site_image_slot
      ? await circleSitePublicationAssetRepository.publishSiteImage({
          familyId,
          assetId,
          sizeBytes: upload.bytesWritten,
        })
      : await circleSitePublicationAssetRepository.markReady({
          familyId,
          assetId,
          sizeBytes: upload.bytesWritten,
        });
    if (!ready) {
      return res.status(409).json({ status: 'error', error: { code: 'INVALID_STATE' as ErrorCode, message: 'Asset reservation state changed' } } as ApiResponse);
    }
    if (ready.site_image_slot) await publicSiteGeneratorService.regenerateSite(familyId);
    return res.json({
      status: 'ok',
      result: {
        assetId,
        status: ready.status,
        ...(ready.site_image_slot
          ? { imageUrl: buildSiteImageUrl(ready.asset_id, ready.original_file_name) }
          : {}),
      }
    } as ApiResponse);
  } catch (error) {
    if (error instanceof UploadStreamError) {
      const status = error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
      return res.status(status).json({ status: 'error', error: { code: error.code as ErrorCode, message: error.message } } as ApiResponse);
    }
    routeLogger.error('Upload public asset error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Failed to upload public asset' } } as ApiResponse);
  } finally {
    releaseUploadSlot?.();
  }
});

router.post('/publications/create', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const authorIdentityId = req.identity?.identityId;
    if (!familyId || !authorIdentityId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (!assertPublicSiteAllowed(req, res)) return;
    if (!await ensurePublicSiteEnabled(familyId, res)) return;

    const payload = getSignedPayload<{
      title?: unknown;
      summary?: unknown;
      body?: unknown;
      bodyFormat?: unknown;
      sourceLinkId?: unknown;
      sourceChannelPostId?: unknown;
      assetIds?: unknown;
    }>(req);

    const title = normalizeText(payload.title, PUBLICATION_TITLE_MAX_LEN);
    const body = normalizeText(payload.body, PUBLICATION_BODY_MAX_LEN);
    if (!title || !body) {
      return res.status(400).json({ status: 'error', error: { code: 'INVALID_REQUEST' as ErrorCode, message: 'title and body are required' } } as ApiResponse);
    }
    const bodyFormat = payload.bodyFormat === 'plain_text' ? 'plain_text' : 'markdown';
    const sourceLinkId = typeof payload.sourceLinkId === 'string' && payload.sourceLinkId.trim() ? payload.sourceLinkId.trim() : null;
    const sourceChannelPostId = typeof payload.sourceChannelPostId === 'string' && payload.sourceChannelPostId.trim() ? payload.sourceChannelPostId.trim() : null;
    const assetIds = normalizeAssetIds(payload.assetIds);
    if (!sourceChannelPostId) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: 'A channel post source is required'
        }
      } as ApiResponse);
    }

    const [sourceLink, sourceChannelPost] = await Promise.all([
      sourceLinkId ? directGuestLinkRepository.findById(familyId, sourceLinkId) : Promise.resolve(null),
      announcementChannelRepository.findPostById(familyId, sourceChannelPostId),
    ]);
    const sourceChannel = sourceChannelPost
      ? await announcementChannelRepository.findById(familyId, sourceChannelPost.channel_id)
      : null;
    if (
      !sourceChannelPost
      || (sourceLinkId !== null && (
        !sourceLink
        || sourceLink.status !== 'active'
        || sourceChannel?.public_site_guest_link_id !== sourceLinkId
      ))
      || !sourceChannel
      || sourceChannel.owner_identity_id !== authorIdentityId
      || sourceChannelPost.author_identity_id !== authorIdentityId
      || !sourceChannel.public_site_visible
      || !sourceChannel.public_site_slug
    ) {
      return res.status(409).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'The source post must belong to a published announcement channel'
        }
      } as ApiResponse);
    }

    const publication = await circleSitePublicationService.publishChannelPost({
      familyId,
      channelId: sourceChannel.channel_id,
      sourceLinkId,
      sourceChannelPostId,
      authorIdentityId,
      title,
      summary: normalizeText(payload.summary, PUBLICATION_SUMMARY_MAX_LEN),
      body,
      bodyFormat,
      assetIds,
      existingPublishedBehavior: 'reject',
    });

    return res.json({ status: 'ok', result: publicationResult(publication) } as ApiResponse);
  } catch (error: any) {
    if (error instanceof PublicationAlreadyPublishedError) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'This channel post is already published' }
      } as ApiResponse);
    }
    if (error instanceof PublicationAssetsNotReadyError) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'One or more publication assets are not ready' }
      } as ApiResponse);
    }
    if (error instanceof PublicationStateChangedError) {
      return res.status(409).json({
        status: 'error',
        error: { code: 'INVALID_STATE' as ErrorCode, message: 'Publication state changed concurrently' }
      } as ApiResponse);
    }
    if (error?.code === '23505') {
      return res.status(409).json({
        status: 'error',
        error: {
          code: 'INVALID_STATE' as ErrorCode,
          message: 'A publication for this channel post or slug already exists'
        }
      } as ApiResponse);
    }
    routeLogger.error('Create circle site publication error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/publications/:publicationId/update', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const publicationId = String(req.params.publicationId || '').trim();
    if (!familyId || !publicationId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (!assertPublicSiteAllowed(req, res)) return;
    const existing = await circleSitePublicationRepository.findById(familyId, publicationId);
    if (!existing || (!canManageAllPublications(req) && existing.author_identity_id !== req.identity?.identityId)) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Publication not found' } } as ApiResponse);
    }

    const payload = getSignedPayload<{
      title?: unknown;
      summary?: unknown;
      body?: unknown;
      bodyFormat?: unknown;
    }>(req);

    const normalizedTitle = payload.title === undefined
      ? undefined
      : normalizeText(payload.title, PUBLICATION_TITLE_MAX_LEN);
    const normalizedBody = payload.body === undefined
      ? undefined
      : normalizeText(payload.body, PUBLICATION_BODY_MAX_LEN);
    if (normalizedTitle === null || normalizedBody === null) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_REQUEST' as ErrorCode,
          message: 'title and body cannot be empty'
        }
      } as ApiResponse);
    }

    const updated = await circleSitePublicationRepository.update(familyId, publicationId, {
      title: normalizedTitle,
      summary: payload.summary !== undefined ? normalizeText(payload.summary, PUBLICATION_SUMMARY_MAX_LEN) : undefined,
      body: normalizedBody,
      bodyFormat: payload.bodyFormat === 'plain_text' || payload.bodyFormat === 'markdown' ? payload.bodyFormat : undefined,
    });

    if (!updated) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Publication not found' } } as ApiResponse);
    }

    await publicSiteGeneratorService.regenerateSite(familyId);

    return res.json({ status: 'ok', result: publicationResult(updated) } as ApiResponse);
  } catch (error) {
    routeLogger.error('Update circle site publication error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

router.post('/publications/:publicationId/unpublish', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const publicationId = String(req.params.publicationId || '').trim();
    if (!familyId || !publicationId) {
      return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Family context is missing' } } as ApiResponse);
    }
    if (!assertPublicSiteAllowed(req, res)) return;
    const existing = await circleSitePublicationRepository.findById(familyId, publicationId);
    if (!existing || (!canManageAllPublications(req) && existing.author_identity_id !== req.identity?.identityId)) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Publication not found' } } as ApiResponse);
    }

    const updated = await circleSitePublicationRepository.setStatus(familyId, publicationId, 'unpublished');
    if (!updated) {
      return res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND' as ErrorCode, message: 'Publication not found' } } as ApiResponse);
    }

    await publicSiteGeneratorService.regenerateSite(familyId);

    return res.json({ status: 'ok', result: publicationResult(updated) } as ApiResponse);
  } catch (error) {
    routeLogger.error('Unpublish circle site publication error:', error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL_ERROR' as ErrorCode, message: 'Internal server error' } } as ApiResponse);
  }
});

export default router;
