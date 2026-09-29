import { MessageAlreadyAccepted } from './messageSendReceipt';
import { MessageRevisionConflict, sameMessageClaim } from './messageRevision';
import { nanoid } from 'nanoid';
import type {
  ErrorCode,
  DirectMessageAuthorClaim,
  DirectMessageDeliveryProof,
  DirectMessageReadProof,
  IdentityId,
  MessageStatus,
  PublicKey,
  TemporaryIdentityDelegationCredential,
  WSMessageAckData,
  WSMessageDeliverData,
  WSMessageMutationUpdateData,
  WSMessageStatusUpdateData,
  WSReadCursorPushData,
} from '@shared/types';
import {
  directGuestRegistrationRepository,
  identityRepository,
  messageRepository,
} from '../db/repositories';
import { resolveDirectCommunicationAccess } from './directGuestAccessService';
import { sendIncomingMessagePush, sendMessagesReadPush } from '../utils/push';
import { configService } from './configService';
import { sendDirectChatWsEvent } from '../ws/wsGateway';
import { query } from '../db';
import { getFeaturePolicyRuntimeConfig } from '../config/serverRuntimeConfig';
import { getSelfChatSenderDeviceId } from './directMessageDeviceMetadata';
import { getRequestLogger } from '../middleware/requestContext';
import { validateDirectMessageAuthorClaim } from './directMessageTrustProtocol';
import { recordForegroundMessageActivity } from './foregroundPresenceActivity';
import { verifyDirectMessageDeliveryProof } from './directMessageDeliveryProof';
import { verifyDirectMessageReadProof } from './directMessageReadProof';

const MAX_MESSAGE_BYTES = getFeaturePolicyRuntimeConfig().messages.maxCiphertextBytes;

export class DirectMessageServiceError extends Error {
  status: number;
  code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'DirectMessageServiceError';
    this.status = status;
    this.code = code;
  }
}

function assertMessageSizeAllowed(ciphertext: string, senderCiphertext?: string | null, notificationPreviewCiphertext?: string | null) {
  if (Buffer.byteLength(ciphertext, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new DirectMessageServiceError(413, 'MESSAGE_TOO_LARGE' as ErrorCode, 'Ciphertext exceeds size limit');
  }
  if (senderCiphertext && Buffer.byteLength(senderCiphertext, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new DirectMessageServiceError(413, 'MESSAGE_TOO_LARGE' as ErrorCode, 'Sender ciphertext exceeds size limit');
  }
  if (notificationPreviewCiphertext && Buffer.byteLength(notificationPreviewCiphertext, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new DirectMessageServiceError(413, 'MESSAGE_TOO_LARGE' as ErrorCode, 'Notification preview ciphertext exceeds size limit');
  }
}

function assertDirectEpochCiphertext(ciphertext: string, field: string): void {
  if (!ciphertext.startsWith('dcm1:')) {
    throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, `${field} must use dcm1 format`);
  }
  const payload = ciphertext.slice('dcm1:'.length);
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, `${field} must use dcm1 format`);
  }
  const decoded = Buffer.from(payload, 'base64');
  const canonicalPayload = decoded.toString('base64').replace(/=+$/, '');
  if (decoded.length <= 12 || canonicalPayload !== payload.replace(/=+$/, '')) {
    throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, `${field} must use dcm1 format`);
  }
}

function assertDirectEpoch(epoch: number | null | undefined): asserts epoch is number {
  if (!Number.isInteger(epoch) || Number(epoch) < 1) {
    throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, 'epoch is required');
  }
}

async function resolvePublishedIdentityName(familyId: string, identity: any | null): Promise<string | undefined> {
  void familyId;
  void identity;
  return undefined;
}

function buildSenderPublicKey(identity: any | null): PublicKey | undefined {
  if (!identity) return undefined;
  return {
    algorithm: identity.public_key_algorithm as 'ed25519' | 'x25519',
    value: identity.public_key_value,
  };
}

function getDirectChatId(a: string, b: string): string {
  const left = (a || '').trim();
  const right = (b || '').trim();
  if (!left || !right) return `${left}::${right}`;
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}

function sendStatusUpdate(familyId: string, senderIdentityId: IdentityId, directChatId: string, update: WSMessageStatusUpdateData) {
  sendDirectChatWsEvent(familyId, senderIdentityId, directChatId, {
    type: 'message:status-update',
    data: update,
    timestamp: Date.now(),
  });
}

function sendMutationUpdate(familyId: string, identityIds: IdentityId[], payload: WSMessageMutationUpdateData) {
  const uniqueIds = Array.from(new Set(identityIds.map((value) => String(value || '').trim()).filter(Boolean))) as IdentityId[];
  const directChatId = getDirectChatId(payload.senderIdentityId, payload.recipientIdentityId);
  for (const identityId of uniqueIds) {
    sendDirectChatWsEvent(familyId, identityId, directChatId, {
      type: 'message:mutation-update',
      data: payload,
      timestamp: Date.now(),
    });
  }
}

function sendReadCursorUpdate(familyId: string, identityId: IdentityId, directChatId: string, payload: WSReadCursorPushData) {
  sendDirectChatWsEvent(familyId, identityId, directChatId, {
    type: 'message:read-cursor',
    data: payload,
    timestamp: Date.now(),
  });
}

export async function sendDirectMessage(params: {
  familyId: string;
  senderIdentityId: IdentityId;
  senderDeviceId: string;
  recipientIdentityId: IdentityId;
  ciphertext: string;
  senderCiphertext?: string | null;
  notificationPreviewCiphertext?: string | null;
  senderSignature: string;
  authorClaim?: DirectMessageAuthorClaim;
  temporaryDevice?: boolean;
  temporaryIdentityDelegation?: TemporaryIdentityDelegationCredential;
  clientMessageId: string;
  clientCreatedAt?: number | null;
  epoch?: number | null;
}): Promise<{ ack: WSMessageAckData; statusUpdate?: WSMessageStatusUpdateData | null }> {
  const recipientIdentityId = String(params.recipientIdentityId || '').trim() as IdentityId;
  const clientMessageId = String(params.clientMessageId || '').trim();
  const ciphertext = String(params.ciphertext || '');
  if (!recipientIdentityId || !clientMessageId || !ciphertext) {
    throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, 'recipientIdentityId, ciphertext and clientMessageId are required');
  }

  assertDirectEpoch(params.epoch);
  assertDirectEpochCiphertext(ciphertext, 'ciphertext');
  if (params.senderCiphertext) assertDirectEpochCiphertext(params.senderCiphertext, 'senderCiphertext');

  const directChatId = getDirectChatId(params.senderIdentityId, recipientIdentityId);
  assertMessageSizeAllowed(ciphertext, params.senderCiphertext, params.notificationPreviewCiphertext);

  const config = await configService.getResolvedFamilyConfig(params.familyId);
  await messageRepository.bumpDirectEpochIfStale(
    params.familyId,
    directChatId,
    config.chatEpochRotationIntervalHours * 60 * 60 * 1000
  );
  const currentEpoch = await messageRepository.getDirectCurrentEpoch(params.familyId, directChatId);
  if (params.epoch !== currentEpoch) {
    throw new DirectMessageServiceError(409, 'INVALID_STATE' as ErrorCode, 'Direct key epoch mismatch');
  }
  const epochKey = await messageRepository.findDirectEpochKey(params.familyId, directChatId, params.epoch);
  if (!epochKey) {
    throw new DirectMessageServiceError(409, 'INVALID_STATE' as ErrorCode, 'Direct key epoch is not initialized');
  }

  const access = await resolveDirectCommunicationAccess(
    params.familyId,
    params.senderIdentityId,
    recipientIdentityId,
    'messages'
  );
  if (!access.allowed) {
    throw new DirectMessageServiceError(403, 'FORBIDDEN' as ErrorCode, 'Direct messaging is not allowed');
  }
  if (access.relation === 'direct_guest') {
    await directGuestRegistrationRepository.touchLastSeen(params.familyId, access.guestIdentityId);
  }

  const existing = await messageRepository.findByClientMessageId(
    params.familyId,
    params.senderDeviceId,
    clientMessageId
  );
  if (existing) {
    return {
      ack: {
        clientMessageId,
        serverMessageId: existing.server_message_id,
        serverTimestamp: Number(existing.created_at),
        status: 'new',
      },
      statusUpdate: null,
    };
  }

  const serverMessageId = nanoid();
  const createdAt = Date.now();
  getRequestLogger({ subsystem: 'direct_messages' }).debug('direct_message_send_started', {
    senderIdentityId: params.senderIdentityId,
    senderDeviceId: getSelfChatSenderDeviceId(
      params.senderIdentityId,
      recipientIdentityId,
      params.senderDeviceId
    ),
    recipientIdentityId,
    clientMessageId,
    serverMessageId,
    createdAt,
    epoch: params.epoch ?? null
  });
  const senderIdentity = await identityRepository.findByIdentityId(params.familyId, params.senderIdentityId);
  if (!senderIdentity || !validateDirectMessageAuthorClaim({
    claim: params.authorClaim,
    action: 'create',
    senderIdentityId: params.senderIdentityId,
    recipientIdentityId,
    clientMessageId,
    clientCreatedAt: params.clientCreatedAt ?? null,
    epoch: params.epoch,
    revision: 1,
    ciphertext,
    senderCiphertext: params.senderCiphertext,
    senderSignature: params.senderSignature,
    senderPublicKey: buildSenderPublicKey(senderIdentity)!,
    temporaryDevice: Boolean(params.temporaryIdentityDelegation)
  })) {
    throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, 'Invalid direct-message author claim');
  }
  await recordForegroundMessageActivity({
    familyId: params.familyId,
    identityId: params.senderIdentityId,
    activityAt: params.authorClaim?.payload?.foregroundActivityAt
  });
  const senderIdentityPublicKey = buildSenderPublicKey(senderIdentity);
  const senderIdentityName = await resolvePublishedIdentityName(params.familyId, senderIdentity);
  const senderIdentityRole = senderIdentity?.role === 'owner' || senderIdentity?.role === 'member' || senderIdentity?.role === 'guest'
    ? senderIdentity.role
    : undefined;

  let insertResult: { chat_seq: number };
  try {
  insertResult = await messageRepository.insertMessage({
    server_message_id: serverMessageId,
    family_id: params.familyId,
    direct_chat_id: directChatId,
    chat_seq: 0,
    sender_identity_id: params.senderIdentityId,
    recipient_identity_id: recipientIdentityId,
    sender_device_id: params.senderDeviceId,
    ciphertext,
    sender_ciphertext: params.senderCiphertext ?? null,
    notification_preview_ciphertext: params.notificationPreviewCiphertext ?? null,
    sender_signature: params.senderSignature,
    author_claim: params.authorClaim ?? null,
    temporary_identity_delegation: params.temporaryIdentityDelegation ?? null,
    client_message_id: clientMessageId,
    client_created_at: params.clientCreatedAt ?? null,
    created_at: createdAt,
    content_updated_at: createdAt,
    edited_at: null,
    deleted_at: null,
    revision: 1,
    status: 'new',
    status_updated_at: createdAt,
    epoch: params.epoch ?? null,
  });
  } catch (error) {
    if (!(error instanceof MessageAlreadyAccepted)) throw error;
    return { ack: { clientMessageId, serverMessageId: error.messageId, serverTimestamp: error.createdAt, status: 'new' }, statusUpdate: null };
  }
  const chatSeq = insertResult.chat_seq;
  getRequestLogger({ subsystem: 'direct_messages' }).debug('direct_message_stored', {
    serverMessageId,
    senderIdentityId: params.senderIdentityId,
    recipientIdentityId,
    createdAt
  });

  const ack: WSMessageAckData = {
    clientMessageId,
    serverMessageId,
    serverTimestamp: createdAt,
    status: 'new',
  };

  const deliverPayload: WSMessageDeliverData = {
    serverMessageId,
    senderIdentityId: params.senderIdentityId,
    recipientIdentityId,
    senderDeviceId: params.senderDeviceId,
    senderIdentityPublicKey,
    senderIdentityName,
    senderIdentityRole,
    ciphertext,
    senderCiphertext: params.senderCiphertext ?? undefined,
    senderSignature: params.senderSignature,
    authorClaim: params.authorClaim,
    temporaryIdentityDelegation: params.temporaryIdentityDelegation,
    clientMessageId,
    clientCreatedAt: params.clientCreatedAt ?? null,
    serverTimestamp: createdAt,
    editedAt: null,
    deletedAt: null,
    contentUpdatedAt: createdAt,
    revision: 1,
    epoch: params.epoch ?? undefined,
    chatSeq,
  };
  sendDirectChatWsEvent(params.familyId, recipientIdentityId, directChatId, {
    type: 'message:deliver',
    data: deliverPayload,
    timestamp: Date.now(),
  });

  await sendIncomingMessagePush(
    params.familyId,
    recipientIdentityId,
    serverMessageId,
    params.senderIdentityId,
    senderIdentityName,
    {
      peerIdentityId: params.senderIdentityId,
      dialogId: params.senderIdentityId,
      messageCreatedAt: createdAt,
      notificationPreview: params.notificationPreviewCiphertext && params.epoch
        ? {
            version: 1,
            scope: 'direct',
            chatId: directChatId,
            epoch: params.epoch,
            ciphertext: params.notificationPreviewCiphertext,
          }
        : undefined,
    }
  );

  return { ack, statusUpdate: null };
}

export async function updateDirectMessageStatus(params: {
  familyId: string;
  identityId: IdentityId;
  deviceId?: string;
  serverMessageId: string;
  status: Exclude<MessageStatus, 'new'>;
  deliveryProof?: DirectMessageDeliveryProof;
}): Promise<{ statusUpdate: WSMessageStatusUpdateData | null }> {
  const message = await messageRepository.findMessageById(params.familyId, params.serverMessageId);
  if (!message) {
    throw new DirectMessageServiceError(404, 'NOT_FOUND' as ErrorCode, 'Message not found');
  }
  if (message.recipient_identity_id !== params.identityId) {
    throw new DirectMessageServiceError(403, 'FORBIDDEN' as ErrorCode, 'Recipient mismatch');
  }

  if (params.deliveryProof && params.status === 'delivered') {
    const recipientIdentity = await identityRepository.findByIdentityId(params.familyId, params.identityId);
    if (!params.deviceId || !recipientIdentity || !verifyDirectMessageDeliveryProof({
      proof: params.deliveryProof,
      message,
      recipientDeviceId: params.deviceId,
      recipientIdentityPublicKey: {
        algorithm: recipientIdentity.public_key_algorithm as 'ed25519' | 'x25519',
        value: recipientIdentity.public_key_value
      }
    })) {
      throw new DirectMessageServiceError(400, 'INVALID_SIGNATURE' as ErrorCode, 'Invalid delivery proof');
    }
    const statusUpdatedAt = Date.now();
    const recorded = await messageRepository.recordDeliveryProof(params.familyId, params.serverMessageId, params.deliveryProof, statusUpdatedAt);
    if (!recorded) return { statusUpdate: null };
    const statusUpdate: WSMessageStatusUpdateData = {
      serverMessageId: params.serverMessageId,
      status: message.status === 'read' ? 'read' : 'delivered',
      serverTimestamp: statusUpdatedAt,
      deliveryProof: params.deliveryProof
    };
    sendStatusUpdate(params.familyId, message.sender_identity_id,
      getDirectChatId(message.sender_identity_id, message.recipient_identity_id), statusUpdate);
    return { statusUpdate };
  }

  const nextStatus = params.status;
  if (message.status === 'read' || message.status === nextStatus) {
    return { statusUpdate: null };
  }

  let newStatus: MessageStatus | null = null;
  if (message.status === 'new' && nextStatus === 'delivered') {
    newStatus = 'delivered';
  } else if (message.status === 'delivered' && nextStatus === 'read') {
    newStatus = 'read';
  } else if (message.status === 'new' && nextStatus === 'read') {
    newStatus = 'read';
  } else {
    return { statusUpdate: null };
  }

  const statusUpdatedAt = Date.now();
  const directChatId = getDirectChatId(message.sender_identity_id, message.recipient_identity_id);
  await messageRepository.updateStatus(
    params.familyId,
    message.server_message_id,
    newStatus,
    statusUpdatedAt
  );
  const statusUpdate: WSMessageStatusUpdateData = {
    serverMessageId: message.server_message_id,
    status: newStatus,
    serverTimestamp: newStatus === 'read' && !message.read_proof?.receipt.payload.readTimeVisible
      ? Number(message.read_proof?.receipt.timestamp ?? message.created_at) : statusUpdatedAt,
    ...(message.delivery_proof ? { deliveryProof: message.delivery_proof } : {}),
    ...(message.read_proof ? { readProof: message.read_proof } : {}),
  };
  sendStatusUpdate(params.familyId, message.sender_identity_id, directChatId, statusUpdate);

  if (newStatus === 'read') {
    void sendMessagesReadPush(params.familyId, params.identityId, {
      dialogId: message.sender_identity_id,
      peerIdentityId: message.sender_identity_id,
      readThrough: message.created_at,
    });
  }

  return { statusUpdate };
}

export async function editDirectMessage(params: {
  familyId: string;
  identityId: IdentityId;
  serverMessageId: string;
  ciphertext: string;
  senderCiphertext?: string | null;
  senderSignature: string;
  authorClaim?: DirectMessageAuthorClaim;
  temporaryDevice?: boolean;
  epoch?: number | null;
}): Promise<{ mutation: WSMessageMutationUpdateData }> {
  const ciphertext = String(params.ciphertext || '');
  if (!ciphertext) {
    throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, 'ciphertext is required');
  }
  assertDirectEpoch(params.epoch);
  assertDirectEpochCiphertext(ciphertext, 'ciphertext');
  if (params.senderCiphertext) assertDirectEpochCiphertext(params.senderCiphertext, 'senderCiphertext');
  assertMessageSizeAllowed(ciphertext, params.senderCiphertext);

  const message = await messageRepository.findMessageById(params.familyId, params.serverMessageId);
  if (!message) {
    throw new DirectMessageServiceError(404, 'NOT_FOUND' as ErrorCode, 'Message not found');
  }
  if (message.sender_identity_id !== params.identityId) {
    throw new DirectMessageServiceError(403, 'FORBIDDEN' as ErrorCode, 'Only author can edit message');
  }
  if (message.deleted_at !== null) {
    throw new DirectMessageServiceError(409, 'INVALID_STATE' as ErrorCode, 'Deleted message cannot be edited');
  }
  const directChatId = getDirectChatId(message.sender_identity_id, message.recipient_identity_id);
  const currentEpoch = await messageRepository.getDirectCurrentEpoch(params.familyId, directChatId);
  if (params.epoch !== currentEpoch) {
    throw new DirectMessageServiceError(409, 'INVALID_STATE' as ErrorCode, 'Direct key epoch mismatch');
  }
  const epochKey = await messageRepository.findDirectEpochKey(params.familyId, directChatId, params.epoch);
  if (!epochKey) {
    throw new DirectMessageServiceError(409, 'INVALID_STATE' as ErrorCode, 'Direct key epoch is not initialized');
  }

  const senderIdentity = await identityRepository.findByIdentityId(params.familyId, params.identityId);
  if (!senderIdentity || !validateDirectMessageAuthorClaim({
    claim: params.authorClaim,
    action: 'edit',
    senderIdentityId: message.sender_identity_id,
    recipientIdentityId: message.recipient_identity_id,
    clientMessageId: message.client_message_id,
    clientCreatedAt: message.client_created_at,
    epoch: params.epoch,
    revision: params.authorClaim?.payload?.revision ?? Number.NaN,
    ciphertext,
    senderCiphertext: params.senderCiphertext,
    senderSignature: params.senderSignature,
    senderPublicKey: buildSenderPublicKey(senderIdentity)!,
    temporaryDevice: params.temporaryDevice === true
  })) throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, 'Invalid direct-message author claim');

  if (!sameMessageClaim(message.author_claim, params.authorClaim)
    && params.authorClaim!.payload.revision !== message.revision + 1) throw new MessageRevisionConflict();

  let editedAt = sameMessageClaim(message.author_claim, params.authorClaim) ? message.edited_at! : Date.now();
  const editDirectChatId = getDirectChatId(message.sender_identity_id, message.recipient_identity_id);
  const { chat_seq: editChatSeq, applied, edited_at: storedEditedAt } = await messageRepository.editMessage({
    familyId: params.familyId,
    directChatId: editDirectChatId,
    serverMessageId: message.server_message_id,
    ciphertext,
    senderCiphertext: params.senderCiphertext ?? null,
    senderSignature: params.senderSignature,
    authorClaim: params.authorClaim!,
    editedAt,
    epoch: params.epoch ?? null,
  });

  if (applied === false && storedEditedAt !== undefined) editedAt = storedEditedAt;

  const mutation: WSMessageMutationUpdateData = {
    serverMessageId: message.server_message_id,
    senderIdentityId: message.sender_identity_id,
    recipientIdentityId: message.recipient_identity_id,
    senderDeviceId: getSelfChatSenderDeviceId(
      message.sender_identity_id,
      message.recipient_identity_id,
      message.sender_device_id
    ),
    senderIdentityPublicKey: buildSenderPublicKey(senderIdentity),
    senderIdentityName: await resolvePublishedIdentityName(params.familyId, senderIdentity),
    ciphertext,
    senderCiphertext: params.senderCiphertext ?? undefined,
    senderSignature: params.senderSignature,
    authorClaim: params.authorClaim,
    clientMessageId: message.client_message_id,
    clientCreatedAt: message.client_created_at,
    temporaryIdentityDelegation: message.temporary_identity_delegation ?? undefined,
    serverTimestamp: message.created_at,
    editedAt,
    deletedAt: null,
    contentUpdatedAt: editedAt,
    revision: params.authorClaim?.payload?.revision ?? Number.NaN,
    epoch: params.epoch ?? message.epoch ?? undefined,
    chatSeq: editChatSeq,
  };

  if (applied !== false) sendMutationUpdate(params.familyId, [message.sender_identity_id, message.recipient_identity_id], mutation);
  return { mutation };
}

export async function deleteDirectMessage(params: {
  familyId: string;
  identityId: IdentityId;
  serverMessageId: string;
  authorClaim?: DirectMessageAuthorClaim;
  temporaryDevice?: boolean;
}): Promise<{ mutation: WSMessageMutationUpdateData | null }> {
  const message = await messageRepository.findMessageById(params.familyId, params.serverMessageId);
  if (!message) {
    throw new DirectMessageServiceError(404, 'NOT_FOUND' as ErrorCode, 'Message not found');
  }
  if (message.sender_identity_id !== params.identityId) {
    throw new DirectMessageServiceError(403, 'FORBIDDEN' as ErrorCode, 'Only author can delete message');
  }
  if (message.deleted_at !== null) {
    return { mutation: null };
  }

  const senderIdentity = await identityRepository.findByIdentityId(params.familyId, params.identityId);
  if (!senderIdentity || !validateDirectMessageAuthorClaim({
    claim: params.authorClaim,
    action: 'delete',
    senderIdentityId: message.sender_identity_id,
    recipientIdentityId: message.recipient_identity_id,
    clientMessageId: message.client_message_id,
    clientCreatedAt: message.client_created_at,
    epoch: Number(message.epoch || 0),
    revision: message.revision + 1,
    ciphertext: '',
    senderCiphertext: null,
    senderSignature: '',
    senderPublicKey: buildSenderPublicKey(senderIdentity)!,
    temporaryDevice: params.temporaryDevice === true
  })) throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, 'Invalid direct-message author claim');

  const deletedAt = Date.now();
  const deleteDirectChatId = getDirectChatId(message.sender_identity_id, message.recipient_identity_id);
  const { chat_seq: deleteChatSeq } = await messageRepository.softDeleteMessage({
    familyId: params.familyId,
    directChatId: deleteDirectChatId,
    serverMessageId: message.server_message_id,
    deletedAt,
    authorClaim: params.authorClaim!,
  });

  const mutation: WSMessageMutationUpdateData = {
    serverMessageId: message.server_message_id,
    senderIdentityId: message.sender_identity_id,
    recipientIdentityId: message.recipient_identity_id,
    senderDeviceId: getSelfChatSenderDeviceId(
      message.sender_identity_id,
      message.recipient_identity_id,
      message.sender_device_id
    ),
    senderIdentityPublicKey: buildSenderPublicKey(senderIdentity),
    senderIdentityName: await resolvePublishedIdentityName(params.familyId, senderIdentity),
    ciphertext: '',
    senderCiphertext: undefined,
    senderSignature: '',
    authorClaim: params.authorClaim,
    clientMessageId: message.client_message_id,
    clientCreatedAt: message.client_created_at,
    temporaryIdentityDelegation: message.temporary_identity_delegation ?? undefined,
    serverTimestamp: message.created_at,
    editedAt: message.edited_at,
    deletedAt,
    contentUpdatedAt: deletedAt,
    revision: message.revision + 1,
    epoch: message.epoch ?? undefined,
    chatSeq: deleteChatSeq,
  };

  sendMutationUpdate(params.familyId, [message.sender_identity_id, message.recipient_identity_id], mutation);
  return { mutation };
}

export async function markDirectMessagesRead(params: {
  familyId: string;
  identityId: IdentityId;
  deviceId?: string;
  peerIdentityId: IdentityId;
  readThrough: number;
  readProof?: DirectMessageReadProof;
}): Promise<{ statusUpdates: WSMessageStatusUpdateData[]; readCursor: WSReadCursorPushData }> {
  const now = Date.now();
  const directChatId = getDirectChatId(params.identityId, params.peerIdentityId);
  let proofMessages: Array<{ server_message_id: string; created_at: number }> = [];
  let proof: DirectMessageReadProof | undefined;

  if (params.readProof) {
    const identity = await identityRepository.findByIdentityId(params.familyId, params.identityId);
    if (!identity || !params.deviceId || !verifyDirectMessageReadProof({
      proof: params.readProof,
      senderIdentityId: params.peerIdentityId,
      recipientIdentityId: params.identityId,
      recipientDeviceId: params.deviceId,
      recipientIdentityPublicKey: {
        algorithm: identity.public_key_algorithm as 'ed25519' | 'x25519',
        value: identity.public_key_value
      },
      nowMs: now
    })) {
      throw new DirectMessageServiceError(400, 'INVALID_SIGNATURE' as ErrorCode, 'Invalid read proof');
    }
    const receipt = params.readProof.receipt;
    if (!identity.presence_visible && receipt.payload.readTimeVisible) {
      throw new DirectMessageServiceError(409, 'INVALID_STATE' as ErrorCode, 'READ_TIME_HIDDEN');
    }
    const ids = receipt.payload.serverMessageIds;
    proofMessages = await messageRepository.fetchMessagesForReadProof(
      params.familyId, params.peerIdentityId, params.identityId, ids
    );
    const delegationNotBefore = params.readProof.temporaryIdentityDelegation
      ? Date.parse(params.readProof.temporaryIdentityDelegation.payload.notBefore) : 0;
    const hiddenTimestamp = Math.max(params.readThrough, delegationNotBefore);
    if (proofMessages.length !== ids.length
      || (!receipt.payload.readTimeVisible && receipt.timestamp !== hiddenTimestamp)
      || proofMessages.some((message) => (
        message.created_at > params.readThrough || message.created_at > receipt.timestamp + 5 * 60_000
      ))) {
      throw new DirectMessageServiceError(400, 'INVALID_REQUEST' as ErrorCode, 'Read proof does not match this chat cursor');
    }
    proof = params.readProof;
  }

  await messageRepository.upsertReadCursor(
    params.familyId,
    params.identityId,
    params.peerIdentityId,
    params.readThrough,
    now
  );

  const unread = await messageRepository.fetchUnreadMessagesFromUpTo(
    params.familyId,
    params.peerIdentityId,
    params.identityId,
    params.readThrough
  );

  const statusUpdates: WSMessageStatusUpdateData[] = [];
  const proofIds = new Set(proofMessages.map((message) => message.server_message_id));
  for (const message of unread) {
    if (proof && proofIds.has(message.server_message_id)) continue;
    await messageRepository.updateStatus(params.familyId, message.server_message_id, 'read', now);
    const statusUpdate = {
      serverMessageId: message.server_message_id,
      status: 'read' as const,
      serverTimestamp: message.created_at,
    };
    statusUpdates.push(statusUpdate);
    sendStatusUpdate(params.familyId, params.peerIdentityId, directChatId, statusUpdate);
  }

  if (proof) {
    for (const message of proofMessages) {
      const recorded = await messageRepository.recordReadProof(
        params.familyId, params.peerIdentityId, params.identityId, message.server_message_id, proof, now
      );
      if (!recorded) continue;
      const statusUpdate: WSMessageStatusUpdateData = {
        serverMessageId: message.server_message_id,
        status: 'read',
        serverTimestamp: proof.receipt.payload.readTimeVisible ? now : proof.receipt.timestamp,
        readProof: proof
      };
      statusUpdates.push(statusUpdate);
      sendStatusUpdate(params.familyId, params.peerIdentityId, directChatId, statusUpdate);
    }
  }

  if (unread.length > 0) {
    void sendMessagesReadPush(params.familyId, params.identityId, {
      dialogId: params.peerIdentityId,
      peerIdentityId: params.peerIdentityId,
      readThrough: params.readThrough,
    });
  }

  const readCursor: WSReadCursorPushData = {
    peerIdentityId: params.peerIdentityId,
    readThrough: params.readThrough,
  };
  sendReadCursorUpdate(params.familyId, params.identityId, directChatId, readCursor);

  return { statusUpdates, readCursor };
}

export async function fetchDirectMessageSync(params: {
  familyId: string;
  identityId: IdentityId;
  deviceId: string;
  since?: number;
  limit?: number;
  peerIdentityId?: IdentityId;
}): Promise<{
  messages: WSMessageDeliverData[];
  syncedThrough: number;
  hasMore?: boolean;
  readCursors?: Array<{ peerIdentityId: IdentityId; readThrough: number }>;
}> {
  const syncState = await messageRepository.getSyncState(params.familyId, params.deviceId);
  // Focused per-chat sync uses the chat_seq cursor (seq space, starts at 0); the
  // global device sync keeps the timestamp watermark (last_sync_at).
  const since = typeof params.since === 'number' && Number.isFinite(params.since)
    ? params.since
    : (params.peerIdentityId ? 0 : syncState.last_sync_at);
  const limit = Math.max(1, Math.min(500, params.limit || 100));
  getRequestLogger({ subsystem: 'direct_messages' }).debug('direct_message_sync_started', {
    identityId: params.identityId,
    deviceId: params.deviceId,
    peerIdentityId: params.peerIdentityId ?? null,
    requestedSince: params.since ?? null,
    effectiveSince: since,
    limit
  });
  const candidates = await messageRepository.fetchMessagesForSync(
    params.familyId,
    params.identityId,
    params.deviceId as any,
    since,
    limit + 1,
    params.peerIdentityId
  );
  getRequestLogger({ subsystem: 'direct_messages' }).debug('direct_message_sync_candidates_loaded', {
    identityId: params.identityId,
    deviceId: params.deviceId,
    peerIdentityId: params.peerIdentityId ?? null,
    effectiveSince: since,
    candidateCount: candidates.length
  });

  const uniqueSenderIds = Array.from(new Set(candidates.map((m) => m.sender_identity_id)));
  const senderKeysById = new Map<string, PublicKey>();
  const senderRolesById = new Map<string, 'owner' | 'member' | 'guest'>();
  if (uniqueSenderIds.length > 0) {
    const rows = await query<{
      identity_id: string;
      public_key_algorithm: 'ed25519' | 'x25519';
      public_key_value: string;
      role: 'owner' | 'member' | 'guest' | null;
    }>(
      `SELECT identity_id, public_key_algorithm, public_key_value, role
       FROM identities
       WHERE family_id = $1 AND identity_id = ANY($2::text[])`,
      [params.familyId, uniqueSenderIds]
    );
    for (const row of rows.rows) {
      senderKeysById.set(row.identity_id, {
        algorithm: row.public_key_algorithm,
        value: row.public_key_value,
      });
      if (row.role === 'owner' || row.role === 'member' || row.role === 'guest') {
        senderRolesById.set(row.identity_id, row.role);
      }
    }
  }

  const hasMore = candidates.length > limit;
  const page = hasMore ? candidates.slice(0, limit) : candidates;
  const messages: WSMessageDeliverData[] = page.map((message) => ({
    serverMessageId: message.server_message_id,
    senderIdentityId: message.sender_identity_id,
    recipientIdentityId: message.recipient_identity_id,
    senderDeviceId: getSelfChatSenderDeviceId(
      message.sender_identity_id,
      message.recipient_identity_id,
      message.sender_device_id
    ),
    senderIdentityPublicKey: senderKeysById.get(message.sender_identity_id),
    senderIdentityRole: senderRolesById.get(message.sender_identity_id),
    ciphertext: message.ciphertext,
    senderCiphertext: message.sender_ciphertext ?? undefined,
    senderSignature: message.sender_signature,
    authorClaim: message.author_claim,
    temporaryIdentityDelegation: message.temporary_identity_delegation ?? undefined,
    clientMessageId: message.client_message_id,
    clientCreatedAt: message.client_created_at,
    serverTimestamp: Number(message.created_at),
    editedAt: message.edited_at,
    deletedAt: message.deleted_at,
    contentUpdatedAt: message.content_updated_at,
    revision: message.revision,
    epoch: message.epoch ?? undefined,
    chatSeq: message.chat_seq,
  }));

  // Focused per-chat sync advances on chat_seq; global sync on the timestamp watermark.
  const syncedThrough = page.length > 0
    ? (params.peerIdentityId
        ? Number(page[page.length - 1].chat_seq)
        : Number(page[page.length - 1].content_updated_at))
    : since;
  const readCursors = hasMore
    ? undefined
    : (await messageRepository.fetchReadCursors(params.familyId, params.identityId))
        .filter((row) => !params.peerIdentityId || row.peer_identity_id === params.peerIdentityId)
        .map((row) => ({ peerIdentityId: row.peer_identity_id as IdentityId, readThrough: row.read_through }));

  getRequestLogger({ subsystem: 'direct_messages' }).debug('direct_message_sync_completed', {
    identityId: params.identityId,
    deviceId: params.deviceId,
    peerIdentityId: params.peerIdentityId ?? null,
    effectiveSince: since,
    returnedCount: messages.length,
    hasMore,
    syncedThrough
  });

  return { messages, syncedThrough, hasMore, readCursors };
}

export async function fetchDirectMessageStatusSync(params: {
  familyId: string;
  identityId: IdentityId;
  deviceId: string;
  since?: number;
  limit?: number;
  peerIdentityId?: IdentityId;
}): Promise<{
  updates: WSMessageStatusUpdateData[];
  syncedThrough: number;
  hasMore?: boolean;
}> {
  const syncState = await messageRepository.getSyncState(params.familyId, params.deviceId as any);
  const since = typeof params.since === 'number' && Number.isFinite(params.since)
    ? params.since
    // Focused sync is also a repair path for devices that acknowledged a
    // receipt before the corresponding history page was stored locally.
    : (params.peerIdentityId ? 0 : syncState.last_status_sync_at);
  const limit = Math.max(1, Math.min(500, params.limit || 100));
  const candidates = await messageRepository.fetchStatusUpdatesForSync(
    params.familyId,
    params.identityId,
    since,
    limit + 1,
    params.peerIdentityId
  );
  const hasMore = candidates.length > limit;
  const page = hasMore ? candidates.slice(0, limit) : candidates;
  const updates: WSMessageStatusUpdateData[] = page.map((message) => ({
    serverMessageId: message.server_message_id,
    status: message.status === 'new' ? 'delivered' : message.status,
    serverTimestamp: message.status === 'read' && !message.read_proof?.receipt.payload.readTimeVisible
      ? Number(message.read_proof?.receipt.timestamp ?? message.created_at) : Number(message.status_updated_at),
    ...(message.delivery_proof ? { deliveryProof: message.delivery_proof } : {}),
    ...(message.read_proof ? { readProof: message.read_proof } : {}),
  }));
  const syncedThrough = page.length > 0 ? Number(page[page.length - 1].status_updated_at) : since;
  return { updates, syncedThrough, hasMore };
}
