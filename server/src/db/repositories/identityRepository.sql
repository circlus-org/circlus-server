/* @name FindByIdentityId */
SELECT * FROM identities
WHERE identity_id = :identityId
  AND family_id = :familyId;

/* @name FindByPublicKey */
SELECT * FROM identities
WHERE public_key_value = :publicKeyValue
  AND family_id = :familyId;

/* @name UpdateStatus */
UPDATE identities
SET status = :status
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

/* @name FindActiveIdentities */
SELECT * FROM identities
WHERE status = 'active'
  AND family_id = :familyId;
