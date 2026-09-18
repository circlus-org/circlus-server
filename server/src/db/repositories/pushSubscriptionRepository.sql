/* @name FindByPushId */
SELECT * FROM push_subscriptions
WHERE push_id = :pushId
  AND family_id = :familyId;

/* @name FindByDeviceAndEndpoint */
SELECT * FROM push_subscriptions
WHERE device_id = :deviceId AND endpoint = :endpoint
  AND family_id = :familyId;

/* @name FindByDeviceId */
SELECT * FROM push_subscriptions
WHERE device_id = :deviceId
  AND family_id = :familyId
ORDER BY created_at DESC;

/* @name FindActiveByDeviceId */
SELECT * FROM push_subscriptions
WHERE device_id = :deviceId AND status = 'active'
  AND family_id = :familyId
ORDER BY created_at DESC;

/* @name CreatePushSubscription */
INSERT INTO push_subscriptions (
  push_id,
  device_id,
  family_id,
  endpoint,
  keys_p256dh,
  keys_auth,
  delivery_method,
  relay_token,
  push_encryption_public_key
) VALUES (
  :pushId,
  :deviceId,
  :familyId,
  :endpoint,
  :keysP256dh,
  :keysAuth,
  :deliveryMethod,
  :relayToken,
  :pushEncryptionPublicKey
) RETURNING *;

/* @name UpdatePushSubscription */
UPDATE push_subscriptions
SET
  keys_p256dh = :keysP256dh,
  keys_auth = :keysAuth,
  delivery_method = :deliveryMethod,
  relay_token = :relayToken,
  push_encryption_public_key = :pushEncryptionPublicKey
WHERE push_id = :pushId
  AND family_id = :familyId;

/* @name UpdatePushStatus */
UPDATE push_subscriptions
SET status = :status
WHERE push_id = :pushId
  AND family_id = :familyId;

/* @name DeletePushSubscription */
DELETE FROM push_subscriptions
WHERE push_id = :pushId
  AND family_id = :familyId;
