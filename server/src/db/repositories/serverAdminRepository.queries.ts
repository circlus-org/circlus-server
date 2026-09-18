/** Types generated for queries found in "src/db/repositories/serverAdminRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

/** 'IsActiveServerAdmin' parameters type */
export interface IsActiveServerAdminParams {
  identityId?: string | null | void;
}

/** 'IsActiveServerAdmin' return type */
export interface IsActiveServerAdminResult {
  exists: boolean | null;
}

/** 'IsActiveServerAdmin' query type */
export interface IsActiveServerAdminQuery {
  params: IsActiveServerAdminParams;
  result: IsActiveServerAdminResult;
}

const isActiveServerAdminIR: any = {"usedParamSet":{"identityId":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":79,"b":89}]}],"statement":"SELECT EXISTS(\n  SELECT 1\n  FROM server_admins\n  WHERE principal_identity_id = :identityId\n    AND status = 'active'\n) AS exists"};

/**
 * Query generated from SQL:
 * ```
 * SELECT EXISTS(
 *   SELECT 1
 *   FROM server_admins
 *   WHERE principal_identity_id = :identityId
 *     AND status = 'active'
 * ) AS exists
 * ```
 */
export const isActiveServerAdmin = new PreparedQuery<IsActiveServerAdminParams,IsActiveServerAdminResult>(isActiveServerAdminIR);


/** 'FindActiveServerAdminByIdentityId' parameters type */
export interface FindActiveServerAdminByIdentityIdParams {
  identityId?: string | null | void;
}

/** 'FindActiveServerAdminByIdentityId' return type */
export interface FindActiveServerAdminByIdentityIdResult {
  granted_at: Date;
  granted_by_server_admin_id: string | null;
  granted_via: string;
  principal_identity_id: string;
  revoked_at: Date | null;
  server_admin_id: string;
  status: string;
}

/** 'FindActiveServerAdminByIdentityId' query type */
export interface FindActiveServerAdminByIdentityIdQuery {
  params: FindActiveServerAdminByIdentityIdParams;
  result: FindActiveServerAdminByIdentityIdResult;
}

const findActiveServerAdminByIdentityIdIR: any = {"usedParamSet":{"identityId":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":58,"b":68}]}],"statement":"SELECT *\nFROM server_admins\nWHERE principal_identity_id = :identityId\n  AND status = 'active'\nORDER BY granted_at DESC\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM server_admins
 * WHERE principal_identity_id = :identityId
 *   AND status = 'active'
 * ORDER BY granted_at DESC
 * LIMIT 1
 * ```
 */
export const findActiveServerAdminByIdentityId = new PreparedQuery<FindActiveServerAdminByIdentityIdParams,FindActiveServerAdminByIdentityIdResult>(findActiveServerAdminByIdentityIdIR);


/** 'ListActiveServerAdmins' parameters type */
export type ListActiveServerAdminsParams = void;

/** 'ListActiveServerAdmins' return type */
export interface ListActiveServerAdminsResult {
  granted_at: Date;
  granted_by_server_admin_id: string | null;
  granted_via: string;
  principal_identity_id: string;
  revoked_at: Date | null;
  server_admin_id: string;
  status: string;
}

/** 'ListActiveServerAdmins' query type */
export interface ListActiveServerAdminsQuery {
  params: ListActiveServerAdminsParams;
  result: ListActiveServerAdminsResult;
}

const listActiveServerAdminsIR: any = {"usedParamSet":{},"params":[],"statement":"SELECT *\nFROM server_admins\nWHERE status = 'active'\nORDER BY granted_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM server_admins
 * WHERE status = 'active'
 * ORDER BY granted_at DESC
 * ```
 */
export const listActiveServerAdmins = new PreparedQuery<ListActiveServerAdminsParams,ListActiveServerAdminsResult>(listActiveServerAdminsIR);


/** 'CreateServerAdminClaim' parameters type */
export interface CreateServerAdminClaimParams {
  claimId?: string | null | void;
  expiresAt?: DateOrString | null | void;
  note?: string | null | void;
  tokenHash?: string | null | void;
}

/** 'CreateServerAdminClaim' return type */
export interface CreateServerAdminClaimResult {
  claim_id: string;
  created_at: Date;
  created_via: string;
  expires_at: Date;
  note: string | null;
  status: string;
  token_hash: string;
  used_at: Date | null;
  used_by_identity_id: string | null;
}

/** 'CreateServerAdminClaim' query type */
export interface CreateServerAdminClaimQuery {
  params: CreateServerAdminClaimParams;
  result: CreateServerAdminClaimResult;
}

const createServerAdminClaimIR: any = {"usedParamSet":{"claimId":true,"tokenHash":true,"expiresAt":true,"note":true},"params":[{"name":"claimId","required":false,"transform":{"type":"scalar"},"locs":[{"a":119,"b":126}]},{"name":"tokenHash","required":false,"transform":{"type":"scalar"},"locs":[{"a":131,"b":140}]},{"name":"expiresAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":158,"b":167}]},{"name":"note","required":false,"transform":{"type":"scalar"},"locs":[{"a":181,"b":185}]}],"statement":"INSERT INTO server_admin_claims (\n  claim_id,\n  token_hash,\n  status,\n  expires_at,\n  created_via,\n  note\n) VALUES (\n  :claimId,\n  :tokenHash,\n  'pending',\n  :expiresAt,\n  'cli',\n  :note\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO server_admin_claims (
 *   claim_id,
 *   token_hash,
 *   status,
 *   expires_at,
 *   created_via,
 *   note
 * ) VALUES (
 *   :claimId,
 *   :tokenHash,
 *   'pending',
 *   :expiresAt,
 *   'cli',
 *   :note
 * ) RETURNING *
 * ```
 */
export const createServerAdminClaim = new PreparedQuery<CreateServerAdminClaimParams,CreateServerAdminClaimResult>(createServerAdminClaimIR);


/** 'FindServerAdminClaimByTokenHash' parameters type */
export interface FindServerAdminClaimByTokenHashParams {
  tokenHash?: string | null | void;
}

/** 'FindServerAdminClaimByTokenHash' return type */
export interface FindServerAdminClaimByTokenHashResult {
  claim_id: string;
  created_at: Date;
  created_via: string;
  expires_at: Date;
  note: string | null;
  status: string;
  token_hash: string;
  used_at: Date | null;
  used_by_identity_id: string | null;
}

/** 'FindServerAdminClaimByTokenHash' query type */
export interface FindServerAdminClaimByTokenHashQuery {
  params: FindServerAdminClaimByTokenHashParams;
  result: FindServerAdminClaimByTokenHashResult;
}

const findServerAdminClaimByTokenHashIR: any = {"usedParamSet":{"tokenHash":true},"params":[{"name":"tokenHash","required":false,"transform":{"type":"scalar"},"locs":[{"a":53,"b":62}]}],"statement":"SELECT *\nFROM server_admin_claims\nWHERE token_hash = :tokenHash\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM server_admin_claims
 * WHERE token_hash = :tokenHash
 * LIMIT 1
 * ```
 */
export const findServerAdminClaimByTokenHash = new PreparedQuery<FindServerAdminClaimByTokenHashParams,FindServerAdminClaimByTokenHashResult>(findServerAdminClaimByTokenHashIR);


/** 'MarkServerAdminClaimUsed' parameters type */
export interface MarkServerAdminClaimUsedParams {
  identityId?: string | null | void;
  tokenHash?: string | null | void;
}

/** 'MarkServerAdminClaimUsed' return type */
export type MarkServerAdminClaimUsedResult = void;

/** 'MarkServerAdminClaimUsed' query type */
export interface MarkServerAdminClaimUsedQuery {
  params: MarkServerAdminClaimUsedParams;
  result: MarkServerAdminClaimUsedResult;
}

const markServerAdminClaimUsedIR: any = {"usedParamSet":{"identityId":true,"tokenHash":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":95,"b":105}]},{"name":"tokenHash","required":false,"transform":{"type":"scalar"},"locs":[{"a":126,"b":135}]}],"statement":"UPDATE server_admin_claims\nSET status = 'used',\n    used_at = NOW(),\n    used_by_identity_id = :identityId\nWHERE token_hash = :tokenHash"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE server_admin_claims
 * SET status = 'used',
 *     used_at = NOW(),
 *     used_by_identity_id = :identityId
 * WHERE token_hash = :tokenHash
 * ```
 */
export const markServerAdminClaimUsed = new PreparedQuery<MarkServerAdminClaimUsedParams,MarkServerAdminClaimUsedResult>(markServerAdminClaimUsedIR);


/** 'CreateServerAdmin' parameters type */
export interface CreateServerAdminParams {
  grantedByServerAdminId?: string | null | void;
  grantedVia?: string | null | void;
  identityId?: string | null | void;
  serverAdminId?: string | null | void;
}

/** 'CreateServerAdmin' return type */
export interface CreateServerAdminResult {
  granted_at: Date;
  granted_by_server_admin_id: string | null;
  granted_via: string;
  principal_identity_id: string;
  revoked_at: Date | null;
  server_admin_id: string;
  status: string;
}

/** 'CreateServerAdmin' query type */
export interface CreateServerAdminQuery {
  params: CreateServerAdminParams;
  result: CreateServerAdminResult;
}

const createServerAdminIR: any = {"usedParamSet":{"serverAdminId":true,"identityId":true,"grantedVia":true,"grantedByServerAdminId":true},"params":[{"name":"serverAdminId","required":false,"transform":{"type":"scalar"},"locs":[{"a":139,"b":152}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":157,"b":167}]},{"name":"grantedVia","required":false,"transform":{"type":"scalar"},"locs":[{"a":184,"b":194}]},{"name":"grantedByServerAdminId","required":false,"transform":{"type":"scalar"},"locs":[{"a":199,"b":221}]}],"statement":"INSERT INTO server_admins (\n  server_admin_id,\n  principal_identity_id,\n  status,\n  granted_via,\n  granted_by_server_admin_id\n) VALUES (\n  :serverAdminId,\n  :identityId,\n  'active',\n  :grantedVia,\n  :grantedByServerAdminId\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO server_admins (
 *   server_admin_id,
 *   principal_identity_id,
 *   status,
 *   granted_via,
 *   granted_by_server_admin_id
 * ) VALUES (
 *   :serverAdminId,
 *   :identityId,
 *   'active',
 *   :grantedVia,
 *   :grantedByServerAdminId
 * ) RETURNING *
 * ```
 */
export const createServerAdmin = new PreparedQuery<CreateServerAdminParams,CreateServerAdminResult>(createServerAdminIR);


