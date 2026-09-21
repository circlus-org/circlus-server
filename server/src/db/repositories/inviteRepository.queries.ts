/** Types generated for queries found in "src/db/repositories/inviteRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 'FindByToken' parameters type */
export interface FindByTokenParams {
  familyId?: string | null | void;
  token?: string | null | void;
}

/** 'FindByToken' return type */
export interface FindByTokenResult {
  capability_descriptor: Json | null;
  capability_id: string | null;
  capability_mode: string | null;
  capability_public_key: string | null;
  capability_revocation: Json | null;
  created_at: Date;
  created_by: string;
  encrypted_membership_checkpoint_bundle: Json | null;
  encrypted_secret: Json | null;
  expires_at: Date;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  invite_id: string;
  max_uses: number;
  status: string;
  token: string;
  used_count: number;
}

/** 'FindByToken' query type */
export interface FindByTokenQuery {
  params: FindByTokenParams;
  result: FindByTokenResult;
}

const findByTokenIR: any = {"usedParamSet":{"token":true,"familyId":true},"params":[{"name":"token","required":false,"transform":{"type":"scalar"},"locs":[{"a":36,"b":41}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":61,"b":69}]}],"statement":"SELECT * FROM invites\nWHERE token = :token\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM invites
 * WHERE token = :token
 *   AND family_id = :familyId
 * ```
 */
export const findByToken = new PreparedQuery<FindByTokenParams,FindByTokenResult>(findByTokenIR);


/** 'FindById' parameters type */
export interface FindByIdParams {
  familyId?: string | null | void;
  inviteId?: string | null | void;
}

/** 'FindById' return type */
export interface FindByIdResult {
  capability_descriptor: Json | null;
  capability_id: string | null;
  capability_mode: string | null;
  capability_public_key: string | null;
  capability_revocation: Json | null;
  created_at: Date;
  created_by: string;
  encrypted_membership_checkpoint_bundle: Json | null;
  encrypted_secret: Json | null;
  expires_at: Date;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  invite_id: string;
  max_uses: number;
  status: string;
  token: string;
  used_count: number;
}

/** 'FindById' query type */
export interface FindByIdQuery {
  params: FindByIdParams;
  result: FindByIdResult;
}

const findByIdIR: any = {"usedParamSet":{"inviteId":true,"familyId":true},"params":[{"name":"inviteId","required":false,"transform":{"type":"scalar"},"locs":[{"a":40,"b":48}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":68,"b":76}]}],"statement":"SELECT * FROM invites\nWHERE invite_id = :inviteId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM invites
 * WHERE invite_id = :inviteId
 *   AND family_id = :familyId
 * ```
 */
export const findById = new PreparedQuery<FindByIdParams,FindByIdResult>(findByIdIR);


/** 'CreateInvite' parameters type */
export interface CreateInviteParams {
  createdBy?: string | null | void;
  expiresAt?: DateOrString | null | void;
  familyId?: string | null | void;
  inviteId?: string | null | void;
  maxUses?: number | null | void;
  token?: string | null | void;
}

/** 'CreateInvite' return type */
export interface CreateInviteResult {
  capability_descriptor: Json | null;
  capability_id: string | null;
  capability_mode: string | null;
  capability_public_key: string | null;
  capability_revocation: Json | null;
  created_at: Date;
  created_by: string;
  encrypted_membership_checkpoint_bundle: Json | null;
  encrypted_secret: Json | null;
  expires_at: Date;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  invite_id: string;
  max_uses: number;
  status: string;
  token: string;
  used_count: number;
}

/** 'CreateInvite' query type */
export interface CreateInviteQuery {
  params: CreateInviteParams;
  result: CreateInviteResult;
}

const createInviteIR: any = {"usedParamSet":{"inviteId":true,"token":true,"familyId":true,"createdBy":true,"expiresAt":true,"maxUses":true},"params":[{"name":"inviteId","required":false,"transform":{"type":"scalar"},"locs":[{"a":109,"b":117}]},{"name":"token","required":false,"transform":{"type":"scalar"},"locs":[{"a":122,"b":127}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":132,"b":140}]},{"name":"createdBy","required":false,"transform":{"type":"scalar"},"locs":[{"a":145,"b":154}]},{"name":"expiresAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":159,"b":168}]},{"name":"maxUses","required":false,"transform":{"type":"scalar"},"locs":[{"a":173,"b":180}]}],"statement":"INSERT INTO invites (\n  invite_id,\n  token,\n  family_id,\n  created_by,\n  expires_at,\n  max_uses\n) VALUES (\n  :inviteId,\n  :token,\n  :familyId,\n  :createdBy,\n  :expiresAt,\n  :maxUses\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO invites (
 *   invite_id,
 *   token,
 *   family_id,
 *   created_by,
 *   expires_at,
 *   max_uses
 * ) VALUES (
 *   :inviteId,
 *   :token,
 *   :familyId,
 *   :createdBy,
 *   :expiresAt,
 *   :maxUses
 * ) RETURNING *
 * ```
 */
export const createInvite = new PreparedQuery<CreateInviteParams,CreateInviteResult>(createInviteIR);


/** 'IncrementUsedCount' parameters type */
export interface IncrementUsedCountParams {
  familyId?: string | null | void;
  inviteId?: string | null | void;
}

/** 'IncrementUsedCount' return type */
export type IncrementUsedCountResult = void;

/** 'IncrementUsedCount' query type */
export interface IncrementUsedCountQuery {
  params: IncrementUsedCountParams;
  result: IncrementUsedCountResult;
}

const incrementUsedCountIR: any = {"usedParamSet":{"inviteId":true,"familyId":true},"params":[{"name":"inviteId","required":false,"transform":{"type":"scalar"},"locs":[{"a":65,"b":73}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":93,"b":101}]}],"statement":"UPDATE invites\nSET used_count = used_count + 1\nWHERE invite_id = :inviteId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE invites
 * SET used_count = used_count + 1
 * WHERE invite_id = :inviteId
 *   AND family_id = :familyId
 * ```
 */
export const incrementUsedCount = new PreparedQuery<IncrementUsedCountParams,IncrementUsedCountResult>(incrementUsedCountIR);


/** 'UpdateInviteStatus' parameters type */
export interface UpdateInviteStatusParams {
  familyId?: string | null | void;
  inviteId?: string | null | void;
  status?: string | null | void;
}

/** 'UpdateInviteStatus' return type */
export interface UpdateInviteStatusResult {
  capability_descriptor: Json | null;
  capability_id: string | null;
  capability_mode: string | null;
  capability_public_key: string | null;
  capability_revocation: Json | null;
  created_at: Date;
  created_by: string;
  encrypted_membership_checkpoint_bundle: Json | null;
  encrypted_secret: Json | null;
  expires_at: Date;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  invite_id: string;
  max_uses: number;
  status: string;
  token: string;
  used_count: number;
}

/** 'UpdateInviteStatus' query type */
export interface UpdateInviteStatusQuery {
  params: UpdateInviteStatusParams;
  result: UpdateInviteStatusResult;
}

const updateInviteStatusIR: any = {"usedParamSet":{"status":true,"inviteId":true,"familyId":true},"params":[{"name":"status","required":false,"transform":{"type":"scalar"},"locs":[{"a":28,"b":34}]},{"name":"inviteId","required":false,"transform":{"type":"scalar"},"locs":[{"a":54,"b":62}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":82,"b":90}]}],"statement":"UPDATE invites\nSET status = :status\nWHERE invite_id = :inviteId\n  AND family_id = :familyId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE invites
 * SET status = :status
 * WHERE invite_id = :inviteId
 *   AND family_id = :familyId
 * RETURNING *
 * ```
 */
export const updateInviteStatus = new PreparedQuery<UpdateInviteStatusParams,UpdateInviteStatusResult>(updateInviteStatusIR);


/** 'FindActiveInvites' parameters type */
export interface FindActiveInvitesParams {
  familyId?: string | null | void;
}

/** 'FindActiveInvites' return type */
export interface FindActiveInvitesResult {
  capability_descriptor: Json | null;
  capability_id: string | null;
  capability_mode: string | null;
  capability_public_key: string | null;
  capability_revocation: Json | null;
  created_at: Date;
  created_by: string;
  encrypted_membership_checkpoint_bundle: Json | null;
  encrypted_secret: Json | null;
  expires_at: Date;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  invite_id: string;
  max_uses: number;
  status: string;
  token: string;
  used_count: number;
}

/** 'FindActiveInvites' query type */
export interface FindActiveInvitesQuery {
  params: FindActiveInvitesParams;
  result: FindActiveInvitesResult;
}

const findActiveInvitesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":64,"b":72}]}],"statement":"SELECT * FROM invites\nWHERE status = 'active'\n  AND family_id = :familyId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM invites
 * WHERE status = 'active'
 *   AND family_id = :familyId
 * ORDER BY created_at DESC
 * ```
 */
export const findActiveInvites = new PreparedQuery<FindActiveInvitesParams,FindActiveInvitesResult>(findActiveInvitesIR);


/** 'FindAllInvites' parameters type */
export interface FindAllInvitesParams {
  familyId?: string | null | void;
}

/** 'FindAllInvites' return type */
export interface FindAllInvitesResult {
  capability_descriptor: Json | null;
  capability_id: string | null;
  capability_mode: string | null;
  capability_public_key: string | null;
  capability_revocation: Json | null;
  created_at: Date;
  created_by: string;
  encrypted_membership_checkpoint_bundle: Json | null;
  encrypted_secret: Json | null;
  expires_at: Date;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  invite_id: string;
  max_uses: number;
  status: string;
  token: string;
  used_count: number;
}

/** 'FindAllInvites' query type */
export interface FindAllInvitesQuery {
  params: FindAllInvitesParams;
  result: FindAllInvitesResult;
}

const findAllInvitesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":40,"b":48}]}],"statement":"SELECT * FROM invites\nWHERE family_id = :familyId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM invites
 * WHERE family_id = :familyId
 * ORDER BY created_at DESC
 * ```
 */
export const findAllInvites = new PreparedQuery<FindAllInvitesParams,FindAllInvitesResult>(findAllInvitesIR);


/** 'FindByCreator' parameters type */
export interface FindByCreatorParams {
  createdBy?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindByCreator' return type */
export interface FindByCreatorResult {
  capability_descriptor: Json | null;
  capability_id: string | null;
  capability_mode: string | null;
  capability_public_key: string | null;
  capability_revocation: Json | null;
  created_at: Date;
  created_by: string;
  encrypted_membership_checkpoint_bundle: Json | null;
  encrypted_secret: Json | null;
  expires_at: Date;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  invite_id: string;
  max_uses: number;
  status: string;
  token: string;
  used_count: number;
}

/** 'FindByCreator' query type */
export interface FindByCreatorQuery {
  params: FindByCreatorParams;
  result: FindByCreatorResult;
}

const findByCreatorIR: any = {"usedParamSet":{"createdBy":true,"familyId":true},"params":[{"name":"createdBy","required":false,"transform":{"type":"scalar"},"locs":[{"a":41,"b":50}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":70,"b":78}]}],"statement":"SELECT * FROM invites\nWHERE created_by = :createdBy\n  AND family_id = :familyId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM invites
 * WHERE created_by = :createdBy
 *   AND family_id = :familyId
 * ORDER BY created_at DESC
 * ```
 */
export const findByCreator = new PreparedQuery<FindByCreatorParams,FindByCreatorResult>(findByCreatorIR);


/** 'MarkExpiredInvites' parameters type */
export interface MarkExpiredInvitesParams {
  familyId?: string | null | void;
}

/** 'MarkExpiredInvites' return type */
export interface MarkExpiredInvitesResult {
  id: string;
}

/** 'MarkExpiredInvites' query type */
export interface MarkExpiredInvitesQuery {
  params: MarkExpiredInvitesParams;
  result: MarkExpiredInvitesResult;
}

const markExpiredInvitesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":104,"b":112}]}],"statement":"UPDATE invites\nSET status = 'expired'\nWHERE status = 'active' AND expires_at <= NOW()\n  AND family_id = :familyId\nRETURNING id"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE invites
 * SET status = 'expired'
 * WHERE status = 'active' AND expires_at <= NOW()
 *   AND family_id = :familyId
 * RETURNING id
 * ```
 */
export const markExpiredInvites = new PreparedQuery<MarkExpiredInvitesParams,MarkExpiredInvitesResult>(markExpiredInvitesIR);


/** 'CountInvites' parameters type */
export interface CountInvitesParams {
  familyId?: string | null | void;
}

/** 'CountInvites' return type */
export interface CountInvitesResult {
  count: string | null;
}

/** 'CountInvites' query type */
export interface CountInvitesQuery {
  params: CountInvitesParams;
  result: CountInvitesResult;
}

const countInvitesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":56,"b":64}]}],"statement":"SELECT COUNT(*) as count FROM invites\nWHERE family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT COUNT(*) as count FROM invites
 * WHERE family_id = :familyId
 * ```
 */
export const countInvites = new PreparedQuery<CountInvitesParams,CountInvitesResult>(countInvitesIR);


/** 'CountActiveInvites' parameters type */
export interface CountActiveInvitesParams {
  familyId?: string | null | void;
}

/** 'CountActiveInvites' return type */
export interface CountActiveInvitesResult {
  count: string | null;
}

/** 'CountActiveInvites' query type */
export interface CountActiveInvitesQuery {
  params: CountActiveInvitesParams;
  result: CountActiveInvitesResult;
}

const countActiveInvitesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":80,"b":88}]}],"statement":"SELECT COUNT(*) as count FROM invites\nWHERE status = 'active'\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT COUNT(*) as count FROM invites
 * WHERE status = 'active'
 *   AND family_id = :familyId
 * ```
 */
export const countActiveInvites = new PreparedQuery<CountActiveInvitesParams,CountActiveInvitesResult>(countActiveInvitesIR);


