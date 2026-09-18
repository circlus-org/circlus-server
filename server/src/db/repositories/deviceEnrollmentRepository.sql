/* @name CreateDeviceEnrollment */
INSERT INTO device_enrollments (
  family_id,
  enrollment_id,
  new_device_ciphertext,
  new_device_cipher,
  origin,
  origin_verified,
  request_ip,
  request_user_agent,
  state,
  expires_at,
  enrollment_expires_at,
  requested_trusted_device_id,
  requested_identity_id
) VALUES (
  :familyId,
  :enrollmentId,
  :newDeviceCiphertext,
  :newDeviceCipher,
  :origin,
  :originVerified,
  :requestIp,
  :requestUserAgent,
  CASE
    WHEN :originVerified THEN 'pending_trusted_read'
    ELSE 'pending_origin_check'
  END,
  :expiresAt,
  :expiresAt,
  :requestedTrustedDeviceId,
  :requestedIdentityId
) RETURNING *;

/* @name FindDeviceEnrollmentByEnrollmentId */
SELECT *
FROM device_enrollments
WHERE family_id = :familyId
  AND enrollment_id = :enrollmentId
LIMIT 1;

/* @name MarkDeviceEnrollmentTrustedRead */
UPDATE device_enrollments
SET state = 'pending_trusted_approval',
    trusted_read_at = COALESCE(trusted_read_at, NOW())
WHERE family_id = :familyId
  AND enrollment_id = :enrollmentId
  AND state IN ('pending_trusted_read', 'pending_trusted_approval')
RETURNING *;

/* @name MarkDeviceEnrollmentApproved */
UPDATE device_enrollments
SET state = 'approved',
    approved_by_device_id = :approvedByDeviceId,
    new_device_id = :temporaryDeviceId,
    new_device_public_key_algorithm = :temporaryDevicePublicKeyAlgorithm,
    new_device_public_key_value = :temporaryDevicePublicKeyValue,
    new_device_encryption_public_key_algorithm = :temporaryDeviceEncryptionPublicKeyAlgorithm,
    new_device_encryption_public_key_value = :temporaryDeviceEncryptionPublicKeyValue,
    encrypted_temporary_membership = :encryptedTemporaryMembership,
    cipher = :cipher,
    approved_at = NOW(),
    access_mode = :accessMode,
    payload_expires_at = :payloadExpiresAt,
    temporary_access_expires_at = CASE
      WHEN :accessMode = 'temporary' THEN CAST(:expiresAt AS timestamptz)
      ELSE NULL::timestamptz
    END
WHERE family_id = :familyId
  AND enrollment_id = :enrollmentId
  AND state = 'pending_trusted_approval'
RETURNING *;

/* @name MarkDeviceEnrollmentRejected */
UPDATE device_enrollments
SET state = 'rejected'
WHERE family_id = :familyId
  AND enrollment_id = :enrollmentId
  AND state IN ('reserved', 'pending_trusted_read', 'pending_trusted_approval')
RETURNING *;

/* @name MarkDeviceEnrollmentConsumed */
UPDATE device_enrollments
SET state = 'consumed',
    consumed_at = NOW()
WHERE family_id = :familyId
  AND enrollment_id = :enrollmentId
  AND state = 'approved'
RETURNING *;

/* @name MarkDeviceEnrollmentActivated */
UPDATE device_enrollments
SET state = 'activated',
    activated_at = COALESCE(activated_at, NOW())
WHERE family_id = :familyId
  AND enrollment_id = :enrollmentId
  AND state = 'consumed'
RETURNING *;

/* @name ExpireStaleDeviceEnrollments */
UPDATE device_enrollments
SET state = 'expired'
WHERE state IN ('reserved', 'pending_origin_check', 'pending_trusted_read', 'pending_trusted_approval')
  AND COALESCE(enrollment_expires_at, expires_at) < NOW();
