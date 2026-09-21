import { query, transaction } from '../index';
import type { DBAttachmentBlob, DBAttachmentUploadReservation, DBFamilyConfig } from '../types';

type AttachmentReservationCreateParams = {
  reservationId: string;
  blobId: string;
  familyId: string;
  uploaderIdentityId: string;
  plaintextSizeBytes: number;
  storageKey: string;
  expiresAt: Date;
  reservedUntil: Date;
  uploadTokenHash: string;
};

export class AttachmentRepository {
  async lockFamilyConfig(familyId: string, client?: { query: typeof query }): Promise<DBFamilyConfig | null> {
    const executor = client || { query };
    const result = await executor.query<DBFamilyConfig>(
      `SELECT * FROM family_config WHERE family_id = $1 FOR UPDATE`,
      [familyId]
    );
    return result.rows[0] || null;
  }

  async createReservation(params: AttachmentReservationCreateParams): Promise<void> {
    await transaction(async (client) => {
      const config = await this.lockFamilyConfig(params.familyId, client);
      if (!config) {
        throw new Error('Family configuration not found');
      }

      await client.query(
        `INSERT INTO attachment_blobs (
           blob_id, family_id, uploader_identity_id,
           plaintext_size_bytes, storage_key, status, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'reserved', $6, NOW(), NOW())`,
        [
          params.blobId,
          params.familyId,
          params.uploaderIdentityId,
          params.plaintextSizeBytes,
          params.storageKey,
          params.expiresAt
        ]
      );

      await client.query(
        `INSERT INTO attachment_upload_reservations (
           reservation_id, blob_id, family_id, uploader_identity_id, upload_token_hash,
           plaintext_size_bytes, status, reserved_until, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'reserved', $7, NOW(), NOW())`,
        [
          params.reservationId,
          params.blobId,
          params.familyId,
          params.uploaderIdentityId,
          params.uploadTokenHash,
          params.plaintextSizeBytes,
          params.reservedUntil
        ]
      );

      await client.query(
        `UPDATE family_config
         SET reserved_attachment_storage_bytes = reserved_attachment_storage_bytes + $2,
             updated_at = NOW()
         WHERE family_id = $1`,
        [params.familyId, params.plaintextSizeBytes]
      );
    });
  }

  async findReservationById(familyId: string, reservationId: string): Promise<DBAttachmentUploadReservation | null> {
    const result = await query<DBAttachmentUploadReservation>(
      `SELECT * FROM attachment_upload_reservations
       WHERE family_id = $1 AND reservation_id = $2
       LIMIT 1`,
      [familyId, reservationId]
    );
    return result.rows[0] || null;
  }

  async findReservationByBlobId(familyId: string, blobId: string): Promise<DBAttachmentUploadReservation | null> {
    const result = await query<DBAttachmentUploadReservation>(
      `SELECT * FROM attachment_upload_reservations
       WHERE family_id = $1 AND blob_id = $2
       LIMIT 1`,
      [familyId, blobId]
    );
    return result.rows[0] || null;
  }

  async findBlobById(familyId: string, blobId: string): Promise<DBAttachmentBlob | null> {
    const result = await query<DBAttachmentBlob>(
      `SELECT * FROM attachment_blobs
       WHERE family_id = $1 AND blob_id = $2
       LIMIT 1`,
      [familyId, blobId]
    );
    return result.rows[0] || null;
  }

  async markReservationUploading(familyId: string, reservationId: string): Promise<void> {
    await query(
      `UPDATE attachment_upload_reservations
       SET status = 'uploading', updated_at = NOW()
       WHERE family_id = $1 AND reservation_id = $2`,
      [familyId, reservationId]
    );
  }

  async markUploaded(params: {
    familyId: string;
    reservationId: string;
    blobId: string;
    ciphertextSizeBytes: number;
    ciphertextSha256: string | null;
  }): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `UPDATE attachment_upload_reservations
         SET status = 'uploaded',
             ciphertext_size_bytes = $3,
             uploaded_at = NOW(),
             updated_at = NOW()
         WHERE family_id = $1 AND reservation_id = $2`,
        [params.familyId, params.reservationId, params.ciphertextSizeBytes]
      );

      await client.query(
        `UPDATE attachment_blobs
         SET status = 'uploaded',
             ciphertext_size_bytes = $3,
             ciphertext_sha256 = COALESCE($4, ciphertext_sha256),
             updated_at = NOW()
         WHERE family_id = $1 AND blob_id = $2`,
        [params.familyId, params.blobId, params.ciphertextSizeBytes, params.ciphertextSha256]
      );
    });
  }

  async commitBlob(params: {
    familyId: string;
    reservationId: string;
    blobId: string;
    senderIdentityId: string;
    chatType: 'direct' | 'group' | 'channel';
    chatId: string;
    linkedMessageId: string;
  }): Promise<DBAttachmentBlob | null> {
    return transaction(async (client) => {
      const reservationResult = await client.query<DBAttachmentUploadReservation>(
        `SELECT * FROM attachment_upload_reservations
         WHERE family_id = $1 AND reservation_id = $2
         FOR UPDATE`,
        [params.familyId, params.reservationId]
      );
      const reservation = reservationResult.rows[0];
      if (!reservation) return null;

      const blobResult = await client.query<DBAttachmentBlob>(
        `SELECT * FROM attachment_blobs
         WHERE family_id = $1 AND blob_id = $2
         FOR UPDATE`,
        [params.familyId, params.blobId]
      );
      const blob = blobResult.rows[0];
      if (!blob) return null;

      if (reservation.status === 'committed' || blob.status === 'committed') {
        const isSameCommit = reservation.blob_id === params.blobId
          && blob.status === 'committed'
          && blob.sender_identity_id === params.senderIdentityId
          && blob.chat_type === params.chatType
          && blob.chat_id === params.chatId
          && blob.linked_message_id === params.linkedMessageId;
        return isSameCommit ? blob : null;
      }

      await client.query(
        `UPDATE attachment_upload_reservations
         SET status = 'committed',
             committed_at = NOW(),
             updated_at = NOW()
         WHERE reservation_id = $1`,
        [params.reservationId]
      );

      const updatedBlobResult = await client.query<DBAttachmentBlob>(
        `UPDATE attachment_blobs
         SET status = 'committed',
             sender_identity_id = $3,
             chat_type = $4,
             chat_id = $5,
             linked_message_id = $6,
             committed_at = NOW(),
             updated_at = NOW()
         WHERE family_id = $1 AND blob_id = $2
         RETURNING *`,
        [params.familyId, params.blobId, params.senderIdentityId, params.chatType, params.chatId, params.linkedMessageId]
      );

      await client.query(
        `UPDATE family_config
         SET reserved_attachment_storage_bytes = GREATEST(0, reserved_attachment_storage_bytes - $2),
             used_attachment_storage_bytes = used_attachment_storage_bytes + $2,
             updated_at = NOW()
         WHERE family_id = $1`,
        [params.familyId, reservation.plaintext_size_bytes]
      );

      return updatedBlobResult.rows[0] || null;
    });
  }

  async requestDeletion(params: {
    familyId: string;
    blobId: string;
    deletedByIdentityId: string | null;
    deleteReason: 'user_request' | 'expired' | 'failed_commit' | 'admin_delete';
  }): Promise<DBAttachmentBlob | null> {
    const result = await query<DBAttachmentBlob>(
      `UPDATE attachment_blobs
       SET status = CASE WHEN status IN ('deleted', 'expired') THEN status ELSE 'pending_delete' END,
           deleted_by_identity_id = COALESCE(deleted_by_identity_id, $3),
           delete_reason = COALESCE(delete_reason, $4),
           updated_at = NOW()
       WHERE family_id = $1 AND blob_id = $2
       RETURNING *`,
      [params.familyId, params.blobId, params.deletedByIdentityId, params.deleteReason]
    );
    return result.rows[0] || null;
  }

  async finalizeDeletion(params: {
    familyId: string;
    blobId: string;
    finalStatus: 'deleted' | 'expired';
  }): Promise<DBAttachmentBlob | null> {
    return transaction(async (client) => {
      const blobResult = await client.query<DBAttachmentBlob>(
        `SELECT * FROM attachment_blobs WHERE family_id = $1 AND blob_id = $2 FOR UPDATE`,
        [params.familyId, params.blobId]
      );
      const blob = blobResult.rows[0];
      if (!blob) return null;

      if (blob.status === 'deleted' || blob.status === 'expired') {
        return blob;
      }

      const updatedResult = await client.query<DBAttachmentBlob>(
        `UPDATE attachment_blobs
         SET status = $3,
             deleted_at = NOW(),
             updated_at = NOW()
         WHERE family_id = $1 AND blob_id = $2
         RETURNING *`,
        [params.familyId, params.blobId, params.finalStatus]
      );

      const sizeToRelease = Number(blob.plaintext_size_bytes || 0);
      if (sizeToRelease > 0 && blob.status === 'committed') {
        await client.query(
          `UPDATE family_config
           SET used_attachment_storage_bytes = GREATEST(0, used_attachment_storage_bytes - $2),
               updated_at = NOW()
           WHERE family_id = $1`,
          [params.familyId, sizeToRelease]
        );
      } else if (sizeToRelease > 0 && (blob.status === 'reserved' || blob.status === 'uploaded')) {
        await client.query(
          `UPDATE family_config
           SET reserved_attachment_storage_bytes = GREATEST(0, reserved_attachment_storage_bytes - $2),
               updated_at = NOW()
           WHERE family_id = $1`,
          [params.familyId, sizeToRelease]
        );
      }

      return updatedResult.rows[0] || null;
    });
  }

  /**
   * Create an avatar blob directly in 'committed' state (no reservation flow).
   * Avatar ciphertext is stored directly in committed state. Encryption and
   * media validation happen on the client; the server only sees opaque bytes.
   */
  async createAvatarBlob(params: {
    blobId: string;
    familyId: string;
    uploaderIdentityId: string;
    purpose?: 'encrypted_payload' | 'public_presentation';
    originalFileName?: string | null;
    mimeType?: string | null;
    sizeBytes: number;
    storageKey: string;
  }): Promise<void> {
    await query(
      `INSERT INTO attachment_blobs (
         blob_id, family_id, uploader_identity_id, blob_purpose, original_file_name, mime_type,
         plaintext_size_bytes, ciphertext_size_bytes, storage_key, status,
         expires_at, committed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'committed',
         NOW() + INTERVAL '24 hours', NOW(), NOW(), NOW())
       ON CONFLICT (blob_id) DO NOTHING`,
      [
        params.blobId,
        params.familyId,
        params.uploaderIdentityId,
        params.purpose || 'encrypted_payload',
        params.originalFileName || null,
        params.mimeType || null,
        params.sizeBytes,
        params.storageKey,
      ]
    );
  }

  async expireStaleReservations(now: Date): Promise<Array<{ family_id: string; blob_id: string; reservation_id: string }>> {
    const result = await query<{ family_id: string; blob_id: string; reservation_id: string }>(
      `UPDATE attachment_upload_reservations
       SET status = 'expired',
           released_at = NOW(),
           updated_at = NOW()
       WHERE status IN ('reserved', 'uploading', 'uploaded')
         AND reserved_until < $1
       RETURNING family_id::text, blob_id, reservation_id`,
      [now]
    );
    return result.rows;
  }

  async listExpiredOrPendingDeleteBlobs(now: Date): Promise<DBAttachmentBlob[]> {
    const result = await query<DBAttachmentBlob>(
      `SELECT *
       FROM attachment_blobs
       WHERE (status = 'pending_delete')
          OR (status = 'committed' AND expires_at < $1)
       ORDER BY created_at ASC
       LIMIT 200`,
      [now]
    );
    return result.rows;
  }
}

export const attachmentRepository = new AttachmentRepository();
