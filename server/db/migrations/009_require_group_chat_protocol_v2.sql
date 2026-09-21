-- All supported group mutations use owner-signed protocol v2 state
-- transitions. Preserve pre-release v1 rows as inert history, while preventing
-- any new v1 group from being inserted.

ALTER TABLE group_chats
  ALTER COLUMN protocol_version SET DEFAULT 2;

ALTER TABLE group_chats
  DROP CONSTRAINT IF EXISTS group_chats_protocol_v2_only,
  ADD CONSTRAINT group_chats_protocol_v2_only
    CHECK (protocol_version = 2) NOT VALID;
