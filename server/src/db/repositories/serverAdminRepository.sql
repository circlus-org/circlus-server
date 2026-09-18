/* @name IsActiveServerAdmin */
SELECT EXISTS(
  SELECT 1
  FROM server_admins
  WHERE principal_identity_id = :identityId
    AND status = 'active'
) AS exists;

/* @name FindActiveServerAdminByIdentityId */
SELECT *
FROM server_admins
WHERE principal_identity_id = :identityId
  AND status = 'active'
ORDER BY granted_at DESC
LIMIT 1;

/* @name ListActiveServerAdmins */
SELECT *
FROM server_admins
WHERE status = 'active'
ORDER BY granted_at DESC;

/* @name CreateServerAdminClaim */
INSERT INTO server_admin_claims (
  claim_id,
  token_hash,
  status,
  expires_at,
  created_via,
  note
) VALUES (
  :claimId,
  :tokenHash,
  'pending',
  :expiresAt,
  'cli',
  :note
) RETURNING *;

/* @name FindServerAdminClaimByTokenHash */
SELECT *
FROM server_admin_claims
WHERE token_hash = :tokenHash
LIMIT 1;

/* @name MarkServerAdminClaimUsed */
UPDATE server_admin_claims
SET status = 'used',
    used_at = NOW(),
    used_by_identity_id = :identityId
WHERE token_hash = :tokenHash;

/* @name CreateServerAdmin */
INSERT INTO server_admins (
  server_admin_id,
  principal_identity_id,
  status,
  granted_via,
  granted_by_server_admin_id
) VALUES (
  :serverAdminId,
  :identityId,
  'active',
  :grantedVia,
  :grantedByServerAdminId
) RETURNING *;
