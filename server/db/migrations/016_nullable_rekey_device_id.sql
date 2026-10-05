-- Identity-level self-removal may require a rekey after every device has gone.
-- Keep that case explicit instead of storing a synthetic device ID.
ALTER TABLE trusted_device_rekey_jobs
  ALTER COLUMN device_id DROP NOT NULL;
