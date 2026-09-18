/* @name FindByIdentityId */
SELECT * FROM identities
WHERE identity_id = :identityId
  AND family_id = :familyId;

/* @name FindByPublicKey */
SELECT * FROM identities
WHERE public_key_value = :publicKeyValue
  AND family_id = :familyId;

/* @name CreateIdentity */
INSERT INTO identities (
  identity_id,
  family_id,
  public_key_algorithm,
  public_key_value,
  encrypted_private_key,
  role,
  publish_identity,
  identity_name
) VALUES (
  :identityId,
  :familyId,
  :publicKeyAlgorithm,
  :publicKeyValue,
  :encryptedPrivateKey::jsonb,
  :role,
  :publishIdentity,
  :identityName
) RETURNING *;

/* @name FindPublishedIdentities */
SELECT identity_id, public_key_algorithm, public_key_value, identity_name
FROM identities
WHERE family_id = :familyId
  AND publish_identity = true
  AND status = 'active'
  AND COALESCE(role, '') <> 'guest';

/* @name UpdateStatus */
UPDATE identities
SET status = :status
WHERE identity_id = :identityId
  AND family_id = :familyId
RETURNING *;

/* @name UpdateRole */
UPDATE identities
SET role = :role
WHERE identity_id = :identityId
  AND family_id = :familyId
RETURNING *;

/* @name CountIdentities */
SELECT COUNT(*) as count FROM identities
WHERE family_id = :familyId;

/* @name FindByStatus */
SELECT * FROM identities
WHERE status = :status
  AND family_id = :familyId;

/* @name FindByRole */
SELECT * FROM identities
WHERE role = :role
  AND family_id = :familyId;

/* @name FindAllIdentities */
SELECT * FROM identities
WHERE family_id = :familyId
ORDER BY created_at DESC;

/* @name UpdateStatusText */
UPDATE identities
SET status_text = :statusText,
    status_updated_at = NOW()
WHERE identity_id = :identityId
  AND family_id = :familyId;

/* @name GetStatuses */
SELECT identity_id, status_text, status_updated_at
FROM identities
WHERE identity_id = ANY(:identityIds)
  AND family_id = :familyId;

/* @name FindActiveIdentities */
SELECT * FROM identities
WHERE status = 'active'
  AND family_id = :familyId;
