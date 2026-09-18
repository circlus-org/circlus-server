/* @name InsertSystemEvent */
INSERT INTO system_events (
  event_id,
  family_id,
  recipient_identity_id,
  circle_id,
  type,
  payload,
  created_at
) VALUES (
  :eventId,
  :familyId,
  :recipientIdentityId,
  :circleId,
  :type,
  :payload::jsonb,
  :createdAt
)
ON CONFLICT (event_id) DO NOTHING;

/* @name FetchSystemEventsForSync */
SELECT event_id, recipient_identity_id, circle_id, type, payload, created_at
FROM system_events
WHERE family_id = :familyId
  AND recipient_identity_id = :recipientIdentityId
  AND created_at > :since
ORDER BY created_at ASC
LIMIT :limit;

/* @name FindSystemDeviceSyncState */
SELECT last_system_sync_at
FROM system_device_sync
WHERE family_id = :familyId
  AND device_id = :deviceId;

/* @name EnsureSystemDeviceSyncState */
INSERT INTO system_device_sync (family_id, device_id, last_system_sync_at)
VALUES (:familyId, :deviceId, 0)
ON CONFLICT DO NOTHING;

/* @name UpsertSystemDeviceSyncState */
INSERT INTO system_device_sync (family_id, device_id, last_system_sync_at)
VALUES (:familyId, :deviceId, :lastSystemSyncAt)
ON CONFLICT (family_id, device_id)
DO UPDATE SET
  last_system_sync_at = GREATEST(system_device_sync.last_system_sync_at, EXCLUDED.last_system_sync_at);

/* @name CleanupExpiredSystemEvents */
DELETE FROM system_events
WHERE created_at < :cutoff;
