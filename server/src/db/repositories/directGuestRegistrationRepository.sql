/* @name CreateDirectGuestRegistration */
INSERT INTO direct_guest_registrations (
  registration_id,
  family_id,
  link_id,
  host_identity_id,
  guest_identity_id,
  can_message,
  can_call,
  can_direct_file_transfer,
  can_server_attachments,
  host_can_message_guest,
  guest_can_message_host,
  host_can_call_guest,
  guest_can_call_host,
  host_can_direct_file_transfer_guest,
  guest_can_direct_file_transfer_host,
  host_can_server_attachments_guest,
  guest_can_server_attachments_host
) VALUES (
  :registrationId,
  :familyId,
  :linkId,
  :hostIdentityId,
  :guestIdentityId,
  :canMessage,
  :canCall,
  :canDirectFileTransfer,
  :canServerAttachments,
  :hostCanMessageGuest,
  :guestCanMessageHost,
  :hostCanCallGuest,
  :guestCanCallHost,
  :hostCanDirectFileTransferGuest,
  :guestCanDirectFileTransferHost,
  :hostCanServerAttachmentsGuest,
  :guestCanServerAttachmentsHost
) RETURNING *;

/* @name ListDirectGuestRegistrationsByLink */
SELECT r.*,
       i.identity_name AS guest_identity_name,
       i.public_key_algorithm AS guest_public_key_algorithm,
       i.public_key_value AS guest_public_key_value,
       i.can_create_guest_invites AS guest_can_create_guest_invites
FROM direct_guest_registrations r
LEFT JOIN identities i
  ON i.family_id = r.family_id AND i.identity_id = r.guest_identity_id
WHERE r.family_id = :familyId
  AND r.link_id = :linkId
  AND r.host_identity_id = :hostIdentityId
ORDER BY r.created_at DESC;

/* @name FindActiveDirectGuestRegistrationByPair */
SELECT *
FROM direct_guest_registrations
WHERE family_id = :familyId
  AND status = 'active'
  AND (
    (host_identity_id = :identityA AND guest_identity_id = :identityB)
    OR
    (host_identity_id = :identityB AND guest_identity_id = :identityA)
  )
ORDER BY created_at DESC
LIMIT 1;

/* @name FindActiveDirectGuestRegistrationByHost */
SELECT *
FROM direct_guest_registrations
WHERE family_id = :familyId
  AND registration_id = :registrationId
  AND host_identity_id = :hostIdentityId
  AND status = 'active'
LIMIT 1;

/* @name RevokeDirectGuestRegistrationByHost */
UPDATE direct_guest_registrations
SET status = 'deleted_by_host',
    revoked_at = NOW(),
    updated_at = NOW()
WHERE family_id = :familyId
  AND registration_id = :registrationId
  AND host_identity_id = :hostIdentityId
  AND status = 'active'
RETURNING *;

/* @name UpdateDirectGuestRegistrationPermissionsByHost */
UPDATE direct_guest_registrations
SET can_message = :canMessage,
    can_call = :canCall,
    can_direct_file_transfer = :canDirectFileTransfer,
    can_server_attachments = :canServerAttachments,
    host_can_message_guest = :hostCanMessageGuest,
    guest_can_message_host = :guestCanMessageHost,
    host_can_call_guest = :hostCanCallGuest,
    guest_can_call_host = :guestCanCallHost,
    host_can_direct_file_transfer_guest = :hostCanDirectFileTransferGuest,
    guest_can_direct_file_transfer_host = :guestCanDirectFileTransferHost,
    host_can_server_attachments_guest = :hostCanServerAttachmentsGuest,
    guest_can_server_attachments_host = :guestCanServerAttachmentsHost,
    updated_at = NOW()
WHERE family_id = :familyId
  AND registration_id = :registrationId
  AND host_identity_id = :hostIdentityId
  AND status = 'active'
RETURNING *;

/* @name SelfDeleteDirectGuestRegistration */
UPDATE direct_guest_registrations
SET status = 'deleted_by_guest',
    revoked_at = NOW(),
    updated_at = NOW()
WHERE family_id = :familyId
  AND guest_identity_id = :guestIdentityId
  AND status = 'active'
RETURNING *;

/* @name TouchDirectGuestRegistrationLastSeen */
UPDATE direct_guest_registrations
SET last_seen_at = NOW(),
    updated_at = NOW()
WHERE family_id = :familyId
  AND guest_identity_id = :guestIdentityId
  AND status = 'active';

/* @name RevokeAllDirectGuestRegistrationsByLink */
UPDATE direct_guest_registrations
SET status = 'revoked',
    revoked_at = NOW(),
    updated_at = NOW()
WHERE family_id = :familyId
  AND link_id = :linkId
  AND status = 'active';
