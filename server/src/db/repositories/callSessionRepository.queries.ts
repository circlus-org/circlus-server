/** Types generated for queries found in "src/db/repositories/callSessionRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type stringArray = (string)[];

/** 'FindByCallSessionId' parameters type */
export interface FindByCallSessionIdParams {
  callSessionId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindByCallSessionId' return type */
export interface FindByCallSessionIdResult {
  accepted_at: Date | null;
  call_session_id: string;
  created_at: Date;
  ended_at: Date | null;
  expires_at: Date | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  ice_candidates: Json | null;
  id: string;
  initiator: string;
  participants: stringArray;
  sdp_answer: string | null;
  sdp_offer: string | null;
  state: string;
}

/** 'FindByCallSessionId' query type */
export interface FindByCallSessionIdQuery {
  params: FindByCallSessionIdParams;
  result: FindByCallSessionIdResult;
}

const findByCallSessionIdIR: any = {"usedParamSet":{"callSessionId":true,"familyId":true},"params":[{"name":"callSessionId","required":false,"transform":{"type":"scalar"},"locs":[{"a":52,"b":65}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":85,"b":93}]}],"statement":"SELECT * FROM call_sessions\nWHERE call_session_id = :callSessionId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM call_sessions
 * WHERE call_session_id = :callSessionId
 *   AND family_id = :familyId
 * ```
 */
export const findByCallSessionId = new PreparedQuery<FindByCallSessionIdParams,FindByCallSessionIdResult>(findByCallSessionIdIR);


/** 'CreateCallSession' parameters type */
export interface CreateCallSessionParams {
  callSessionId?: string | null | void;
  familyId?: string | null | void;
  initiator?: string | null | void;
  participants?: stringArray | null | void;
  state?: string | null | void;
}

/** 'CreateCallSession' return type */
export interface CreateCallSessionResult {
  accepted_at: Date | null;
  call_session_id: string;
  created_at: Date;
  ended_at: Date | null;
  expires_at: Date | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  ice_candidates: Json | null;
  id: string;
  initiator: string;
  participants: stringArray;
  sdp_answer: string | null;
  sdp_offer: string | null;
  state: string;
}

/** 'CreateCallSession' query type */
export interface CreateCallSessionQuery {
  params: CreateCallSessionParams;
  result: CreateCallSessionResult;
}

const createCallSessionIR: any = {"usedParamSet":{"callSessionId":true,"familyId":true,"participants":true,"initiator":true,"state":true},"params":[{"name":"callSessionId","required":false,"transform":{"type":"scalar"},"locs":[{"a":110,"b":123}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":128,"b":136}]},{"name":"participants","required":false,"transform":{"type":"scalar"},"locs":[{"a":141,"b":153}]},{"name":"initiator","required":false,"transform":{"type":"scalar"},"locs":[{"a":158,"b":167}]},{"name":"state","required":false,"transform":{"type":"scalar"},"locs":[{"a":172,"b":177}]}],"statement":"INSERT INTO call_sessions (\n  call_session_id,\n  family_id,\n  participants,\n  initiator,\n  state\n) VALUES (\n  :callSessionId,\n  :familyId,\n  :participants,\n  :initiator,\n  :state\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO call_sessions (
 *   call_session_id,
 *   family_id,
 *   participants,
 *   initiator,
 *   state
 * ) VALUES (
 *   :callSessionId,
 *   :familyId,
 *   :participants,
 *   :initiator,
 *   :state
 * ) RETURNING *
 * ```
 */
export const createCallSession = new PreparedQuery<CreateCallSessionParams,CreateCallSessionResult>(createCallSessionIR);


/** 'UpdateCallState' parameters type */
export interface UpdateCallStateParams {
  callSessionId?: string | null | void;
  familyId?: string | null | void;
  state?: string | null | void;
}

/** 'UpdateCallState' return type */
export type UpdateCallStateResult = void;

/** 'UpdateCallState' query type */
export interface UpdateCallStateQuery {
  params: UpdateCallStateParams;
  result: UpdateCallStateResult;
}

const updateCallStateIR: any = {"usedParamSet":{"state":true,"callSessionId":true,"familyId":true},"params":[{"name":"state","required":false,"transform":{"type":"scalar"},"locs":[{"a":33,"b":38}]},{"name":"callSessionId","required":false,"transform":{"type":"scalar"},"locs":[{"a":64,"b":77}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":97,"b":105}]}],"statement":"UPDATE call_sessions\nSET state = :state\nWHERE call_session_id = :callSessionId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE call_sessions
 * SET state = :state
 * WHERE call_session_id = :callSessionId
 *   AND family_id = :familyId
 * ```
 */
export const updateCallState = new PreparedQuery<UpdateCallStateParams,UpdateCallStateResult>(updateCallStateIR);


/** 'UpdateSdpOffer' parameters type */
export interface UpdateSdpOfferParams {
  callSessionId?: string | null | void;
  familyId?: string | null | void;
  sdpOffer?: string | null | void;
}

/** 'UpdateSdpOffer' return type */
export type UpdateSdpOfferResult = void;

/** 'UpdateSdpOffer' query type */
export interface UpdateSdpOfferQuery {
  params: UpdateSdpOfferParams;
  result: UpdateSdpOfferResult;
}

const updateSdpOfferIR: any = {"usedParamSet":{"sdpOffer":true,"callSessionId":true,"familyId":true},"params":[{"name":"sdpOffer","required":false,"transform":{"type":"scalar"},"locs":[{"a":37,"b":45}]},{"name":"callSessionId","required":false,"transform":{"type":"scalar"},"locs":[{"a":71,"b":84}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":104,"b":112}]}],"statement":"UPDATE call_sessions\nSET sdp_offer = :sdpOffer\nWHERE call_session_id = :callSessionId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE call_sessions
 * SET sdp_offer = :sdpOffer
 * WHERE call_session_id = :callSessionId
 *   AND family_id = :familyId
 * ```
 */
export const updateSdpOffer = new PreparedQuery<UpdateSdpOfferParams,UpdateSdpOfferResult>(updateSdpOfferIR);


/** 'UpdateSdpAnswer' parameters type */
export interface UpdateSdpAnswerParams {
  callSessionId?: string | null | void;
  familyId?: string | null | void;
  sdpAnswer?: string | null | void;
}

/** 'UpdateSdpAnswer' return type */
export type UpdateSdpAnswerResult = void;

/** 'UpdateSdpAnswer' query type */
export interface UpdateSdpAnswerQuery {
  params: UpdateSdpAnswerParams;
  result: UpdateSdpAnswerResult;
}

const updateSdpAnswerIR: any = {"usedParamSet":{"sdpAnswer":true,"callSessionId":true,"familyId":true},"params":[{"name":"sdpAnswer","required":false,"transform":{"type":"scalar"},"locs":[{"a":38,"b":47}]},{"name":"callSessionId","required":false,"transform":{"type":"scalar"},"locs":[{"a":94,"b":107}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":127,"b":135}]}],"statement":"UPDATE call_sessions\nSET sdp_answer = :sdpAnswer, accepted_at = NOW()\nWHERE call_session_id = :callSessionId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE call_sessions
 * SET sdp_answer = :sdpAnswer, accepted_at = NOW()
 * WHERE call_session_id = :callSessionId
 *   AND family_id = :familyId
 * ```
 */
export const updateSdpAnswer = new PreparedQuery<UpdateSdpAnswerParams,UpdateSdpAnswerResult>(updateSdpAnswerIR);


/** 'AddIceCandidate' parameters type */
export interface AddIceCandidateParams {
  callSessionId?: string | null | void;
  candidate?: Json | null | void;
  familyId?: string | null | void;
}

/** 'AddIceCandidate' return type */
export type AddIceCandidateResult = void;

/** 'AddIceCandidate' query type */
export interface AddIceCandidateQuery {
  params: AddIceCandidateParams;
  result: AddIceCandidateResult;
}

const addIceCandidateIR: any = {"usedParamSet":{"candidate":true,"callSessionId":true,"familyId":true},"params":[{"name":"candidate","required":false,"transform":{"type":"scalar"},"locs":[{"a":60,"b":69}]},{"name":"callSessionId","required":false,"transform":{"type":"scalar"},"locs":[{"a":102,"b":115}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":135,"b":143}]}],"statement":"UPDATE call_sessions\nSET ice_candidates = ice_candidates || :candidate::jsonb\nWHERE call_session_id = :callSessionId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE call_sessions
 * SET ice_candidates = ice_candidates || :candidate::jsonb
 * WHERE call_session_id = :callSessionId
 *   AND family_id = :familyId
 * ```
 */
export const addIceCandidate = new PreparedQuery<AddIceCandidateParams,AddIceCandidateResult>(addIceCandidateIR);


/** 'EndCallSession' parameters type */
export interface EndCallSessionParams {
  callSessionId?: string | null | void;
  familyId?: string | null | void;
}

/** 'EndCallSession' return type */
export type EndCallSessionResult = void;

/** 'EndCallSession' query type */
export interface EndCallSessionQuery {
  params: EndCallSessionParams;
  result: EndCallSessionResult;
}

const endCallSessionIR: any = {"usedParamSet":{"callSessionId":true,"familyId":true},"params":[{"name":"callSessionId","required":false,"transform":{"type":"scalar"},"locs":[{"a":83,"b":96}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":116,"b":124}]}],"statement":"UPDATE call_sessions\nSET state = 'ended', ended_at = NOW()\nWHERE call_session_id = :callSessionId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE call_sessions
 * SET state = 'ended', ended_at = NOW()
 * WHERE call_session_id = :callSessionId
 *   AND family_id = :familyId
 * ```
 */
export const endCallSession = new PreparedQuery<EndCallSessionParams,EndCallSessionResult>(endCallSessionIR);


/** 'FindActiveCallSessions' parameters type */
export interface FindActiveCallSessionsParams {
  familyId?: string | null | void;
}

/** 'FindActiveCallSessions' return type */
export interface FindActiveCallSessionsResult {
  accepted_at: Date | null;
  call_session_id: string;
  created_at: Date;
  ended_at: Date | null;
  expires_at: Date | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  ice_candidates: Json | null;
  id: string;
  initiator: string;
  participants: stringArray;
  sdp_answer: string | null;
  sdp_offer: string | null;
  state: string;
}

/** 'FindActiveCallSessions' query type */
export interface FindActiveCallSessionsQuery {
  params: FindActiveCallSessionsParams;
  result: FindActiveCallSessionsResult;
}

const findActiveCallSessionsIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":116,"b":124}]}],"statement":"SELECT * FROM call_sessions\nWHERE state IN ('new', 'ringing', 'accepted', 'connecting', 'active')\n  AND family_id = :familyId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM call_sessions
 * WHERE state IN ('new', 'ringing', 'accepted', 'connecting', 'active')
 *   AND family_id = :familyId
 * ORDER BY created_at DESC
 * ```
 */
export const findActiveCallSessions = new PreparedQuery<FindActiveCallSessionsParams,FindActiveCallSessionsResult>(findActiveCallSessionsIR);


/** 'CleanupExpiredSessions' parameters type */
export interface CleanupExpiredSessionsParams {
  familyId?: string | null | void;
}

/** 'CleanupExpiredSessions' return type */
export interface CleanupExpiredSessionsResult {
  call_session_id: string;
  created_at: Date;
  initiator: string;
  participants: stringArray;
}

/** 'CleanupExpiredSessions' query type */
export interface CleanupExpiredSessionsQuery {
  params: CleanupExpiredSessionsParams;
  result: CleanupExpiredSessionsResult;
}

const cleanupExpiredSessionsIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":165,"b":173}]}],"statement":"UPDATE call_sessions\nSET state = 'expired'\nWHERE expires_at IS NOT NULL\n  AND expires_at < NOW()\n  AND state NOT IN ('ended', 'failed', 'expired')\n  AND family_id = :familyId\nRETURNING call_session_id, initiator, participants, created_at"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE call_sessions
 * SET state = 'expired'
 * WHERE expires_at IS NOT NULL
 *   AND expires_at < NOW()
 *   AND state NOT IN ('ended', 'failed', 'expired')
 *   AND family_id = :familyId
 * RETURNING call_session_id, initiator, participants, created_at
 * ```
 */
export const cleanupExpiredSessions = new PreparedQuery<CleanupExpiredSessionsParams,CleanupExpiredSessionsResult>(cleanupExpiredSessionsIR);


/** 'CountActiveCalls' parameters type */
export interface CountActiveCallsParams {
  familyId?: string | null | void;
}

/** 'CountActiveCalls' return type */
export interface CountActiveCallsResult {
  count: string | null;
}

/** 'CountActiveCalls' query type */
export interface CountActiveCallsQuery {
  params: CountActiveCallsParams;
  result: CountActiveCallsResult;
}

const countActiveCallsIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":132,"b":140}]}],"statement":"SELECT COUNT(*) as count FROM call_sessions\nWHERE state IN ('new', 'ringing', 'accepted', 'connecting', 'active')\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT COUNT(*) as count FROM call_sessions
 * WHERE state IN ('new', 'ringing', 'accepted', 'connecting', 'active')
 *   AND family_id = :familyId
 * ```
 */
export const countActiveCalls = new PreparedQuery<CountActiveCallsParams,CountActiveCallsResult>(countActiveCallsIR);


