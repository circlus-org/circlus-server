-- Preserve ordinary delivery while excluding no-call clients before dispatch.
ALTER TABLE device_notification_bindings
  ADD COLUMN calls_enabled boolean NOT NULL DEFAULT true;
