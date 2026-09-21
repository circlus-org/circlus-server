import { reliableOperation } from '../services/reliableOperation';
import { routeLogger } from '../utils/routeLogger';
import { Router } from 'express';
import { nanoid } from 'nanoid';
import {
  attachmentRepository,
  announcementChannelRepository,
  identityRepository,
  messageRepository,
  groupChatRepository,
  temporaryDeviceRepository
} from '../db/repositories';
import { configService } from '../services/configService';
import { verifySignature, requireActiveIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import { attachmentStorageService } from '../services/attachmentStorageService';
import { createAttachmentUploadToken, hashAttachmentUploadToken, verifyAttachmentUploadToken } from '../utils/attachmentTokens';
import {
  ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES,
  getAttachmentsHttpBodyLimitBytes,
  getAttachmentsHttpBodyLimitRaw,
  getMaxAttachmentPlaintextBytes
} from '../utils/attachmentHttpBodyLimit';
import { tryAcquireUploadSlot, UploadStreamError } from '../services/uploadStreamService';
import { resolveDirectCommunicationAccess } from '../services/directGuestAccessService';
import type { ApiResponse, ErrorCode, IdentityId, WSAttachmentMetadataUpdatedData } from '../../../shared/types';
import { getStorageRuntimeConfig } from '../config/serverRuntimeConfig';
import type { DBAttachmentBlob } from '../db/types';
import { sendDirectChatWsEvent, sendGroupChatWsEvent, sendToIdentityWs } from '../ws/wsGateway';

const router = Router();

function ok<T>(result: T): ApiResponse<T> {
  return { status: 'ok', result };
}

function err(code: ErrorCode | string, message: string): ApiResponse {
  return { status: 'error', error: { code: code as ErrorCode, message } };
}

function toAttachmentMetadata(blob: DBAttachmentBlob): Omit<WSAttachmentMetadataUpdatedData, 'chatId'> {
  return {
    blobId: blob.blob_id,
    status: blob.status,
    expiresAt: blob.expires_at.toISOString(),
    deletedAt: blob.deleted_at?.toISOString() || null,
    deletedByIdentityId: blob.deleted_by_identity_id || null,
    deleteReason: blob.delete_reason || null,
  };
}

async function notifyAttachmentMetadataUpdated(familyId: string, blob: DBAttachmentBlob): Promise<void> {
  const chatId = String(blob.chat_id || '').trim();
  if (!chatId) return;
  const payload: WSAttachmentMetadataUpdatedData = { chatId, ...toAttachmentMetadata(blob) };
  if (blob.chat_type === 'direct') {
    for (const identityId of new Set(chatId.split('::').map((value) => value.trim()).filter(Boolean))) {
      sendDirectChatWsEvent(familyId, identityId as IdentityId, chatId, {
        type: 'attachment:metadata-updated',
        data: payload,
        timestamp: Date.now(),
      });
    }
    return;
  }
  if (blob.chat_type === 'group') {
    const participants = await groupChatRepository.listActiveParticipants(familyId, chatId);
    sendGroupChatWsEvent({
      familyId,
      participantIdentityIds: participants.map((participant) => participant.identity_id),
      eventType: 'attachment:metadata-updated',
      payload,
    });
    return;
  }
  if (blob.chat_type === 'channel') {
    const post = blob.linked_message_id
      ? await announcementChannelRepository.findPostById(familyId, blob.linked_message_id)
      : null;
    if (!post || post.channel_id !== chatId) return;
    const recipients = await announcementChannelRepository.listActiveRecipients(
      familyId,
      chatId,
      post.author_identity_id
    );
    const recipientIdentityIds = new Set<string>([
      post.author_identity_id,
      ...recipients.map((recipient) => recipient.guest_identity_id),
    ]);
    for (const identityId of recipientIdentityIds) {
      sendToIdentityWs(familyId, identityId as IdentityId, {
        type: 'attachment:metadata-updated',
        data: payload,
        timestamp: Date.now(),
      });
    }
  }
}

async function getAttachmentPolicy(familyId: string) {
  const config = await configService.getFamilyConfig(familyId);
  if (!config) return null;
  const maxStorage = Number(config.attachment_storage_quota_bytes || 0);
  const used = Number(config.used_attachment_storage_bytes || 0);
  const reserved = Number(config.reserved_attachment_storage_bytes || 0);
  return {
    enabled: config.attachments_enabled,
    maxFileSizeBytes: config.max_attachment_file_size_bytes === null ? null : Number(config.max_attachment_file_size_bytes),
    maxStorageBytes: config.attachment_storage_quota_bytes === null ? null : maxStorage,
    retentionPeriodSeconds: config.attachment_retention_seconds === null ? null : Number(config.attachment_retention_seconds),
    membersCanUseGuestServerAttachments: config.members_can_use_guest_server_attachments !== false,
    remainingStorageBytes: config.attachment_storage_quota_bytes === null ? null : Math.max(0, maxStorage - used - reserved),
    usedStorageBytes: used,
    reservedStorageBytes: reserved
  };
}

async function checkHostStorageFloor(sizeBytes: number): Promise<boolean> {
  const minFreeBytes = getStorageRuntimeConfig().attachments.minFreeDiskBytes;
  const freeBytes = await attachmentStorageService.getFreeBytes();
  return freeBytes - sizeBytes >= minFreeBytes;
}

function buildDirectChatId(left: string, right: string): string {
  const a = (left || '').trim();
  const b = (right || '').trim();
  if (!a || !b) return `${a}::${b}`;
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

async function hasTemporaryChatAccess(
  req: AuthRequest,
  chatType: 'direct' | 'group' | 'channel' | null,
  chatId: string | null
): Promise<boolean> {
  if (req.device?.accessLevel !== 'temporary') return true;
  const familyId = req.familyId;
  const normalizedChatId = String(chatId || '').trim();
  if (!familyId || !chatType || !normalizedChatId) return false;
  if (chatType === 'channel') return false;
  return temporaryDeviceRepository.hasChatAccess(familyId, req.device.deviceId, normalizedChatId, chatType);
}

async function validateAttachmentCommitTarget(params: {
  familyId: string;
  senderIdentityId: string;
  chatType: 'direct' | 'group' | 'channel';
  chatId: string;
  linkedMessageId: string;
}): Promise<boolean> {
  if (params.chatType === 'channel') {
    const post = await announcementChannelRepository.findPostById(
      params.familyId,
      params.linkedMessageId
    );
    return Boolean(
      post
      && post.channel_id === params.chatId
      && post.author_identity_id === params.senderIdentityId
      && !post.deleted_at
    );
  }

  if (params.chatType === 'direct') {
    const message = await messageRepository.findMessageById(params.familyId, params.linkedMessageId);
    if (!message) return false;
    if (message.sender_identity_id !== params.senderIdentityId) return false;
    return buildDirectChatId(message.sender_identity_id, message.recipient_identity_id) === params.chatId;
  }

  const message = await groupChatRepository.findMessageById(params.familyId, params.chatId, params.linkedMessageId);
  if (!message) return false;
  return message.sender_identity_id === params.senderIdentityId;
}

async function validateServerAttachmentPermission(params: {
  familyId: string;
  senderIdentityId: string;
  chatType: 'direct' | 'group' | 'channel';
  linkedMessageId: string;
}): Promise<boolean> {
  if (params.chatType === 'channel') return true;
  if (params.chatType !== 'direct') return true;
  const message = await messageRepository.findMessageById(params.familyId, params.linkedMessageId);
  if (!message || message.sender_identity_id !== params.senderIdentityId) return false;
  const recipientIdentityId = message.recipient_identity_id;
  const access = await resolveDirectCommunicationAccess(
    params.familyId,
    params.senderIdentityId,
    recipientIdentityId,
    'server_attachments'
  );
  if (access.allowed && access.relation === 'direct_guest' && access.hostIdentityId) {
    const hostIdentity = await identityRepository.findByIdentityId(params.familyId, access.hostIdentityId as IdentityId);
    if (hostIdentity?.role === 'member') {
      const config = await configService.getFamilyConfig(params.familyId);
      if (config?.members_can_use_guest_server_attachments === false) {
        return false;
      }
    }
  }
  return access.allowed;
}

async function resolveAttachmentAccess(params: {
  familyId: string;
  identityId: string;
  blob: {
    chat_type: 'direct' | 'group' | 'channel' | null;
    chat_id: string | null;
    linked_message_id: string | null;
  };
}): Promise<{ canRead: boolean; canDelete: boolean }> {
  const chatType = params.blob.chat_type;
  const chatId = String(params.blob.chat_id || '').trim();
  const linkedMessageId = String(params.blob.linked_message_id || '').trim();
  if (!chatType || !chatId || !linkedMessageId) {
    return { canRead: false, canDelete: false };
  }

  if (chatType === 'channel') {
    const post = await announcementChannelRepository.findPostById(
      params.familyId,
      linkedMessageId
    );
    if (!post || post.channel_id !== chatId || post.deleted_at) {
      return { canRead: false, canDelete: false };
    }
    if (post.author_identity_id === params.identityId) {
      return { canRead: true, canDelete: true };
    }
    const subscription = await announcementChannelRepository.findSubscriptionForIdentity(
      params.familyId,
      chatId,
      params.identityId
    );
    return { canRead: subscription?.status === 'active', canDelete: false };
  }

  if (chatType === 'direct') {
    const message = await messageRepository.findMessageById(params.familyId, linkedMessageId);
    if (!message) return { canRead: false, canDelete: false };
    const isParticipant = params.identityId === message.sender_identity_id || params.identityId === message.recipient_identity_id;
    return { canRead: isParticipant, canDelete: isParticipant };
  }

  const message = await groupChatRepository.findMessageById(params.familyId, chatId, linkedMessageId);
  if (!message) return { canRead: false, canDelete: false };
  const isSender = params.identityId === message.sender_identity_id;
  if (isSender) return { canRead: true, canDelete: true };

  const participant = await groupChatRepository.findParticipant(params.familyId, chatId, params.identityId as any);
  const isActiveParticipant = Boolean(participant?.is_active);
  return { canRead: isActiveParticipant, canDelete: false };
}

router.post('/policy', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR', 'Family context is missing'));
    const policy = await getAttachmentPolicy(familyId);
    if (!policy) return res.status(404).json(err('NOT_FOUND', 'Family configuration not found'));
    return res.json(ok(policy));
  } catch (error) {
    routeLogger.error('Get attachment policy error:', error);
    return res.status(500).json(err('INTERNAL_ERROR', 'Failed to get attachment policy'));
  }
});

router.post('/reservations', verifySignature, requireActiveIdentity, reliableOperation(async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) return res.status(500).json(err('INTERNAL_ERROR', 'Family context is missing'));

    const payload = getSignedPayload<{
      plaintextSizeBytes?: number;
    }>(req);

    const plaintextSizeBytes = Number(payload.plaintextSizeBytes || 0);

    if (!Number.isFinite(plaintextSizeBytes) || plaintextSizeBytes <= 0) {
      return res.status(400).json(err('INVALID_REQUEST', 'plaintextSizeBytes is required'));
    }

    const policy = await getAttachmentPolicy(familyId);
    if (!policy) return res.status(404).json(err('NOT_FOUND', 'Family configuration not found'));
    routeLogger.info('Attachment reservation policy evaluated', {
      plaintextSizeBytes,
      policyMaxFileSizeBytes: policy.maxFileSizeBytes,
      remainingStorageBytes: policy.remainingStorageBytes,
      httpBodyLimit: getAttachmentsHttpBodyLimitRaw()
    });
    if (!policy.enabled) return res.status(403).json(err('FORBIDDEN', 'Attachments are disabled'));
    if (policy.retentionPeriodSeconds === null) {
      return res.status(409).json(err('INVALID_STATE', 'Attachment retention period is not configured'));
    }
    if (policy.maxFileSizeBytes !== null && plaintextSizeBytes > policy.maxFileSizeBytes) {
      return res.status(400).json(err('INVALID_REQUEST', 'File exceeds max size'));
    }
    if (plaintextSizeBytes > getMaxAttachmentPlaintextBytes()) {
      return res.status(400).json(err('INVALID_REQUEST', 'Encrypted file exceeds HTTP upload limit'));
    }
    if (policy.remainingStorageBytes !== null && policy.remainingStorageBytes < plaintextSizeBytes) {
      return res.status(409).json(err('QUOTA_EXCEEDED', 'Attachment storage quota exceeded'));
    }
    if (!(await checkHostStorageFloor(plaintextSizeBytes))) {
      return res.status(507).json(err('INSUFFICIENT_STORAGE', 'Host free-space safety floor reached'));
    }

    const retentionSeconds = policy.retentionPeriodSeconds;
    const reservationId = `attres_${nanoid(20)}`;
    const blobId = `blob_${nanoid(24)}`;
    const uploadToken = createAttachmentUploadToken();
    const storageKey = attachmentStorageService.buildStorageKey(familyId, blobId);
    const now = Date.now();
    const reservedUntil = new Date(
      now + getStorageRuntimeConfig().attachments.reservationTtlMs
    );
    const expiresAt = new Date(now + retentionSeconds * 1000);

    await attachmentRepository.createReservation({
      reservationId,
      blobId,
      familyId,
      uploaderIdentityId: identityId,
      plaintextSizeBytes,
      storageKey,
      expiresAt,
      reservedUntil,
      uploadTokenHash: hashAttachmentUploadToken(uploadToken)
    });

    return res.json(ok({
      reservationId,
      blobId,
      uploadToken,
      uploadUrl: `/api/attachments/uploads/${encodeURIComponent(blobId)}`,
      reservedUntil: reservedUntil.toISOString(),
      expiresAt: expiresAt.toISOString(),
      remainingStorageBytesAfterReservation: Math.max(0, (policy.remainingStorageBytes || 0) - plaintextSizeBytes)
    }));
  } catch (error) {
    routeLogger.error('Create attachment reservation error:', error);
    return res.status(500).json(err('INTERNAL_ERROR', 'Failed to create attachment reservation'));
  }
}));

router.put('/uploads/:blobId', async (req, res) => {
  let releaseUploadSlot: (() => void) | null = null;
  try {
    const familyId = (req as AuthRequest).familyId;
    const blobId = String(req.params.blobId || '').trim();
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();

    if (!familyId) return res.status(500).json(err('INTERNAL_ERROR', 'Family context is missing'));
    if (!blobId || !token) return res.status(401).json(err('UNAUTHORIZED', 'Upload token is required'));
    if (contentType !== 'application/octet-stream') {
      return res.status(415).json(err('INVALID_REQUEST', 'Content-Type must be application/octet-stream'));
    }

    const reservation = await attachmentRepository.findReservationByBlobId(familyId, blobId);
    const blob = await attachmentRepository.findBlobById(familyId, blobId);
    if (!reservation || !blob) return res.status(404).json(err('NOT_FOUND', 'Attachment reservation not found'));
    if (!verifyAttachmentUploadToken(token, reservation.upload_token_hash)) {
      return res.status(401).json(err('UNAUTHORIZED', 'Invalid upload token'));
    }
    if (!['reserved', 'uploading'].includes(reservation.status)) {
      return res.status(409).json(err('INVALID_STATE', `Reservation is ${reservation.status}`));
    }
    if (new Date(reservation.reserved_until).getTime() < Date.now()) {
      return res.status(410).json(err('EXPIRED', 'Upload reservation expired'));
    }

    const maxBytes = getAttachmentsHttpBodyLimitBytes();
    const expectedBytes = Number(reservation.plaintext_size_bytes) + ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES;
    const contentLengthHeader = req.headers['content-length'];
    const contentLength = contentLengthHeader === undefined ? null : Number(contentLengthHeader);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      return res.status(400).json(err('INVALID_REQUEST', 'Content-Length must be a non-negative integer'));
    }
    if (expectedBytes > maxBytes || (contentLength !== null && contentLength > maxBytes)) {
      return res.status(413).json(err('PAYLOAD_TOO_LARGE', 'Attachment upload body exceeds HTTP body limit'));
    }
    if (contentLength !== null && contentLength !== expectedBytes) {
      return res.status(400).json(err('INVALID_REQUEST', `Upload size must be exactly ${expectedBytes} bytes`));
    }

    const slot = tryAcquireUploadSlot(`attachment:${familyId}:${reservation.reservation_id}`);
    if (!slot.acquired) {
      const status = slot.reason === 'duplicate' ? 409 : 503;
      const message = slot.reason === 'duplicate'
        ? 'This attachment is already being uploaded'
        : 'Upload capacity is temporarily exhausted';
      return res.status(status).json(err('INVALID_STATE', message));
    }
    releaseUploadSlot = slot.release;

    await attachmentRepository.markReservationUploading(familyId, reservation.reservation_id);
    const upload = await attachmentStorageService.writeUploadStream({
      reservationId: reservation.reservation_id,
      storageKey: blob.storage_key,
      source: req,
      maxBytes,
      expectedBytes
    });
    await attachmentRepository.markUploaded({
      familyId,
      reservationId: reservation.reservation_id,
      blobId,
      ciphertextSizeBytes: upload.bytesWritten,
      ciphertextSha256: upload.sha256
    });

    return res.json(ok({
      blobId,
      uploaded: true,
      ciphertextSizeBytes: upload.bytesWritten,
      ciphertextSha256: upload.sha256
    }));
  } catch (error) {
    if (error instanceof UploadStreamError) {
      const status = error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
      return res.status(status).json(err(error.code, error.message));
    }
    routeLogger.error('Upload attachment blob error:', error);
    return res.status(500).json(err('INTERNAL_ERROR', 'Failed to upload attachment'));
  } finally {
    releaseUploadSlot?.();
  }
});

router.post('/commit', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const senderIdentityId = req.device?.identityId;
    if (!familyId || !senderIdentityId) return res.status(500).json(err('INTERNAL_ERROR', 'Family context is missing'));

    const payload = getSignedPayload<{
      reservationId?: string;
      blobId?: string;
      chatType?: 'direct' | 'group' | 'channel';
      chatId?: string;
      linkedMessageId?: string;
    }>(req);

    const reservationId = String(payload.reservationId || '').trim();
    const blobId = String(payload.blobId || '').trim();
    const chatType = payload.chatType;
    const chatId = String(payload.chatId || '').trim();
    const linkedMessageId = String(payload.linkedMessageId || '').trim();

    if (!reservationId || !blobId || !chatType || !chatId || !linkedMessageId) {
      return res.status(400).json(err('INVALID_REQUEST', 'reservationId, blobId, chatType, chatId and linkedMessageId are required'));
    }
    if (!(await hasTemporaryChatAccess(req, chatType, chatId))) {
      return res.status(403).json(err('FORBIDDEN', 'Temporary device has no access to this chat'));
    }
    const validTarget = await validateAttachmentCommitTarget({
      familyId,
      senderIdentityId,
      chatType,
      chatId,
      linkedMessageId
    });
    if (!validTarget) {
      return res.status(403).json(err('FORBIDDEN', 'Attachment can only be linked to a sender-owned message in the target chat'));
    }
    const allowedAttachment = await validateServerAttachmentPermission({
      familyId,
      senderIdentityId,
      chatType,
      linkedMessageId
    });
    if (!allowedAttachment) {
      return res.status(403).json(err('FORBIDDEN', 'Server attachments are not allowed for this direct guest chat'));
    }

    const committed = await attachmentRepository.commitBlob({
      familyId,
      reservationId,
      blobId,
      senderIdentityId,
      chatType,
      chatId,
      linkedMessageId
    });

    if (!committed) return res.status(404).json(err('NOT_FOUND', 'Attachment reservation not found'));
    return res.json(ok({
      blobId: committed.blob_id,
      status: committed.status,
      expiresAt: committed.expires_at.toISOString()
    }));
  } catch (error) {
    routeLogger.error('Commit attachment error:', error);
    return res.status(500).json(err('INTERNAL_ERROR', 'Failed to commit attachment'));
  }
});

router.post('/blobs/:blobId/read', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const blobId = String(req.params.blobId || '').trim();
    if (!familyId || !identityId) return res.status(500).json(err('INTERNAL_ERROR', 'Family context is missing'));

    const blob = await attachmentRepository.findBlobById(familyId, blobId);
    if (!blob) return res.status(404).json(err('NOT_FOUND', 'Attachment not found'));
    if (blob.status !== 'committed') return res.status(409).json(err('INVALID_STATE', 'Attachment is not available'));
    if (!(await hasTemporaryChatAccess(req, blob.chat_type, blob.chat_id))) {
      return res.status(403).json(err('FORBIDDEN', 'Temporary device has no access to this chat'));
    }
    const access = await resolveAttachmentAccess({
      familyId,
      identityId,
      blob
    });
    if (!access.canRead) {
      return res.status(403).json(err('FORBIDDEN', 'Attachment is not accessible for this identity'));
    }

    const stream = await attachmentStorageService.readBlob(blob.storage_key);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(blob.ciphertext_size_bytes));
    stream.pipe(res);
  } catch (error) {
    routeLogger.error('Download attachment error:', error);
    return res.status(500).json(err('INTERNAL_ERROR', 'Failed to download attachment'));
  }
});

router.post('/blobs/:blobId/metadata', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const blobId = String(req.params.blobId || '').trim();
    if (!familyId || !identityId) return res.status(500).json(err('INTERNAL_ERROR', 'Family context is missing'));

    const blob = await attachmentRepository.findBlobById(familyId, blobId);
    if (!blob) return res.status(404).json(err('NOT_FOUND', 'Attachment not found'));
    if (!(await hasTemporaryChatAccess(req, blob.chat_type, blob.chat_id))) {
      return res.status(403).json(err('FORBIDDEN', 'Temporary device has no access to this chat'));
    }
    const access = await resolveAttachmentAccess({
      familyId,
      identityId,
      blob
    });
    if (!access.canRead) {
      return res.status(403).json(err('FORBIDDEN', 'Attachment is not accessible for this identity'));
    }

    return res.json(ok(toAttachmentMetadata(blob)));
  } catch (error) {
    routeLogger.error('Get attachment metadata error:', error);
    return res.status(500).json(err('INTERNAL_ERROR', 'Failed to load attachment metadata'));
  }
});

router.post('/blobs/metadata/list', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    if (!familyId || !identityId) return res.status(500).json(err('INTERNAL_ERROR', 'Family context is missing'));
    const payload = getSignedPayload<{ blobIds?: string[] }>(req);
    const blobIds = Array.from(new Set(
      (Array.isArray(payload.blobIds) ? payload.blobIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ));
    if (blobIds.length === 0 || blobIds.length > 100) {
      return res.status(400).json(err('INVALID_REQUEST', 'blobIds must contain between 1 and 100 values'));
    }

    const metadata: Array<Omit<WSAttachmentMetadataUpdatedData, 'chatId'>> = [];
    for (const blobId of blobIds) {
      const blob = await attachmentRepository.findBlobById(familyId, blobId);
      if (!blob || !(await hasTemporaryChatAccess(req, blob.chat_type, blob.chat_id))) continue;
      const access = await resolveAttachmentAccess({ familyId, identityId, blob });
      if (access.canRead) metadata.push(toAttachmentMetadata(blob));
    }
    return res.json(ok({ metadata }));
  } catch (error) {
    routeLogger.error('List attachment metadata error:', error);
    return res.status(500).json(err('INTERNAL_ERROR', 'Failed to load attachment metadata'));
  }
});

router.post('/blobs/:blobId/delete', verifySignature, requireActiveIdentity, async (req: AuthRequest, res) => {
  try {
    const familyId = req.familyId;
    const identityId = req.device?.identityId;
    const blobId = String(req.params.blobId || '').trim();
    if (!familyId || !identityId) return res.status(500).json(err('INTERNAL_ERROR', 'Family context is missing'));

    const blob = await attachmentRepository.findBlobById(familyId, blobId);
    if (!blob) return res.status(404).json(err('NOT_FOUND', 'Attachment not found'));
    if (!(await hasTemporaryChatAccess(req, blob.chat_type, blob.chat_id))) {
      return res.status(403).json(err('FORBIDDEN', 'Temporary device has no access to this chat'));
    }
    const access = await resolveAttachmentAccess({
      familyId,
      identityId,
      blob
    });
    if (!access.canDelete) {
      return res.status(403).json(err('FORBIDDEN', 'This identity cannot delete the attachment from the server'));
    }

    const marked = await attachmentRepository.requestDeletion({
      familyId,
      blobId,
      deletedByIdentityId: identityId,
      deleteReason: 'user_request'
    });
    if (!marked) return res.status(404).json(err('NOT_FOUND', 'Attachment not found'));

    await attachmentStorageService.deleteBlob(marked.storage_key);
    const finalBlob = await attachmentRepository.finalizeDeletion({
      familyId,
      blobId,
      finalStatus: 'deleted'
    });
    if (finalBlob) await notifyAttachmentMetadataUpdated(familyId, finalBlob);

    return res.json(ok({
      result: finalBlob?.status === 'deleted' ? 'deleted' : 'already_deleted',
      deletedAt: finalBlob?.deleted_at?.toISOString() || null,
      deleteReason: finalBlob?.delete_reason || null,
      deletedByIdentityId: finalBlob?.deleted_by_identity_id || null
    }));
  } catch (error) {
    routeLogger.error('Delete attachment error:', error);
    return res.status(500).json(err('INTERNAL_ERROR', 'Failed to delete attachment'));
  }
});

export default router;
