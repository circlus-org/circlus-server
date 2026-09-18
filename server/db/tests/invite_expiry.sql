-- Run against a test database with psql -v ON_ERROR_STOP=1 -f this_file.
BEGIN;
CREATE SCHEMA invite_expiry_test;
SET LOCAL search_path = invite_expiry_test;
SET LOCAL TIME ZONE 'America/New_York';
CREATE TABLE invites (
  id integer PRIMARY KEY,
  expires_at timestamp NOT NULL,
  capability_descriptor jsonb,
  status text NOT NULL
);
CREATE TABLE direct_guest_links (
  id integer PRIMARY KEY,
  expires_at timestamp,
  capability_descriptor jsonb,
  status text NOT NULL
);
INSERT INTO invites VALUES
  (1, '2026-09-06 19:00', '{"payload":{"expiresAt":"2026-09-06T15:00:00.000Z"}}', 'active'),
  (2, '2026-09-06 08:00', '{"payload":{"expiresAt":"2026-09-06T19:00:00+04:00"}}', 'expired'),
  (3, '2026-09-06 11:00', NULL, 'active'),
  (4, '2026-09-06 11:00', NULL, 'revoked');
INSERT INTO direct_guest_links SELECT * FROM invites;
INSERT INTO direct_guest_links VALUES (5, NULL, NULL, 'revoked');
\ir ../migrations/000-pre-public/150_invite_expiry_timestamptz.sql
SET LOCAL TIME ZONE 'Asia/Tbilisi';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM invites WHERE expires_at <> '2026-09-06T15:00:00Z'::timestamptz
    UNION ALL
    SELECT 1 FROM direct_guest_links WHERE id <> 5 AND expires_at <> '2026-09-06T15:00:00Z'::timestamptz
  ) THEN RAISE EXCEPTION 'Signed instant or legacy database interpretation changed'; END IF;
  IF (SELECT expires_at FROM direct_guest_links WHERE id = 5) IS NOT NULL THEN
    RAISE EXCEPTION 'A legacy link without expiry acquired an expiry';
  END IF;
  IF EXISTS (
    SELECT 1 FROM invites WHERE status <> CASE id WHEN 2 THEN 'expired' WHEN 4 THEN 'revoked' ELSE 'active' END
    UNION ALL
    SELECT 1 FROM direct_guest_links WHERE status <> CASE id WHEN 2 THEN 'expired' WHEN 4 THEN 'revoked' WHEN 5 THEN 'revoked' ELSE 'active' END
  ) THEN RAISE EXCEPTION 'Migration changed a status'; END IF;
  IF (SELECT pg_typeof(expires_at)::text FROM invites LIMIT 1) <> 'timestamp with time zone'
    OR (SELECT pg_typeof(expires_at)::text FROM direct_guest_links LIMIT 1) <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'Expiry still lacks timezone';
  END IF;
END $$;
-- New writes must keep their instant even when the database timezone changes.
INSERT INTO invites VALUES (6, '2026-09-07T19:00:00+04:00', NULL, 'active');
INSERT INTO direct_guest_links VALUES (6, '2026-09-07T15:00:00Z', NULL, 'active');
SET LOCAL TIME ZONE 'UTC';
DO $$
BEGIN
  IF (SELECT expires_at FROM invites WHERE id = 6) <> '2026-09-07T15:00:00Z'::timestamptz
    OR (SELECT expires_at FROM direct_guest_links WHERE id = 6) <> '2026-09-07T15:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'New writes changed instant across timezones';
  END IF;
END $$;
ROLLBACK;
