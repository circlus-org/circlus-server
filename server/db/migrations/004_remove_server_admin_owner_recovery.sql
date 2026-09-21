-- A server administrator must not replace a Circle owner without a membership
-- transition signed by the current owner. Retain ownership-change history, but
-- prevent new non-voluntary records and remove the obsolete recovery claims.

DROP TABLE IF EXISTS circle_owner_recovery_claims;

ALTER TABLE circle_owner_changes
  DROP CONSTRAINT IF EXISTS circle_owner_changes_method_check;

ALTER TABLE circle_owner_changes
  ADD CONSTRAINT circle_owner_changes_method_check
  CHECK (method = 'voluntary_transfer') NOT VALID;
