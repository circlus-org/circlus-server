-- No device is inferred for historical calls. Only an admitted exact route can
-- create this record. SDP outcomes and application deliveries commit together
-- with call_sessions/history through the API transaction context.
CREATE TABLE call_runtime_recovery (
  family_id uuid NOT NULL REFERENCES family_config(family_id) ON DELETE CASCADE,
  call_session_id text NOT NULL,
  initiator_identity_id text NOT NULL,
  initiator_device_id text NOT NULL,
  target_identity_id text NOT NULL,
  accepted_target_device_id text,
  journal jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, call_session_id),
  CHECK (initiator_identity_id <> target_identity_id),
  CHECK (jsonb_typeof(journal) = 'object'),
  CHECK (octet_length(journal::text) <= 16777216)
);
CREATE INDEX call_runtime_recovery_updated ON call_runtime_recovery(updated_at);
