-- Run with psql -v ON_ERROR_STOP=1 -f server/db/tests/call_link_expiry.sql.
-- The fixture and migration are rolled back; no application tables are used.
BEGIN;
CREATE SCHEMA call_link_expiry_test;
SET LOCAL search_path = call_link_expiry_test;
SET LOCAL TIME ZONE 'America/New_York';
CREATE TABLE call_links (
  id integer PRIMARY KEY,
  expires_at timestamp NOT NULL,
  capability_descriptor jsonb,
  status text NOT NULL
);
INSERT INTO call_links VALUES
  (1, '2026-09-06 19:00', '{"payload":{"expiresAt":"2026-09-06T15:00:00.000Z"}}', 'active'),
  (2, '2026-09-06 11:00', '{"payload":{"expiresAt":"2026-09-06T19:00:00+04:00"}}', 'expired'),
  (3, '2026-09-06 15:00', NULL, 'revoked');
\ir ../migrations/000-pre-public/149_call_link_expiry_timestamptz.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM call_links WHERE expires_at <> '2026-09-06T15:00:00Z'::timestamptz) THEN
    RAISE EXCEPTION 'Migration changed the signed instant';
  END IF;
  IF (SELECT status FROM call_links WHERE id = 2) <> 'expired'
     OR (SELECT status FROM call_links WHERE id = 3) <> 'revoked' THEN
    RAISE EXCEPTION 'Migration reactivated a link';
  END IF;
END $$;
SET LOCAL TIME ZONE 'Asia/Tbilisi';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM call_links WHERE expires_at <> '2026-09-06T15:00:00Z'::timestamptz) THEN
    RAISE EXCEPTION 'Changing timezone changed the expiry instant';
  END IF;
  IF (SELECT pg_typeof(expires_at)::text FROM call_links LIMIT 1) <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'Expiry still lacks timezone';
  END IF;
END $$;
ROLLBACK;
