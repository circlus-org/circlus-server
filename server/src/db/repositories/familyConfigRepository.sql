/* @name FindByFamilyId */
SELECT * FROM family_config
WHERE family_id = :familyId;

/* @name FindAllFamilyConfigs */
SELECT * FROM family_config
ORDER BY created_at DESC;

/* @name CreateFamilyConfig */
INSERT INTO family_config (
  family_id,
  server_name,
  public_base_url,
  first_owner_invite_token,
  no_names_on_server
) VALUES (
  :familyId,
  :serverName,
  :publicBaseUrl,
  :firstOwnerInviteToken,
  :noNamesOnServer
) RETURNING *;

/* @name UpdateServerName */
UPDATE family_config
SET server_name = :serverName, updated_at = NOW()
WHERE family_id = :familyId
RETURNING *;

/* @name UpdatePublicBaseUrl */
UPDATE family_config
SET public_base_url = :publicBaseUrl, updated_at = NOW()
WHERE family_id = :familyId
RETURNING *;

/* @name UpdateFirstOwnerInviteToken */
UPDATE family_config
SET first_owner_invite_token = :firstOwnerInviteToken, updated_at = NOW()
WHERE family_id = :familyId
RETURNING *;

/* @name UpsertFamilyConfig */
INSERT INTO family_config (
  family_id,
  server_name,
  public_base_url,
  first_owner_invite_token,
  no_names_on_server
) VALUES (
  :familyId,
  :serverName,
  :publicBaseUrl,
  :firstOwnerInviteToken,
  :noNamesOnServer
) ON CONFLICT (family_id)
DO UPDATE SET
  server_name = EXCLUDED.server_name,
  public_base_url = EXCLUDED.public_base_url,
  first_owner_invite_token = EXCLUDED.first_owner_invite_token,
  updated_at = NOW()
RETURNING *;

/* @name DeleteFamilyConfig */
DELETE FROM family_config
WHERE family_id = :familyId;

/* @name FamilyExists */
SELECT EXISTS(SELECT 1 FROM family_config WHERE family_id = :familyId) as exists;
