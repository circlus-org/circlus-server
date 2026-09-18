/* @name FindByCallSessionId */
SELECT * FROM call_sessions
WHERE call_session_id = :callSessionId
  AND family_id = :familyId;

/* @name CreateCallSession */
INSERT INTO call_sessions (
  call_session_id,
  family_id,
  participants,
  initiator,
  state
) VALUES (
  :callSessionId,
  :familyId,
  :participants,
  :initiator,
  :state
) RETURNING *;

/* @name UpdateCallState */
UPDATE call_sessions
SET state = :state
WHERE call_session_id = :callSessionId
  AND family_id = :familyId;

/* @name UpdateSdpOffer */
UPDATE call_sessions
SET sdp_offer = :sdpOffer
WHERE call_session_id = :callSessionId
  AND family_id = :familyId;

/* @name UpdateSdpAnswer */
UPDATE call_sessions
SET sdp_answer = :sdpAnswer, accepted_at = NOW()
WHERE call_session_id = :callSessionId
  AND family_id = :familyId;

/* @name AddIceCandidate */
UPDATE call_sessions
SET ice_candidates = ice_candidates || :candidate::jsonb
WHERE call_session_id = :callSessionId
  AND family_id = :familyId;

/* @name EndCallSession */
UPDATE call_sessions
SET state = 'ended', ended_at = NOW()
WHERE call_session_id = :callSessionId
  AND family_id = :familyId;

/* @name FindActiveCallSessions */
SELECT * FROM call_sessions
WHERE state IN ('new', 'ringing', 'accepted', 'connecting', 'active')
  AND family_id = :familyId
ORDER BY created_at DESC;

/* @name CleanupExpiredSessions */
UPDATE call_sessions
SET state = 'expired'
WHERE expires_at IS NOT NULL
  AND expires_at < NOW()
  AND state NOT IN ('ended', 'failed', 'expired')
  AND family_id = :familyId
RETURNING call_session_id, initiator, participants, created_at;

/* @name CountActiveCalls */
SELECT COUNT(*) as count FROM call_sessions
WHERE state IN ('new', 'ringing', 'accepted', 'connecting', 'active')
  AND family_id = :familyId;
