-- The client build last reported by each device (CLIENT_SERVER_COMPATIBILITY.md):
-- operators see which app versions are in use before support for an older
-- signed protocol version ends.
ALTER TABLE devices
  ADD COLUMN client_version text
  CHECK (client_version IS NULL OR char_length(client_version) <= 80);
