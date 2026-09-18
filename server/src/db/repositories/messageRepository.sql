/* @name FindMessageByClientMessageId */
SELECT server_message_id, created_at
FROM messages
WHERE family_id = :familyId
  AND sender_device_id = :deviceId
  AND client_message_id = :clientMessageId
LIMIT 1;

/* @name InsertDirectMessage */
INSERT INTO messages (
  server_message_id,
  family_id,
  sender_identity_id,
  recipient_identity_id,
  sender_device_id,
  ciphertext,
  sender_ciphertext,
  sender_signature,
  client_message_id,
  client_created_at,
  created_at,
  content_updated_at,
  revision,
  status,
  status_updated_at
) VALUES (
  :serverMessageId,
  :familyId,
  :senderIdentityId,
  :recipientIdentityId,
  :senderDeviceId,
  :ciphertext,
  :senderCiphertext,
  :senderSignature,
  :clientMessageId,
  :clientCreatedAt,
  :createdAt,
  :createdAt,
  1,
  :status,
  :statusUpdatedAt
);

/* @name UpdateDirectMessageStatus */
UPDATE messages
SET status = :status,
    status_updated_at = :statusUpdatedAt
WHERE family_id = :familyId
  AND server_message_id = :serverMessageId;

/* @name FindDirectMessageById */
SELECT *
FROM messages
WHERE family_id = :familyId
  AND server_message_id = :serverMessageId
LIMIT 1;

/* @name FetchDirectMessagesForSync */
SELECT *
FROM messages
WHERE family_id = :familyId
  AND GREATEST(created_at, content_updated_at) > :since
  AND (
    recipient_identity_id = :identityId
    OR (sender_identity_id = :identityId AND sender_device_id <> :deviceId)
  )
ORDER BY GREATEST(created_at, content_updated_at) ASC, created_at ASC
LIMIT :limit;

/* @name FetchDirectMessageStatusUpdatesForSync */
SELECT *
FROM messages
WHERE family_id = :familyId
  AND sender_identity_id = :senderIdentityId
  AND status <> 'new'
  AND status_updated_at > :since
ORDER BY status_updated_at ASC
LIMIT :limit;

/* @name FetchReadDirectMessagesForSenderUpTo */
SELECT *
FROM messages
WHERE family_id = :familyId
  AND sender_identity_id = :senderIdentityId
  AND status = 'read'
  AND status_updated_at <= :syncedThrough;

/* @name FindMessageDeviceSyncState */
SELECT last_sync_at, last_status_sync_at, last_mutation_sync_at
FROM message_device_sync
WHERE family_id = :familyId
  AND device_id = :deviceId;

/* @name EnsureMessageDeviceSyncState */
INSERT INTO message_device_sync (family_id, device_id, last_sync_at, last_status_sync_at, last_mutation_sync_at)
VALUES (:familyId, :deviceId, 0, 0, 0)
ON CONFLICT DO NOTHING;

/* @name UpsertMessageDeviceSyncState */
INSERT INTO message_device_sync (family_id, device_id, last_sync_at, last_status_sync_at, last_mutation_sync_at)
VALUES (:familyId, :deviceId, :lastSyncAt, :lastStatusSyncAt, :lastMutationSyncAt)
ON CONFLICT (family_id, device_id)
DO UPDATE SET
  last_sync_at = GREATEST(message_device_sync.last_sync_at, EXCLUDED.last_sync_at),
  last_status_sync_at = GREATEST(message_device_sync.last_status_sync_at, EXCLUDED.last_status_sync_at),
  last_mutation_sync_at = GREATEST(message_device_sync.last_mutation_sync_at, EXCLUDED.last_mutation_sync_at);

/* @name DeleteDirectMessage */
DELETE FROM messages
WHERE family_id = :familyId
  AND server_message_id = :serverMessageId;
