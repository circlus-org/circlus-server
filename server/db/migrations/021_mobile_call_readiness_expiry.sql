-- Call authority may expire before the ordinary message-delivery credential.
-- NULL preserves the explicit legacy registration format (e.g. Android).
ALTER TABLE device_notification_bindings
  ADD COLUMN call_readiness_expires_at timestamptz;
