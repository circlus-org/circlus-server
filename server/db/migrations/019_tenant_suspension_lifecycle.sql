-- Public forward migration: the published initial schema predates Circle
-- suspension. Preserve that baseline and its checksum; upgrade existing public
-- installations here. Also safe after the equivalent private migration 125.
ALTER TABLE family_config
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ NULL;

ALTER TABLE family_config
  DROP CONSTRAINT IF EXISTS family_config_status_check;

ALTER TABLE family_config
  ADD CONSTRAINT family_config_status_check
  CHECK (status IN ('pending_owner', 'pending_import', 'active', 'suspended', 'revoked'));

ALTER TABLE family_domains
  DROP CONSTRAINT IF EXISTS family_domains_status_check;

ALTER TABLE family_domains
  ADD CONSTRAINT family_domains_status_check
  CHECK (status IN ('active', 'pending_verification', 'suspended', 'disabled', 'revoked'));

-- Active Circles revoked by the pre-suspension workflow retained their owner
-- and data. Treat them as suspended so they can be resumed safely.
UPDATE family_config
SET status = 'suspended',
    suspended_at = COALESCE(revoked_at, updated_at, NOW())
WHERE status = 'revoked'
  AND owner_identity_id IS NOT NULL;

UPDATE family_domains fd
SET status = 'suspended',
    disabled_at = COALESCE(fd.disabled_at, NOW())
FROM family_config fc
WHERE fd.family_id = fc.family_id
  AND fc.status = 'suspended'
  AND fd.status = 'revoked';

CREATE INDEX IF NOT EXISTS idx_family_config_status_suspended_at
  ON family_config(status, suspended_at);
