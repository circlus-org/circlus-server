/* @name CreateDirectGuestLink */
INSERT INTO direct_guest_links (
  link_id,
  family_id,
  host_identity_id,
  created_by_identity_id,
  secret_hash,
  encrypted_secret,
  can_message,
  can_call,
  can_direct_file_transfer,
  can_server_attachments,
  title,
  presentation_title,
  presentation_description,
  presentation_image_url,
  max_uses,
  host_can_message_guest,
  guest_can_message_host,
  host_can_call_guest,
  guest_can_call_host,
  host_can_direct_file_transfer_guest,
  guest_can_direct_file_transfer_host,
  host_can_server_attachments_guest,
  guest_can_server_attachments_host,
  auto_subscribe_to_channel,
  public_site_visible,
  public_site_channel_slug,
  public_site_cta_label,
  public_site_intro_title,
  public_site_intro_text,
  public_site_intro_image_url,
  public_site_guest_link_url
) VALUES (
  :linkId,
  :familyId,
  :hostIdentityId,
  :createdByIdentityId,
  :secretHash,
  :encryptedSecret,
  :canMessage,
  :canCall,
  :canDirectFileTransfer,
  :canServerAttachments,
  :title,
  :presentationTitle,
  :presentationDescription,
  :presentationImageUrl,
  :maxUses,
  :hostCanMessageGuest,
  :guestCanMessageHost,
  :hostCanCallGuest,
  :guestCanCallHost,
  :hostCanDirectFileTransferGuest,
  :guestCanDirectFileTransferHost,
  :hostCanServerAttachmentsGuest,
  :guestCanServerAttachmentsHost,
  :autoSubscribeToChannel,
  :publicSiteVisible,
  :publicSiteChannelSlug,
  :publicSiteCtaLabel,
  :publicSiteIntroTitle,
  :publicSiteIntroText,
  :publicSiteIntroImageUrl,
  :publicSiteGuestLinkUrl
) RETURNING *;

/* @name FindDirectGuestLinkById */
SELECT *
FROM direct_guest_links
WHERE family_id = :familyId
  AND link_id = :linkId
LIMIT 1;

/* @name ListDirectGuestLinksByHostIdentity */
SELECT l.*,
       COUNT(r.registration_id)::text AS registration_count,
       COUNT(*) FILTER (WHERE r.status = 'active')::text AS active_registration_count
FROM direct_guest_links l
LEFT JOIN direct_guest_registrations r
  ON r.family_id = l.family_id AND r.link_id = l.link_id
WHERE l.family_id = :familyId
  AND l.host_identity_id = :hostIdentityId
GROUP BY l.link_id
ORDER BY l.created_at DESC;

/* @name RevokeDirectGuestLink */
UPDATE direct_guest_links
SET status = 'revoked',
    revoked_at = NOW(),
    updated_at = NOW()
WHERE family_id = :familyId
  AND link_id = :linkId
  AND host_identity_id = :hostIdentityId
  AND status = 'active'
RETURNING *;

/* @name GetDirectGuestLinkDefaults */
SELECT presentation_title, presentation_description, presentation_image_url
FROM direct_guest_link_defaults
WHERE family_id = :familyId
  AND host_identity_id = :hostIdentityId
LIMIT 1;

/* @name UpsertDirectGuestLinkDefaults */
INSERT INTO direct_guest_link_defaults (
  family_id,
  host_identity_id,
  presentation_title,
  presentation_description,
  presentation_image_url
) VALUES (
  :familyId,
  :hostIdentityId,
  :presentationTitle,
  :presentationDescription,
  :presentationImageUrl
)
ON CONFLICT (family_id, host_identity_id) DO UPDATE
SET presentation_title = EXCLUDED.presentation_title,
    presentation_description = EXCLUDED.presentation_description,
    presentation_image_url = EXCLUDED.presentation_image_url,
    updated_at = NOW()
RETURNING presentation_title, presentation_description, presentation_image_url;

/* @name RevokeExhaustedDirectGuestLink */
UPDATE direct_guest_links
SET status = 'revoked',
    revoked_at = NOW(),
    updated_at = NOW()
WHERE family_id = :familyId
  AND link_id = :linkId
  AND status = 'active'
  AND max_uses IS NOT NULL
  AND (
    SELECT COUNT(*)
    FROM direct_guest_registrations
    WHERE family_id = :familyId
      AND link_id = :linkId
  ) >= max_uses;
