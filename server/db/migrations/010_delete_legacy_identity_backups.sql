-- Backup protocol v2 rotates every lookup secret and no longer accepts v1 uploads.
-- Existing encrypted blobs cannot be addressed by the new recovery packages.
DELETE FROM identity_backups;
