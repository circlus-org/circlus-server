/* @name FindTemporaryAccessRequestByRequestId */
SELECT *
FROM temporary_access_requests
WHERE family_id = :familyId
  AND request_id = :requestId
  AND request_type = :requestType
LIMIT 1;

/* @name CreateTemporaryAccessRequest */
INSERT INTO temporary_access_requests (
  request_id,
  request_type,
  family_id,
  identity_id,
  enrollment_id,
  temporary_device_id,
  temporary_device_public_key_algorithm,
  temporary_device_public_key_value,
  expires_at
) VALUES (
  :requestId,
  :requestType,
  :familyId,
  :identityId,
  :enrollmentId,
  :temporaryDeviceId,
  :temporaryDevicePublicKeyAlgorithm,
  :temporaryDevicePublicKeyValue,
  :expiresAt
) RETURNING *;

/* @name ListPendingTemporaryAccessRequestsByIdentity */
SELECT *
FROM temporary_access_requests
WHERE family_id = :familyId
  AND identity_id = :identityId
  AND request_type = :requestType
  AND status = 'pending'
  AND expires_at > NOW()
ORDER BY created_at ASC;

/* @name ListActiveTemporaryAccessRequestsByTemporaryDevice */
SELECT *
FROM temporary_access_requests
WHERE family_id = :familyId
  AND temporary_device_id = :temporaryDeviceId
  AND request_type = :requestType
  AND status IN ('pending', 'approved')
  AND expires_at > NOW()
ORDER BY created_at DESC;

/* @name ApproveTemporaryAccessRequest */
UPDATE temporary_access_requests
SET status = 'approved',
    approved_by_device_id = :approvedByDeviceId,
    encrypted_payload = :encryptedPayload,
    cipher = :cipher,
    approved_at = NOW()
WHERE family_id = :familyId
  AND request_id = :requestId
  AND request_type = :requestType
  AND status = 'pending'
RETURNING *;

/* @name RejectTemporaryAccessRequest */
UPDATE temporary_access_requests
SET status = 'rejected'
WHERE family_id = :familyId
  AND request_id = :requestId
  AND request_type = :requestType
  AND status = 'pending'
RETURNING *;

/* @name ConsumeTemporaryAccessRequest */
UPDATE temporary_access_requests
SET status = 'consumed',
    consumed_at = NOW()
WHERE family_id = :familyId
  AND request_id = :requestId
  AND request_type = :requestType
  AND status = 'approved'
RETURNING *;

/* @name ExpireTemporaryAccessRequestsByType */
UPDATE temporary_access_requests
SET status = 'expired'
WHERE request_type = :requestType
  AND status IN ('pending', 'approved')
  AND expires_at < NOW();

/* @name ExpireAllTemporaryAccessRequests */
UPDATE temporary_access_requests
SET status = 'expired'
WHERE status IN ('pending', 'approved')
  AND expires_at < NOW();
