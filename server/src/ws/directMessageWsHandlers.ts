import type { WebSocket } from 'ws';
import type {
  IdentityId,
  ReadCursor,
  WebSocketMessage,
  WSMarkReadData,
  WSMessageDeleteData,
  WSMessageDeliverData,
  WSMessageEditData,
  WSMessageSendData,
  WSMessageStatusData,
  WSMessageStatusUpdateData,
  WSMessageSyncAckData,
  WSMessageSyncData,
  WSMessageSyncStatusAckData,
  WSMessageSyncStatusData
} from '@shared/types';
import { messageRepository } from '../db/repositories';
import { query } from '../db';
import type { AuthenticatedActor } from '../services/authenticatedActor';
import {
  DirectMessageServiceError,
  deleteDirectMessage,
  editDirectMessage,
  markDirectMessagesRead,
  sendDirectMessage,
  updateDirectMessageStatus
} from '../services/directMessages';
import { serverLogger, type Logger } from '../utils/logger';

export type DirectMessageWsHandlerDependencies = {
  requireActor: (ws: WebSocket, deviceId?: string) => AuthenticatedActor | null;
  requireTemporaryChatAccess: (ws: WebSocket, peerIdentityId: string) => Promise<boolean>;
  rejectTemporaryDirectMessages: (ws: WebSocket) => boolean;
  sendMessage: (ws: WebSocket, message: WebSocketMessage) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
  maxSyncBatch: number;
  logger?: Logger;
  now?: () => number;
};

export class DirectMessageWsHandlers {
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly dependencies: DirectMessageWsHandlerDependencies) {
    this.now = dependencies.now || Date.now;
    this.logger = dependencies.logger || serverLogger.child({ subsystem: 'direct_message_ws' });
  }

  async handleSend(ws: WebSocket, data: WSMessageSendData): Promise<void> {
    const actor = this.dependencies.requireActor(ws, data.deviceId);
    if (!actor) return;
    if (!await this.dependencies.requireTemporaryChatAccess(ws, data.payload.recipientIdentityId)) return;
    try {
      const result = await sendDirectMessage({
        familyId: actor.familyId,
        senderIdentityId: actor.identityId,
        senderDeviceId: actor.deviceId,
        recipientIdentityId: data.payload.recipientIdentityId,
        ciphertext: data.payload.ciphertext,
        senderCiphertext: data.payload.senderCiphertext,
        notificationPreviewCiphertext: data.payload.notificationPreviewCiphertext ?? null,
        senderSignature: data.signature,
        authorClaim: data.payload.authorClaim,
        temporaryIdentityDelegation: data.payload.temporaryIdentityDelegation,
        clientMessageId: data.payload.clientMessageId,
        clientCreatedAt: data.payload.clientCreatedAt ?? null,
        epoch: typeof data.payload.epoch === 'number' ? data.payload.epoch : null
      });
      this.dependencies.sendMessage(ws, {
        type: 'message:ack',
        data: result.ack,
        timestamp: this.now()
      });
    } catch (error) {
      this.handleServiceError(ws, error, 'send', actor, 'Failed to send message');
    }
  }

  async handleStatus(ws: WebSocket, data: WSMessageStatusData): Promise<void> {
    const actor = this.requirePermanentActor(ws, data.deviceId);
    if (!actor) return;
    try {
      await updateDirectMessageStatus({
        familyId: actor.familyId,
        identityId: actor.identityId,
        deviceId: actor.deviceId,
        serverMessageId: data.payload.serverMessageId,
        status: data.payload.status,
        deliveryProof: data.payload.deliveryProof
      });
    } catch (error) {
      this.handleServiceError(ws, error, 'status', actor, 'Failed to update message status');
    }
  }

  async handleEdit(ws: WebSocket, data: WSMessageEditData): Promise<void> {
    const actor = this.requirePermanentActor(ws, data.deviceId);
    if (!actor) return;
    try {
      await editDirectMessage({
        familyId: actor.familyId,
        identityId: actor.identityId,
        serverMessageId: data.payload.serverMessageId,
        ciphertext: data.payload.ciphertext,
        senderCiphertext: data.payload.senderCiphertext,
        senderSignature: data.signature,
        authorClaim: data.payload.authorClaim,
        epoch: typeof data.payload.epoch === 'number' ? data.payload.epoch : null
      });
    } catch (error) {
      this.handleServiceError(ws, error, 'edit', actor, 'Failed to edit message');
    }
  }

  async handleDelete(ws: WebSocket, data: WSMessageDeleteData): Promise<void> {
    const actor = this.requirePermanentActor(ws, data.deviceId);
    if (!actor) return;
    try {
      await deleteDirectMessage({
        familyId: actor.familyId,
        identityId: actor.identityId,
        serverMessageId: data.payload.serverMessageId,
        authorClaim: data.payload.authorClaim
      });
    } catch (error) {
      this.handleServiceError(ws, error, 'delete', actor, 'Failed to delete message');
    }
  }

  async handleSync(ws: WebSocket, data: WSMessageSyncData): Promise<void> {
    const actor = this.requirePermanentActor(ws, data.deviceId);
    if (!actor) return;
    const syncState = await messageRepository.getSyncState(actor.familyId, actor.deviceId);
    const since = typeof data.payload?.since === 'number' && Number.isFinite(data.payload.since)
      ? data.payload.since
      : syncState.last_sync_at;
    const candidates = await messageRepository.fetchMessagesForSync(
      actor.familyId,
      actor.identityId,
      actor.deviceId,
      since,
      this.dependencies.maxSyncBatch + 1
    );
    const uniqueSenderIds = Array.from(new Set(candidates.map((message) => message.sender_identity_id)));
    const senderKeysById = new Map<string, { algorithm: 'ed25519' | 'x25519'; value: string }>();
    if (uniqueSenderIds.length > 0) {
      const rows = await query<{
        identity_id: string;
        public_key_algorithm: 'ed25519' | 'x25519';
        public_key_value: string;
      }>(
        `SELECT identity_id, public_key_algorithm, public_key_value
         FROM identities
         WHERE family_id = $1 AND identity_id = ANY($2::text[])`,
        [actor.familyId, uniqueSenderIds]
      );
      for (const row of rows.rows) {
        senderKeysById.set(row.identity_id, {
          algorithm: row.public_key_algorithm,
          value: row.public_key_value
        });
      }
    }
    const hasMore = candidates.length > this.dependencies.maxSyncBatch;
    const page = hasMore ? candidates.slice(0, this.dependencies.maxSyncBatch) : candidates;
    const messages: WSMessageDeliverData[] = page.map((message) => ({
      serverMessageId: message.server_message_id,
      senderIdentityId: message.sender_identity_id,
      recipientIdentityId: message.recipient_identity_id,
      senderIdentityPublicKey: senderKeysById.get(message.sender_identity_id),
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
      chatSeq: message.chat_seq
    }));
    const syncedThrough = page.length > 0 ? Number(page[page.length - 1].content_updated_at) : since;
    const readCursors = hasMore ? undefined : (await messageRepository.fetchReadCursors(
      actor.familyId,
      actor.identityId
    )).map((row) => ({
      peerIdentityId: row.peer_identity_id as IdentityId,
      readThrough: row.read_through
    } as ReadCursor));
    this.dependencies.sendMessage(ws, {
      type: 'message:sync-result',
      data: { messages, syncedThrough, hasMore, readCursors },
      timestamp: this.now()
    });
  }

  async handleSyncStatus(ws: WebSocket, data: WSMessageSyncStatusData): Promise<void> {
    const actor = this.requirePermanentActor(ws, data.deviceId);
    if (!actor) return;
    const syncState = await messageRepository.getSyncState(actor.familyId, actor.deviceId);
    const since = typeof data.payload?.since === 'number' && Number.isFinite(data.payload.since)
      ? data.payload.since
      : syncState.last_status_sync_at;
    const candidates = await messageRepository.fetchStatusUpdatesForSync(
      actor.familyId,
      actor.identityId,
      since,
      this.dependencies.maxSyncBatch + 1
    );
    const hasMore = candidates.length > this.dependencies.maxSyncBatch;
    const page = hasMore ? candidates.slice(0, this.dependencies.maxSyncBatch) : candidates;
    const updates: WSMessageStatusUpdateData[] = page.map((message) => ({
      serverMessageId: message.server_message_id,
      status: message.status === 'new' ? 'delivered' : message.status,
      serverTimestamp: Number(message.status_updated_at),
      ...(message.delivery_proof ? { deliveryProof: message.delivery_proof } : {})
    }));
    const syncedThrough = page.length > 0 ? Number(page[page.length - 1].status_updated_at) : since;
    this.dependencies.sendMessage(ws, {
      type: 'message:sync-status-result',
      data: { updates, syncedThrough, hasMore },
      timestamp: this.now()
    });
  }

  async handleSyncAck(ws: WebSocket, data: WSMessageSyncAckData): Promise<void> {
    const actor = this.requirePermanentActor(ws, data.deviceId);
    if (!actor) return;
    const state = await messageRepository.getSyncState(actor.familyId, actor.deviceId);
    await messageRepository.updateSyncState(
      actor.familyId,
      actor.deviceId,
      Math.max(state.last_sync_at, data.payload.syncedThrough),
      state.last_status_sync_at,
      Math.max(state.last_mutation_sync_at, data.payload.syncedThrough)
    );
  }

  async handleSyncStatusAck(ws: WebSocket, data: WSMessageSyncStatusAckData): Promise<void> {
    const actor = this.requirePermanentActor(ws, data.deviceId);
    if (!actor) return;
    const state = await messageRepository.getSyncState(actor.familyId, actor.deviceId);
    await messageRepository.updateSyncState(
      actor.familyId,
      actor.deviceId,
      state.last_sync_at,
      Math.max(state.last_status_sync_at, data.payload.syncedThrough),
      state.last_mutation_sync_at
    );
  }

  async handleMarkRead(ws: WebSocket, data: WSMarkReadData): Promise<void> {
    const actor = this.requirePermanentActor(ws, data.deviceId);
    if (!actor) return;
    try {
      await markDirectMessagesRead({
        familyId: actor.familyId,
        identityId: actor.identityId,
        peerIdentityId: data.payload.peerIdentityId,
        readThrough: data.payload.readThrough
      });
    } catch (error) {
      this.handleServiceError(ws, error, 'mark_read', actor, 'Failed to mark messages as read');
    }
  }

  private requirePermanentActor(ws: WebSocket, deviceId?: string): AuthenticatedActor | null {
    const actor = this.dependencies.requireActor(ws, deviceId);
    if (!actor || this.dependencies.rejectTemporaryDirectMessages(ws)) return null;
    return actor;
  }

  private handleServiceError(
    ws: WebSocket,
    error: unknown,
    operation: string,
    actor: AuthenticatedActor,
    clientMessage: string
  ): void {
    if (error instanceof DirectMessageServiceError) {
      this.dependencies.sendError(ws, error.code, error.message);
      return;
    }
    this.logger.error('direct_message_ws_operation_failed', {
      familyId: actor.familyId,
      identityId: actor.identityId,
      deviceId: actor.deviceId,
      operation,
      error
    });
    this.dependencies.sendError(ws, 'INTERNAL_ERROR', clientMessage);
  }
}
