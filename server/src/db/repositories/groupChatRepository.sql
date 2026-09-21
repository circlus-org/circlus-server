/* @name InsertGroupChatParticipant */
INSERT INTO group_chat_participants
  (chat_id, family_id, identity_id, added_by_identity_id, joined_at, is_active, join_order)
VALUES
  (:chatId, :familyId, :identityId, :addedByIdentityId, :joinedAt, TRUE, :joinOrder);

/* @name EnsureGroupChatReadState */
INSERT INTO group_chat_reads (chat_id, family_id, identity_id, last_read_at)
VALUES (:chatId, :familyId, :identityId, :lastReadAt)
ON CONFLICT DO NOTHING;

/* @name FindGroupChat */
SELECT *
FROM group_chats
WHERE family_id = :familyId
  AND chat_id = :chatId
LIMIT 1;

/* @name FindGroupChatParticipant */
SELECT *
FROM group_chat_participants
WHERE family_id = :familyId
  AND chat_id = :chatId
  AND identity_id = :identityId
LIMIT 1;

/* @name ListActiveGroupChatParticipants */
SELECT *
FROM group_chat_participants
WHERE family_id = :familyId
  AND chat_id = :chatId
  AND is_active = TRUE
ORDER BY join_order ASC;


/* @name SetGroupChatParticipantMuted */
UPDATE group_chat_participants
SET muted = :muted
WHERE family_id = :familyId
  AND chat_id = :chatId
  AND identity_id = :identityId;

/* @name ReactivateGroupChatParticipant */
UPDATE group_chat_participants
SET is_active = TRUE,
    left_at = NULL,
    joined_at = :joinedAt,
    added_by_identity_id = :addedByIdentityId,
    join_order = :joinOrder
WHERE family_id = :familyId
  AND chat_id = :chatId
  AND identity_id = :identityId;

/* @name RemoveGroupChatParticipant */
UPDATE group_chat_participants
SET is_active = FALSE,
    left_at = :leftAt
WHERE family_id = :familyId
  AND chat_id = :chatId
  AND identity_id = :identityId;

/* @name FindGroupChatMessageByClientMessageId */
SELECT message_id, created_at
FROM group_chat_messages
WHERE family_id = :familyId
  AND chat_id = :chatId
  AND sender_device_id = :senderDeviceId
  AND client_message_id = :clientMessageId
LIMIT 1;

/* @name InsertGroupChatMessage */
INSERT INTO group_chat_messages
  (message_id, family_id, chat_id, sender_identity_id, sender_device_id, kind, ciphertext, sender_signature, client_message_id, client_created_at, created_at, content_updated_at, revision, system_type, system_payload_json, epoch)
VALUES
  (:messageId, :familyId, :chatId, :senderIdentityId, :senderDeviceId, :kind, :ciphertext, :senderSignature, :clientMessageId, :clientCreatedAt, :createdAt, :createdAt, 1, :systemType, :systemPayloadJson, :epoch);

/* @name UpdateGroupChatPreview */
UPDATE group_chats
SET last_message_at = :createdAt,
    updated_at = :createdAt,
    last_message_preview = :preview
WHERE family_id = :familyId
  AND chat_id = :chatId;

/* @name ListGroupChatMessages */
SELECT *
FROM group_chat_messages
WHERE family_id = :familyId
  AND chat_id = :chatId
  AND GREATEST(created_at, content_updated_at) > :since
ORDER BY GREATEST(created_at, content_updated_at) ASC, created_at ASC
LIMIT :limit;

/* @name UpsertGroupChatRead */
INSERT INTO group_chat_reads (chat_id, family_id, identity_id, last_read_at)
VALUES (:chatId, :familyId, :identityId, :readAt)
ON CONFLICT (chat_id, family_id, identity_id)
DO UPDATE SET last_read_at = GREATEST(group_chat_reads.last_read_at, EXCLUDED.last_read_at);

/* @name UpsertGroupChatKeyEnvelope */
INSERT INTO group_chat_key_envelopes (chat_id, family_id, epoch, identity_id, envelope_ciphertext, publisher_identity_id, created_at)
VALUES (:chatId, :familyId, :epoch, :identityId, :envelopeCiphertext, :publisherIdentityId, :createdAt)
ON CONFLICT (chat_id, family_id, epoch, identity_id)
DO UPDATE SET
  envelope_ciphertext = EXCLUDED.envelope_ciphertext,
  publisher_identity_id = EXCLUDED.publisher_identity_id,
  created_at = EXCLUDED.created_at;

/* @name FindGroupChatKeyEnvelopeForIdentity */
SELECT chat_id, family_id, epoch, identity_id, envelope_ciphertext, publisher_identity_id, created_at
FROM group_chat_key_envelopes
WHERE family_id = :familyId
  AND chat_id = :chatId
  AND epoch = :epoch
  AND identity_id = :identityId
LIMIT 1;

/* @name FindGroupChatEpochKeyCommitment */
SELECT key_commitment
FROM group_chat_epoch_keys
WHERE chat_id = :chatId
  AND family_id = :familyId
  AND epoch = :epoch
LIMIT 1;

/* @name ListActiveGroupChatParticipantsWithIdentityKeys */
SELECT p.identity_id, p.join_order, p.joined_at, i.public_key_algorithm, i.public_key_value
FROM group_chat_participants p
JOIN identities i
  ON i.identity_id = p.identity_id
 AND i.family_id::text = p.family_id::text
WHERE p.family_id::text = :familyId::text
  AND p.chat_id = :chatId::text
  AND p.is_active = TRUE
ORDER BY p.join_order ASC;

/* @name FindGroupChatEpochKey */
SELECT chat_id, family_id, epoch, key_commitment, proposer_identity_id, proposer_device_id, signed_epoch_transition, created_at
FROM group_chat_epoch_keys
WHERE chat_id = :chatId
  AND family_id = :familyId
  AND epoch = :epoch
LIMIT 1;
