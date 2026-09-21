-- Remove pre-release compatibility storage that no longer participates in the
-- current encrypted profile, invitation, or attachment protocols.

-- Preserve any last legacy single-acceptance projection before making the
-- normalized acceptance journal the only source of truth.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'invites'
      AND column_name = 'accepted_by_identity_id'
  ) THEN
    EXECUTE $backfill$
      INSERT INTO invite_acceptances (
        invite_id,
        family_id,
        accepted_by_identity_id,
        accepted_by_public_key,
        accepted_at,
        capability_id
      )
      SELECT
        invite_id,
        family_id,
        accepted_by_identity_id,
        accepted_by_public_key,
        COALESCE(accepted_at, created_at),
        capability_id
      FROM invites
      WHERE accepted_by_identity_id IS NOT NULL
      ON CONFLICT (invite_id, accepted_by_identity_id) DO NOTHING
    $backfill$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS track_access_version ON identities;

DROP INDEX IF EXISTS idx_identities_status_updated_at;

ALTER TABLE identities
  DROP CONSTRAINT IF EXISTS identities_status_text_must_be_null,
  DROP CONSTRAINT IF EXISTS check_invite_quota_nonnegative,
  DROP CONSTRAINT IF EXISTS check_invite_used_nonnegative,
  DROP CONSTRAINT IF EXISTS check_invite_used_lte_quota,
  DROP COLUMN IF EXISTS status_text,
  DROP COLUMN IF EXISTS status_updated_at,
  DROP COLUMN IF EXISTS invite_quota,
  DROP COLUMN IF EXISTS invite_used;

CREATE TRIGGER track_access_version
  AFTER INSERT OR UPDATE OR DELETE ON identities
  FOR EACH ROW EXECUTE FUNCTION public.track_access_resource_version(
    'family_id',
    'identity_id',
    'status',
    'role',
    'can_create_invites'
  );

ALTER TABLE invites
  DROP COLUMN IF EXISTS accepted_by_identity_id,
  DROP COLUMN IF EXISTS accepted_by_public_key,
  DROP COLUMN IF EXISTS accepted_identity_name,
  DROP COLUMN IF EXISTS accepted_at,
  DROP COLUMN IF EXISTS title;

ALTER TABLE invite_acceptances
  DROP CONSTRAINT IF EXISTS invite_acceptances_identity_name_must_be_null,
  DROP COLUMN IF EXISTS accepted_identity_name;

DROP TABLE IF EXISTS circle_membership_v1_recovery_archive;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'attachment_blobs'
      AND column_name = 'plaintext_sha256'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'attachment_blobs'
      AND column_name = 'ciphertext_sha256'
  ) THEN
    ALTER TABLE attachment_blobs
      RENAME COLUMN plaintext_sha256 TO ciphertext_sha256;
  END IF;
END $$;

ALTER TABLE attachment_blobs
  ADD COLUMN IF NOT EXISTS blob_purpose TEXT NOT NULL DEFAULT 'encrypted_payload';

UPDATE attachment_blobs AS blob
   SET blob_purpose = 'public_presentation'
 WHERE EXISTS (
   SELECT 1
   FROM circle_file_access AS access
   WHERE access.family_id = blob.family_id
     AND access.blob_id = blob.blob_id
     AND access.purpose = 'direct_guest_link_presentation'
 );

ALTER TABLE attachment_blobs
  ALTER COLUMN original_file_name DROP NOT NULL;

UPDATE attachment_blobs
   SET original_file_name = NULL,
       mime_type = NULL
 WHERE blob_purpose = 'encrypted_payload';

ALTER TABLE attachment_blobs
  DROP CONSTRAINT IF EXISTS attachment_blobs_purpose_check,
  ADD CONSTRAINT attachment_blobs_purpose_check
    CHECK (blob_purpose IN ('encrypted_payload', 'public_presentation')),
  DROP CONSTRAINT IF EXISTS attachment_blobs_public_metadata_check,
  ADD CONSTRAINT attachment_blobs_public_metadata_check CHECK (
    (blob_purpose = 'encrypted_payload' AND original_file_name IS NULL AND mime_type IS NULL)
    OR
    (blob_purpose = 'public_presentation' AND original_file_name IS NOT NULL AND mime_type IS NOT NULL)
  );

COMMENT ON COLUMN attachment_blobs.ciphertext_sha256 IS
  'SHA-256 digest of the encrypted bytes stored by the server';
