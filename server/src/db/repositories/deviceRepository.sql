/* @name FindByDeviceId */
SELECT * FROM devices
WHERE device_id = :deviceId
  AND family_id = :familyId;

/* @name FindByPublicKey */
SELECT * FROM devices
WHERE public_key_value = :publicKeyValue
  AND family_id = :familyId;

/* @name FindByIdentityId */
SELECT * FROM devices
WHERE identity_id = :identityId
  AND family_id = :familyId
ORDER BY created_at DESC;

/* @name FindActiveByIdentityId */
SELECT * FROM devices
WHERE identity_id = :identityId AND status = 'active'
  AND family_id = :familyId
ORDER BY created_at DESC;

/* @name CreateDevice */
INSERT INTO devices (
  device_id,
  identity_id,
  family_id,
  public_key_algorithm,
  public_key_value,
  encryption_public_key_algorithm,
  encryption_public_key_value,
  registration_attestation,
  label,
  web_origin,
  encrypted_physical_device_id
) VALUES (
  :deviceId,
  :identityId,
  :familyId,
  :publicKeyAlgorithm,
  :publicKeyValue,
  :encryptionPublicKeyAlgorithm,
  :encryptionPublicKeyValue,
  :registrationAttestation,
  :label,
  :webOrigin,
  :encryptedPhysicalDeviceId
) RETURNING *;

/* @name UpdateStatus */
UPDATE devices
SET status = :status
WHERE device_id = :deviceId
  AND family_id = :familyId
RETURNING *;

/* @name UpdateLastSeen */
UPDATE devices
SET last_seen_at = NOW(),
    web_origin = COALESCE(:webOrigin, web_origin)
WHERE device_id = :deviceId
  AND family_id = :familyId;

/* @name CountByIdentityId */
SELECT COUNT(*) as count FROM devices
WHERE identity_id = :identityId
  AND family_id = :familyId;

/* @name CountDevices */
SELECT COUNT(*) as count FROM devices
WHERE family_id = :familyId;

/* @name CountActiveSince */
SELECT COUNT(*) as count FROM devices
WHERE status = 'active' AND last_seen_at >= :since
  AND family_id = :familyId;
