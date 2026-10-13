BEGIN;
CREATE TEMP TABLE device_notification_bindings (family_id text, web_device_id text, PRIMARY KEY (family_id, web_device_id));
INSERT INTO device_notification_bindings VALUES ('circle-a','device-a'), ('circle-b','device-b');
\ir ../migrations/020_mobile_route_calls_policy.sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM device_notification_bindings WHERE NOT calls_enabled) THEN RAISE EXCEPTION 'existing policy changed'; END IF;
END $$;
UPDATE device_notification_bindings SET calls_enabled = false WHERE family_id='circle-a' AND web_device_id='device-a';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM device_notification_bindings WHERE family_id='circle-a' AND NOT calls_enabled) THEN RAISE EXCEPTION 'policy not persisted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM device_notification_bindings WHERE family_id='circle-b' AND calls_enabled) THEN RAISE EXCEPTION 'other Circle policy changed'; END IF;
END $$;
ROLLBACK;
