-- The newest signed protocol versions each device's app supports, and when the device
-- last reported its build. Inspector lists devices
-- that would stop working when the server stops accepting an older protocol version.
-- Native background requests do not report, so the last report stays until the next one.
ALTER TABLE devices
  ADD COLUMN client_protocols jsonb
    CHECK (client_protocols IS NULL OR jsonb_typeof(client_protocols) = 'object'),
  ADD COLUMN client_version_reported_at timestamptz;
