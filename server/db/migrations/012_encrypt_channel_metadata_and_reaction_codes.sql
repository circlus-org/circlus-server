-- Channel names and descriptions are application content. Keep only an
-- owner-signed ciphertext on the Circle server. Public-site presentation stays
-- in the explicitly public public_site_* columns and circle_site_publications.
ALTER TABLE announcement_channels
  ADD COLUMN IF NOT EXISTS metadata_epoch INTEGER NULL,
  ADD COLUMN IF NOT EXISTS metadata_ciphertext TEXT NULL,
  ADD COLUMN IF NOT EXISTS metadata_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metadata_author_device_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS metadata_author_claim JSONB NULL;

ALTER TABLE announcement_channels
  DROP CONSTRAINT IF EXISTS fk_announcement_channels_metadata_author_device;

ALTER TABLE announcement_channels
  ADD CONSTRAINT fk_announcement_channels_metadata_author_device
    FOREIGN KEY (metadata_author_device_id) REFERENCES devices(device_id) ON DELETE RESTRICT;

ALTER TABLE announcement_channels
  ALTER COLUMN title DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS check_announcement_channels_title,
  DROP CONSTRAINT IF EXISTS check_announcement_channels_description,
  DROP CONSTRAINT IF EXISTS check_announcement_channels_public_plaintext,
  DROP COLUMN IF EXISTS visibility,
  DROP COLUMN IF EXISTS content_mode,
  DROP COLUMN IF EXISTS members_can_subscribe,
  DROP COLUMN IF EXISTS owner_guests_can_subscribe,
  DROP COLUMN IF EXISTS other_guests_can_subscribe;

UPDATE announcement_channels
SET title = NULL,
    description = NULL;

ALTER TABLE announcement_channels
  ADD CONSTRAINT announcement_channels_no_plaintext_metadata
    CHECK (title IS NULL AND description IS NULL),
  ADD CONSTRAINT announcement_channels_metadata_complete
    CHECK (
      (metadata_revision = 0 AND metadata_epoch IS NULL AND metadata_ciphertext IS NULL
        AND metadata_author_device_id IS NULL AND metadata_author_claim IS NULL)
      OR
      (metadata_revision > 0 AND metadata_epoch > 0 AND metadata_ciphertext IS NOT NULL
        AND metadata_author_device_id IS NOT NULL AND metadata_author_claim IS NOT NULL)
    );

-- Previous channel reactions contained plaintext emoji. They cannot be
-- converted without a channel key, so discard them before changing the wire
-- representation to opaque, channel-specific deterministic codes.
TRUNCATE announcement_channel_reactions;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'announcement_channel_reactions'
      AND column_name = 'emojis'
  ) THEN
    ALTER TABLE announcement_channel_reactions RENAME COLUMN emojis TO reaction_codes;
  END IF;
END $$;
