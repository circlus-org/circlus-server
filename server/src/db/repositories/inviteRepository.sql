/* @name FindByToken */
SELECT * FROM invites
WHERE token = :token
  AND family_id = :familyId;

/* @name FindById */
SELECT * FROM invites
WHERE invite_id = :inviteId
  AND family_id = :familyId;

/* @name CreateInvite */
INSERT INTO invites (
  invite_id,
  token,
  family_id,
  created_by,
  expires_at,
  max_uses
) VALUES (
  :inviteId,
  :token,
  :familyId,
  :createdBy,
  :expiresAt,
  :maxUses
) RETURNING *;

/* @name IncrementUsedCount */
UPDATE invites
SET used_count = used_count + 1
WHERE invite_id = :inviteId
  AND family_id = :familyId;

/* @name UpdateInviteStatus */
UPDATE invites
SET status = :status
WHERE invite_id = :inviteId
  AND family_id = :familyId
RETURNING *;

/* @name FindActiveInvites */
SELECT * FROM invites
WHERE status = 'active'
  AND family_id = :familyId
ORDER BY created_at DESC;

/* @name FindAllInvites */
SELECT * FROM invites
WHERE family_id = :familyId
ORDER BY created_at DESC;

/* @name FindByCreator */
SELECT * FROM invites
WHERE created_by = :createdBy
  AND family_id = :familyId
ORDER BY created_at DESC;

/* @name MarkExpiredInvites */
UPDATE invites
SET status = 'expired'
WHERE status = 'active' AND expires_at <= NOW()
  AND family_id = :familyId
RETURNING id;

/* @name CountInvites */
SELECT COUNT(*) as count FROM invites
WHERE family_id = :familyId;

/* @name CountActiveInvites */
SELECT COUNT(*) as count FROM invites
WHERE status = 'active'
  AND family_id = :familyId;
