-- Participant display names are carried only by encrypted Circle profile cards.
-- Keep the legacy columns temporarily for schema/API compatibility, but make
-- accidental plaintext persistence impossible.

UPDATE identities
   SET identity_name = NULL,
       publish_identity = FALSE
 WHERE identity_name IS NOT NULL
    OR publish_identity = TRUE;

UPDATE invites
   SET accepted_identity_name = NULL
 WHERE accepted_identity_name IS NOT NULL;

UPDATE invite_acceptances
   SET accepted_identity_name = NULL
 WHERE accepted_identity_name IS NOT NULL;

-- This compatibility flag used to make plaintext participant names optional.
-- Names are now always client encrypted, so every Circle must advertise the
-- only supported policy to clients restored from older local state.
UPDATE family_config
   SET no_names_on_server = TRUE
 WHERE no_names_on_server = FALSE;

ALTER TABLE identities
  DROP CONSTRAINT IF EXISTS identities_identity_name_must_be_null,
  DROP CONSTRAINT IF EXISTS identities_publish_identity_must_be_false,
  ADD CONSTRAINT identities_identity_name_must_be_null
    CHECK (identity_name IS NULL),
  ADD CONSTRAINT identities_publish_identity_must_be_false
    CHECK (publish_identity = FALSE);

ALTER TABLE invites
  DROP CONSTRAINT IF EXISTS invites_accepted_identity_name_must_be_null,
  ADD CONSTRAINT invites_accepted_identity_name_must_be_null
    CHECK (accepted_identity_name IS NULL);

ALTER TABLE invite_acceptances
  DROP CONSTRAINT IF EXISTS invite_acceptances_identity_name_must_be_null,
  ADD CONSTRAINT invite_acceptances_identity_name_must_be_null
    CHECK (accepted_identity_name IS NULL);
