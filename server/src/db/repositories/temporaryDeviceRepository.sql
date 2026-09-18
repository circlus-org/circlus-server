/* @name FindTemporaryDeviceByDeviceId */
SELECT *
FROM temporary_devices
WHERE family_id = :familyId
  AND device_id = :deviceId
LIMIT 1;

/* @name FindTemporaryDeviceByDeviceIdAnyFamily */
SELECT *
FROM temporary_devices
WHERE device_id = :deviceId
LIMIT 1;

/* @name FindTemporaryDeviceByPublicKey */
SELECT *
FROM temporary_devices
WHERE family_id = :familyId
  AND public_key_value = :publicKeyValue
LIMIT 1;

/* @name FindTemporaryDevicesByIdentityId */
SELECT *
FROM temporary_devices
WHERE family_id = :familyId
  AND identity_id = :identityId
ORDER BY created_at DESC;

/* @name CreateOrRefreshTemporaryDevice */
INSERT INTO temporary_devices (
  device_id,
  identity_id,
  family_id,
  public_key_algorithm,
  public_key_value,
  encryption_public_key_algorithm,
  encryption_public_key_value,
  approved_by_device_id,
  expires_at
) VALUES (
  :deviceId,
  :identityId,
  :familyId,
  :publicKeyAlgorithm,
  :publicKeyValue,
  :encryptionPublicKeyAlgorithm,
  :encryptionPublicKeyValue,
  :approvedByDeviceId,
  :expiresAt
)
ON CONFLICT (device_id) DO UPDATE
SET identity_id = EXCLUDED.identity_id,
    family_id = EXCLUDED.family_id,
    public_key_algorithm = EXCLUDED.public_key_algorithm,
    public_key_value = EXCLUDED.public_key_value,
    encryption_public_key_algorithm = EXCLUDED.encryption_public_key_algorithm,
    encryption_public_key_value = EXCLUDED.encryption_public_key_value,
    approved_by_device_id = EXCLUDED.approved_by_device_id,
    expires_at = EXCLUDED.expires_at,
    status = 'active'
RETURNING *;

/* @name UpdateTemporaryDeviceLastSeen */
UPDATE temporary_devices
SET last_seen_at = NOW()
WHERE family_id = :familyId
  AND device_id = :deviceId;

/* @name UpdateTemporaryDeviceStatus */
UPDATE temporary_devices
SET status = :status
WHERE family_id = :familyId
  AND device_id = :deviceId
RETURNING *;

/* @name ExpireStaleTemporaryDevices */
UPDATE temporary_devices
SET status = 'expired'
WHERE status = 'active'
  AND expires_at < NOW();
