-- Shared Circle names and participant status text are end-to-end encrypted
-- with the current Circle profile epoch key. The server retains only opaque
-- ciphertext plus routing and monotonic revision metadata.

CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_family_identity_unique
  ON identities(family_id, identity_id);

CREATE TABLE IF NOT EXISTS circle_encrypted_shared_metadata (
  family_id UUID PRIMARY KEY REFERENCES family_config(family_id) ON DELETE CASCADE,
  owner_identity_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  revision BIGINT NOT NULL CHECK (revision > 0),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) <= 16384),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (family_id, owner_identity_id)
    REFERENCES identities(family_id, identity_id) ON DELETE CASCADE,
  FOREIGN KEY (family_id, epoch)
    REFERENCES circle_profile_epochs(family_id, epoch) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS circle_encrypted_identity_statuses (
  family_id UUID NOT NULL,
  owner_identity_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  revision BIGINT NOT NULL CHECK (revision > 0),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) <= 16384),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (family_id, owner_identity_id),
  FOREIGN KEY (family_id, owner_identity_id)
    REFERENCES identities(family_id, identity_id) ON DELETE CASCADE,
  FOREIGN KEY (family_id, epoch)
    REFERENCES circle_profile_epochs(family_id, epoch) ON DELETE RESTRICT
);

-- Remove the two legacy plaintext values. A domain is sufficient as the
-- server operator's technical label and does not reveal the users' name.
UPDATE identities SET status_text = NULL WHERE status_text IS NOT NULL;

UPDATE family_config AS fc
   SET server_name = COALESCE(
     (SELECT fd.host
       FROM family_domains AS fd
       WHERE fd.family_id = fc.family_id
       ORDER BY fd.is_current DESC, (fd.role = 'primary') DESC, fd.created_at ASC
       LIMIT 1),
     fc.family_id::text
   );

ALTER TABLE identities
  DROP CONSTRAINT IF EXISTS identities_status_text_must_be_null,
  ADD CONSTRAINT identities_status_text_must_be_null
    CHECK (status_text IS NULL);
