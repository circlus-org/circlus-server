-- Isolated fixture matching the relevant old public baseline columns.
-- Run with psql -v ON_ERROR_STOP=1 -f server/db/tests/tenant_suspension_lifecycle.sql.
BEGIN;
CREATE SCHEMA tenant_suspension_test;
SET LOCAL search_path = tenant_suspension_test;
CREATE TABLE family_config (
  family_id integer PRIMARY KEY,
  status text NOT NULL CONSTRAINT family_config_status_check
    CHECK (status IN ('pending_owner', 'pending_import', 'active', 'revoked')),
  owner_identity_id text,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL
);
CREATE TABLE family_domains (
  family_id integer REFERENCES family_config(family_id),
  status text NOT NULL CONSTRAINT family_domains_status_check
    CHECK (status IN ('active', 'pending_verification', 'disabled', 'revoked')),
  disabled_at timestamptz
);
INSERT INTO family_config VALUES
  (1, 'active', 'owner-1', NULL, '2026-01-01Z'),
  (2, 'revoked', 'owner-2', '2026-02-01Z', '2026-03-01Z'),
  (3, 'revoked', NULL, '2026-02-01Z', '2026-03-01Z'),
  (4, 'pending_owner', NULL, NULL, '2026-01-01Z');
INSERT INTO family_domains VALUES
  (1, 'active', NULL), (2, 'revoked', '2026-02-01Z'),
  (3, 'revoked', '2026-02-01Z'), (4, 'pending_verification', NULL);
\ir ../migrations/019_tenant_suspension_lifecycle.sql
DO $$
BEGIN
  IF (SELECT status FROM family_config WHERE family_id = 2) <> 'suspended'
     OR (SELECT status FROM family_domains WHERE family_id = 2) <> 'suspended'
     OR (SELECT suspended_at FROM family_config WHERE family_id = 2) <> '2026-02-01Z'::timestamptz
     OR (SELECT disabled_at FROM family_domains WHERE family_id = 2) <> '2026-02-01Z'::timestamptz THEN
    RAISE EXCEPTION 'Owned revoked Circle was not migrated with original timestamps';
  END IF;
  IF (SELECT status FROM family_config WHERE family_id = 3) <> 'revoked'
     OR (SELECT status FROM family_domains WHERE family_id = 3) <> 'revoked'
     OR (SELECT status FROM family_config WHERE family_id = 1) <> 'active'
     OR (SELECT status FROM family_config WHERE family_id = 4) <> 'pending_owner' THEN
    RAISE EXCEPTION 'Unrelated lifecycle state changed';
  END IF;
  -- Exercise the expression that caused the deployed failure.
  PERFORM COALESCE(fc.suspended_at, fc.updated_at)
    FROM family_config fc JOIN family_domains fd USING (family_id)
    WHERE fc.status = 'suspended' AND fd.status = 'suspended';
END $$;
CREATE TEMP TABLE migrated_config AS SELECT * FROM family_config;
CREATE TEMP TABLE migrated_domains AS SELECT * FROM family_domains;
\ir ../migrations/019_tenant_suspension_lifecycle.sql
DO $$
BEGIN
  IF EXISTS (SELECT * FROM family_config EXCEPT SELECT * FROM migrated_config)
     OR EXISTS (SELECT * FROM migrated_config EXCEPT SELECT * FROM family_config)
     OR EXISTS (SELECT * FROM family_domains EXCEPT SELECT * FROM migrated_domains)
     OR EXISTS (SELECT * FROM migrated_domains EXCEPT SELECT * FROM family_domains) THEN
    RAISE EXCEPTION 'Repeat application changed lifecycle data';
  END IF;
END $$;
ROLLBACK;
