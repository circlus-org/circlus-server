/* @name FindByIdentityId */
SELECT * FROM vaults
WHERE identity_id = :identityId
  AND family_id = :familyId;

/* @name CreateVault */
INSERT INTO vaults (
  identity_id,
  family_id,
  encrypted_vault,
  revision
) VALUES (
  :identityId,
  :familyId,
  :encryptedVault::jsonb,
  :revision
) RETURNING *;

/* @name UpsertVault */
INSERT INTO vaults (
  identity_id,
  family_id,
  encrypted_vault,
  revision
) VALUES (
  :identityId,
  :familyId,
  :encryptedVault::jsonb,
  :revision
) ON CONFLICT (identity_id)
DO UPDATE SET
  encrypted_vault = EXCLUDED.encrypted_vault,
  revision = EXCLUDED.revision,
  updated_at = NOW()
RETURNING *;

/* @name DeleteVault */
DELETE FROM vaults
WHERE identity_id = :identityId
  AND family_id = :familyId;

/* @name UpdateVaultStatus */
UPDATE vaults
SET status = :status
WHERE identity_id = :identityId
  AND family_id = :familyId;
