-- Keep the conflicting call ID separate from the stable busy reason code.
-- No foreign key: a local active call can belong to another server.
ALTER TABLE call_handling_events
  ADD COLUMN IF NOT EXISTS blocking_call_session_id TEXT NULL;
