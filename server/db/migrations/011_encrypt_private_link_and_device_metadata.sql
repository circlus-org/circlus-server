-- Device names are user content. They now live in the end-to-end encrypted
-- profile vault and are no longer sent to or stored by a Circle server.
ALTER TABLE devices
  DROP COLUMN IF EXISTS label,
  DROP COLUMN IF EXISTS label_update_id;

-- This unused field predates the current opaque enrollment payload.
ALTER TABLE device_enrollments
  DROP COLUMN IF EXISTS requested_contact;

-- Link management labels live in the owner's encrypted vault. Non-public
-- presentation text is encrypted by the client in the signed capability
-- descriptor. Keep nullable legacy columns temporarily so rolling deployments
-- fail closed instead of exposing new plaintext.
UPDATE direct_guest_links
SET title = NULL,
    presentation_title = NULL,
    presentation_description = NULL;

ALTER TABLE direct_guest_links
  ADD CONSTRAINT direct_guest_links_no_plaintext_private_metadata
  CHECK (title IS NULL AND presentation_title IS NULL AND presentation_description IS NULL);

UPDATE direct_guest_link_defaults
SET presentation_title = NULL,
    presentation_description = NULL;

ALTER TABLE direct_guest_link_defaults
  ADD CONSTRAINT direct_guest_link_defaults_no_plaintext_text
  CHECK (presentation_title IS NULL AND presentation_description IS NULL);

UPDATE call_links SET title = NULL;

ALTER TABLE call_links
  ADD CONSTRAINT call_links_no_plaintext_title CHECK (title IS NULL);

UPDATE call_logs SET call_link_title = NULL;

ALTER TABLE call_logs
  ADD CONSTRAINT call_logs_no_plaintext_call_link_title CHECK (call_link_title IS NULL);
