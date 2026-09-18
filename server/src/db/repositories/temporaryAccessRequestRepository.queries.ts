/** Types generated for queries found in "src/db/repositories/temporaryAccessRequestRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

/** 'FindTemporaryAccessRequestByRequestId' parameters type */
export interface FindTemporaryAccessRequestByRequestIdParams {
  familyId?: string | null | void;
  requestId?: string | null | void;
  requestType?: string | null | void;
}

/** 'FindTemporaryAccessRequestByRequestId' return type */
export interface FindTemporaryAccessRequestByRequestIdResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_payload: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  request_id: string;
  request_type: string;
  status: string;
  temporary_device_id: string;
  temporary_device_public_key_algorithm: string;
  temporary_device_public_key_value: string;
}

/** 'FindTemporaryAccessRequestByRequestId' query type */
export interface FindTemporaryAccessRequestByRequestIdQuery {
  params: FindTemporaryAccessRequestByRequestIdParams;
  result: FindTemporaryAccessRequestByRequestIdResult;
}

const findTemporaryAccessRequestByRequestIdIR: any = {"usedParamSet":{"familyId":true,"requestId":true,"requestType":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":58,"b":66}]},{"name":"requestId","required":false,"transform":{"type":"scalar"},"locs":[{"a":87,"b":96}]},{"name":"requestType","required":false,"transform":{"type":"scalar"},"locs":[{"a":119,"b":130}]}],"statement":"SELECT *\nFROM temporary_access_requests\nWHERE family_id = :familyId\n  AND request_id = :requestId\n  AND request_type = :requestType\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM temporary_access_requests
 * WHERE family_id = :familyId
 *   AND request_id = :requestId
 *   AND request_type = :requestType
 * LIMIT 1
 * ```
 */
export const findTemporaryAccessRequestByRequestId = new PreparedQuery<FindTemporaryAccessRequestByRequestIdParams,FindTemporaryAccessRequestByRequestIdResult>(findTemporaryAccessRequestByRequestIdIR);


/** 'CreateTemporaryAccessRequest' parameters type */
export interface CreateTemporaryAccessRequestParams {
  enrollmentId?: string | null | void;
  expiresAt?: DateOrString | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  requestId?: string | null | void;
  requestType?: string | null | void;
  temporaryDeviceId?: string | null | void;
  temporaryDevicePublicKeyAlgorithm?: string | null | void;
  temporaryDevicePublicKeyValue?: string | null | void;
}

/** 'CreateTemporaryAccessRequest' return type */
export interface CreateTemporaryAccessRequestResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_payload: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  request_id: string;
  request_type: string;
  status: string;
  temporary_device_id: string;
  temporary_device_public_key_algorithm: string;
  temporary_device_public_key_value: string;
}

/** 'CreateTemporaryAccessRequest' query type */
export interface CreateTemporaryAccessRequestQuery {
  params: CreateTemporaryAccessRequestParams;
  result: CreateTemporaryAccessRequestResult;
}

const createTemporaryAccessRequestIR: any = {"usedParamSet":{"requestId":true,"requestType":true,"familyId":true,"identityId":true,"enrollmentId":true,"temporaryDeviceId":true,"temporaryDevicePublicKeyAlgorithm":true,"temporaryDevicePublicKeyValue":true,"expiresAt":true},"params":[{"name":"requestId","required":false,"transform":{"type":"scalar"},"locs":[{"a":242,"b":251}]},{"name":"requestType","required":false,"transform":{"type":"scalar"},"locs":[{"a":256,"b":267}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":272,"b":280}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":285,"b":295}]},{"name":"enrollmentId","required":false,"transform":{"type":"scalar"},"locs":[{"a":300,"b":312}]},{"name":"temporaryDeviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":317,"b":334}]},{"name":"temporaryDevicePublicKeyAlgorithm","required":false,"transform":{"type":"scalar"},"locs":[{"a":339,"b":372}]},{"name":"temporaryDevicePublicKeyValue","required":false,"transform":{"type":"scalar"},"locs":[{"a":377,"b":406}]},{"name":"expiresAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":411,"b":420}]}],"statement":"INSERT INTO temporary_access_requests (\n  request_id,\n  request_type,\n  family_id,\n  identity_id,\n  enrollment_id,\n  temporary_device_id,\n  temporary_device_public_key_algorithm,\n  temporary_device_public_key_value,\n  expires_at\n) VALUES (\n  :requestId,\n  :requestType,\n  :familyId,\n  :identityId,\n  :enrollmentId,\n  :temporaryDeviceId,\n  :temporaryDevicePublicKeyAlgorithm,\n  :temporaryDevicePublicKeyValue,\n  :expiresAt\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO temporary_access_requests (
 *   request_id,
 *   request_type,
 *   family_id,
 *   identity_id,
 *   enrollment_id,
 *   temporary_device_id,
 *   temporary_device_public_key_algorithm,
 *   temporary_device_public_key_value,
 *   expires_at
 * ) VALUES (
 *   :requestId,
 *   :requestType,
 *   :familyId,
 *   :identityId,
 *   :enrollmentId,
 *   :temporaryDeviceId,
 *   :temporaryDevicePublicKeyAlgorithm,
 *   :temporaryDevicePublicKeyValue,
 *   :expiresAt
 * ) RETURNING *
 * ```
 */
export const createTemporaryAccessRequest = new PreparedQuery<CreateTemporaryAccessRequestParams,CreateTemporaryAccessRequestResult>(createTemporaryAccessRequestIR);


/** 'ListPendingTemporaryAccessRequestsByIdentity' parameters type */
export interface ListPendingTemporaryAccessRequestsByIdentityParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
  requestType?: string | null | void;
}

/** 'ListPendingTemporaryAccessRequestsByIdentity' return type */
export interface ListPendingTemporaryAccessRequestsByIdentityResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_payload: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  request_id: string;
  request_type: string;
  status: string;
  temporary_device_id: string;
  temporary_device_public_key_algorithm: string;
  temporary_device_public_key_value: string;
}

/** 'ListPendingTemporaryAccessRequestsByIdentity' query type */
export interface ListPendingTemporaryAccessRequestsByIdentityQuery {
  params: ListPendingTemporaryAccessRequestsByIdentityParams;
  result: ListPendingTemporaryAccessRequestsByIdentityResult;
}

const listPendingTemporaryAccessRequestsByIdentityIR: any = {"usedParamSet":{"familyId":true,"identityId":true,"requestType":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":58,"b":66}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":88,"b":98}]},{"name":"requestType","required":false,"transform":{"type":"scalar"},"locs":[{"a":121,"b":132}]}],"statement":"SELECT *\nFROM temporary_access_requests\nWHERE family_id = :familyId\n  AND identity_id = :identityId\n  AND request_type = :requestType\n  AND status = 'pending'\n  AND expires_at > NOW()\nORDER BY created_at ASC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM temporary_access_requests
 * WHERE family_id = :familyId
 *   AND identity_id = :identityId
 *   AND request_type = :requestType
 *   AND status = 'pending'
 *   AND expires_at > NOW()
 * ORDER BY created_at ASC
 * ```
 */
export const listPendingTemporaryAccessRequestsByIdentity = new PreparedQuery<ListPendingTemporaryAccessRequestsByIdentityParams,ListPendingTemporaryAccessRequestsByIdentityResult>(listPendingTemporaryAccessRequestsByIdentityIR);


/** 'ListActiveTemporaryAccessRequestsByTemporaryDevice' parameters type */
export interface ListActiveTemporaryAccessRequestsByTemporaryDeviceParams {
  familyId?: string | null | void;
  requestType?: string | null | void;
  temporaryDeviceId?: string | null | void;
}

/** 'ListActiveTemporaryAccessRequestsByTemporaryDevice' return type */
export interface ListActiveTemporaryAccessRequestsByTemporaryDeviceResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_payload: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  request_id: string;
  request_type: string;
  status: string;
  temporary_device_id: string;
  temporary_device_public_key_algorithm: string;
  temporary_device_public_key_value: string;
}

/** 'ListActiveTemporaryAccessRequestsByTemporaryDevice' query type */
export interface ListActiveTemporaryAccessRequestsByTemporaryDeviceQuery {
  params: ListActiveTemporaryAccessRequestsByTemporaryDeviceParams;
  result: ListActiveTemporaryAccessRequestsByTemporaryDeviceResult;
}

const listActiveTemporaryAccessRequestsByTemporaryDeviceIR: any = {"usedParamSet":{"familyId":true,"temporaryDeviceId":true,"requestType":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":58,"b":66}]},{"name":"temporaryDeviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":96,"b":113}]},{"name":"requestType","required":false,"transform":{"type":"scalar"},"locs":[{"a":136,"b":147}]}],"statement":"SELECT *\nFROM temporary_access_requests\nWHERE family_id = :familyId\n  AND temporary_device_id = :temporaryDeviceId\n  AND request_type = :requestType\n  AND status IN ('pending', 'approved')\n  AND expires_at > NOW()\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM temporary_access_requests
 * WHERE family_id = :familyId
 *   AND temporary_device_id = :temporaryDeviceId
 *   AND request_type = :requestType
 *   AND status IN ('pending', 'approved')
 *   AND expires_at > NOW()
 * ORDER BY created_at DESC
 * ```
 */
export const listActiveTemporaryAccessRequestsByTemporaryDevice = new PreparedQuery<ListActiveTemporaryAccessRequestsByTemporaryDeviceParams,ListActiveTemporaryAccessRequestsByTemporaryDeviceResult>(listActiveTemporaryAccessRequestsByTemporaryDeviceIR);


/** 'ApproveTemporaryAccessRequest' parameters type */
export interface ApproveTemporaryAccessRequestParams {
  approvedByDeviceId?: string | null | void;
  cipher?: string | null | void;
  encryptedPayload?: string | null | void;
  familyId?: string | null | void;
  requestId?: string | null | void;
  requestType?: string | null | void;
}

/** 'ApproveTemporaryAccessRequest' return type */
export interface ApproveTemporaryAccessRequestResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_payload: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  request_id: string;
  request_type: string;
  status: string;
  temporary_device_id: string;
  temporary_device_public_key_algorithm: string;
  temporary_device_public_key_value: string;
}

/** 'ApproveTemporaryAccessRequest' query type */
export interface ApproveTemporaryAccessRequestQuery {
  params: ApproveTemporaryAccessRequestParams;
  result: ApproveTemporaryAccessRequestResult;
}

const approveTemporaryAccessRequestIR: any = {"usedParamSet":{"approvedByDeviceId":true,"encryptedPayload":true,"cipher":true,"familyId":true,"requestId":true,"requestType":true},"params":[{"name":"approvedByDeviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":86,"b":104}]},{"name":"encryptedPayload","required":false,"transform":{"type":"scalar"},"locs":[{"a":131,"b":147}]},{"name":"cipher","required":false,"transform":{"type":"scalar"},"locs":[{"a":163,"b":169}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":214,"b":222}]},{"name":"requestId","required":false,"transform":{"type":"scalar"},"locs":[{"a":243,"b":252}]},{"name":"requestType","required":false,"transform":{"type":"scalar"},"locs":[{"a":275,"b":286}]}],"statement":"UPDATE temporary_access_requests\nSET status = 'approved',\n    approved_by_device_id = :approvedByDeviceId,\n    encrypted_payload = :encryptedPayload,\n    cipher = :cipher,\n    approved_at = NOW()\nWHERE family_id = :familyId\n  AND request_id = :requestId\n  AND request_type = :requestType\n  AND status = 'pending'\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE temporary_access_requests
 * SET status = 'approved',
 *     approved_by_device_id = :approvedByDeviceId,
 *     encrypted_payload = :encryptedPayload,
 *     cipher = :cipher,
 *     approved_at = NOW()
 * WHERE family_id = :familyId
 *   AND request_id = :requestId
 *   AND request_type = :requestType
 *   AND status = 'pending'
 * RETURNING *
 * ```
 */
export const approveTemporaryAccessRequest = new PreparedQuery<ApproveTemporaryAccessRequestParams,ApproveTemporaryAccessRequestResult>(approveTemporaryAccessRequestIR);


/** 'RejectTemporaryAccessRequest' parameters type */
export interface RejectTemporaryAccessRequestParams {
  familyId?: string | null | void;
  requestId?: string | null | void;
  requestType?: string | null | void;
}

/** 'RejectTemporaryAccessRequest' return type */
export interface RejectTemporaryAccessRequestResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_payload: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  request_id: string;
  request_type: string;
  status: string;
  temporary_device_id: string;
  temporary_device_public_key_algorithm: string;
  temporary_device_public_key_value: string;
}

/** 'RejectTemporaryAccessRequest' query type */
export interface RejectTemporaryAccessRequestQuery {
  params: RejectTemporaryAccessRequestParams;
  result: RejectTemporaryAccessRequestResult;
}

const rejectTemporaryAccessRequestIR: any = {"usedParamSet":{"familyId":true,"requestId":true,"requestType":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":75,"b":83}]},{"name":"requestId","required":false,"transform":{"type":"scalar"},"locs":[{"a":104,"b":113}]},{"name":"requestType","required":false,"transform":{"type":"scalar"},"locs":[{"a":136,"b":147}]}],"statement":"UPDATE temporary_access_requests\nSET status = 'rejected'\nWHERE family_id = :familyId\n  AND request_id = :requestId\n  AND request_type = :requestType\n  AND status = 'pending'\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE temporary_access_requests
 * SET status = 'rejected'
 * WHERE family_id = :familyId
 *   AND request_id = :requestId
 *   AND request_type = :requestType
 *   AND status = 'pending'
 * RETURNING *
 * ```
 */
export const rejectTemporaryAccessRequest = new PreparedQuery<RejectTemporaryAccessRequestParams,RejectTemporaryAccessRequestResult>(rejectTemporaryAccessRequestIR);


/** 'ConsumeTemporaryAccessRequest' parameters type */
export interface ConsumeTemporaryAccessRequestParams {
  familyId?: string | null | void;
  requestId?: string | null | void;
  requestType?: string | null | void;
}

/** 'ConsumeTemporaryAccessRequest' return type */
export interface ConsumeTemporaryAccessRequestResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_payload: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  request_id: string;
  request_type: string;
  status: string;
  temporary_device_id: string;
  temporary_device_public_key_algorithm: string;
  temporary_device_public_key_value: string;
}

/** 'ConsumeTemporaryAccessRequest' query type */
export interface ConsumeTemporaryAccessRequestQuery {
  params: ConsumeTemporaryAccessRequestParams;
  result: ConsumeTemporaryAccessRequestResult;
}

const consumeTemporaryAccessRequestIR: any = {"usedParamSet":{"familyId":true,"requestId":true,"requestType":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":100,"b":108}]},{"name":"requestId","required":false,"transform":{"type":"scalar"},"locs":[{"a":129,"b":138}]},{"name":"requestType","required":false,"transform":{"type":"scalar"},"locs":[{"a":161,"b":172}]}],"statement":"UPDATE temporary_access_requests\nSET status = 'consumed',\n    consumed_at = NOW()\nWHERE family_id = :familyId\n  AND request_id = :requestId\n  AND request_type = :requestType\n  AND status = 'approved'\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE temporary_access_requests
 * SET status = 'consumed',
 *     consumed_at = NOW()
 * WHERE family_id = :familyId
 *   AND request_id = :requestId
 *   AND request_type = :requestType
 *   AND status = 'approved'
 * RETURNING *
 * ```
 */
export const consumeTemporaryAccessRequest = new PreparedQuery<ConsumeTemporaryAccessRequestParams,ConsumeTemporaryAccessRequestResult>(consumeTemporaryAccessRequestIR);


/** 'ExpireTemporaryAccessRequestsByType' parameters type */
export interface ExpireTemporaryAccessRequestsByTypeParams {
  requestType?: string | null | void;
}

/** 'ExpireTemporaryAccessRequestsByType' return type */
export type ExpireTemporaryAccessRequestsByTypeResult = void;

/** 'ExpireTemporaryAccessRequestsByType' query type */
export interface ExpireTemporaryAccessRequestsByTypeQuery {
  params: ExpireTemporaryAccessRequestsByTypeParams;
  result: ExpireTemporaryAccessRequestsByTypeResult;
}

const expireTemporaryAccessRequestsByTypeIR: any = {"usedParamSet":{"requestType":true},"params":[{"name":"requestType","required":false,"transform":{"type":"scalar"},"locs":[{"a":77,"b":88}]}],"statement":"UPDATE temporary_access_requests\nSET status = 'expired'\nWHERE request_type = :requestType\n  AND status IN ('pending', 'approved')\n  AND expires_at < NOW()"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE temporary_access_requests
 * SET status = 'expired'
 * WHERE request_type = :requestType
 *   AND status IN ('pending', 'approved')
 *   AND expires_at < NOW()
 * ```
 */
export const expireTemporaryAccessRequestsByType = new PreparedQuery<ExpireTemporaryAccessRequestsByTypeParams,ExpireTemporaryAccessRequestsByTypeResult>(expireTemporaryAccessRequestsByTypeIR);


/** 'ExpireAllTemporaryAccessRequests' parameters type */
export type ExpireAllTemporaryAccessRequestsParams = void;

/** 'ExpireAllTemporaryAccessRequests' return type */
export type ExpireAllTemporaryAccessRequestsResult = void;

/** 'ExpireAllTemporaryAccessRequests' query type */
export interface ExpireAllTemporaryAccessRequestsQuery {
  params: ExpireAllTemporaryAccessRequestsParams;
  result: ExpireAllTemporaryAccessRequestsResult;
}

const expireAllTemporaryAccessRequestsIR: any = {"usedParamSet":{},"params":[],"statement":"UPDATE temporary_access_requests\nSET status = 'expired'\nWHERE status IN ('pending', 'approved')\n  AND expires_at < NOW()"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE temporary_access_requests
 * SET status = 'expired'
 * WHERE status IN ('pending', 'approved')
 *   AND expires_at < NOW()
 * ```
 */
export const expireAllTemporaryAccessRequests = new PreparedQuery<ExpireAllTemporaryAccessRequestsParams,ExpireAllTemporaryAccessRequestsResult>(expireAllTemporaryAccessRequestsIR);


