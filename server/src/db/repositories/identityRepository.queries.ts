/** Types generated for queries found in "src/db/repositories/identityRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 'FindByIdentityId' parameters type */
export interface FindByIdentityIdParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'FindByIdentityId' return type */
export interface FindByIdentityIdResult {
  /** Opaque blob ID of the client-encrypted Circle avatar */
  avatar_blob_id: string | null;
  /** Timestamp when avatar was last changed */
  avatar_updated_at: Date | null;
  can_create_guest_invites: boolean;
  can_create_invites: boolean;
  created_at: Date;
  encrypted_private_key: Json | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  identity_name: string | null;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  /** Timestamp when status was last updated */
}

/** 'FindByIdentityId' query type */
export interface FindByIdentityIdQuery {
  params: FindByIdentityIdParams;
  result: FindByIdentityIdResult;
}

const findByIdentityIdIR: any = {"usedParamSet":{"identityId":true,"familyId":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":45,"b":55}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":75,"b":83}]}],"statement":"SELECT * FROM identities\nWHERE identity_id = :identityId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM identities
 * WHERE identity_id = :identityId
 *   AND family_id = :familyId
 * ```
 */
export const findByIdentityId = new PreparedQuery<FindByIdentityIdParams,FindByIdentityIdResult>(findByIdentityIdIR);


/** 'FindByPublicKey' parameters type */
export interface FindByPublicKeyParams {
  familyId?: string | null | void;
  publicKeyValue?: string | null | void;
}

/** 'FindByPublicKey' return type */
export interface FindByPublicKeyResult {
  can_create_guest_invites: boolean;
  can_create_invites: boolean;
  /** Opaque blob ID of the client-encrypted Circle avatar */
  avatar_blob_id: string | null;
  /** Timestamp when avatar was last changed */
  avatar_updated_at: Date | null;
  created_at: Date;
  encrypted_private_key: Json | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  identity_name: string | null;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  /** Timestamp when status was last updated */
}

/** 'FindByPublicKey' query type */
export interface FindByPublicKeyQuery {
  params: FindByPublicKeyParams;
  result: FindByPublicKeyResult;
}

const findByPublicKeyIR: any = {"usedParamSet":{"publicKeyValue":true,"familyId":true},"params":[{"name":"publicKeyValue","required":false,"transform":{"type":"scalar"},"locs":[{"a":50,"b":64}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":84,"b":92}]}],"statement":"SELECT * FROM identities\nWHERE public_key_value = :publicKeyValue\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM identities
 * WHERE public_key_value = :publicKeyValue
 *   AND family_id = :familyId
 * ```
 */
export const findByPublicKey = new PreparedQuery<FindByPublicKeyParams,FindByPublicKeyResult>(findByPublicKeyIR);


/** 'UpdateStatus' parameters type */
export interface UpdateStatusParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
  status?: string | null | void;
}

/** 'UpdateStatus' return type */
export interface UpdateStatusResult {
  can_create_guest_invites: boolean;
  can_create_invites: boolean;
  /** Opaque blob ID of the client-encrypted Circle avatar */
  avatar_blob_id: string | null;
  /** Timestamp when avatar was last changed */
  avatar_updated_at: Date | null;
  created_at: Date;
  encrypted_private_key: Json | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  identity_name: string | null;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  /** Timestamp when status was last updated */
}

/** 'UpdateStatus' query type */
export interface UpdateStatusQuery {
  params: UpdateStatusParams;
  result: UpdateStatusResult;
}

const updateStatusIR: any = {"usedParamSet":{"status":true,"identityId":true,"familyId":true},"params":[{"name":"status","required":false,"transform":{"type":"scalar"},"locs":[{"a":31,"b":37}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":59,"b":69}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":89,"b":97}]}],"statement":"UPDATE identities\nSET status = :status\nWHERE identity_id = :identityId\n  AND family_id = :familyId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE identities
 * SET status = :status
 * WHERE identity_id = :identityId
 *   AND family_id = :familyId
 * RETURNING *
 * ```
 */
export const updateStatus = new PreparedQuery<UpdateStatusParams,UpdateStatusResult>(updateStatusIR);


/** 'CountIdentities' parameters type */
export interface CountIdentitiesParams {
  familyId?: string | null | void;
}

/** 'CountIdentities' return type */
export interface CountIdentitiesResult {
  count: string | null;
}

/** 'CountIdentities' query type */
export interface CountIdentitiesQuery {
  params: CountIdentitiesParams;
  result: CountIdentitiesResult;
}

const countIdentitiesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":59,"b":67}]}],"statement":"SELECT COUNT(*) as count FROM identities\nWHERE family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT COUNT(*) as count FROM identities
 * WHERE family_id = :familyId
 * ```
 */
export const countIdentities = new PreparedQuery<CountIdentitiesParams,CountIdentitiesResult>(countIdentitiesIR);


/** 'FindByStatus' parameters type */
export interface FindByStatusParams {
  familyId?: string | null | void;
  status?: string | null | void;
}

/** 'FindByStatus' return type */
export interface FindByStatusResult {
  can_create_guest_invites: boolean;
  can_create_invites: boolean;
  /** Opaque blob ID of the client-encrypted Circle avatar */
  avatar_blob_id: string | null;
  /** Timestamp when avatar was last changed */
  avatar_updated_at: Date | null;
  created_at: Date;
  encrypted_private_key: Json | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  identity_name: string | null;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  /** Timestamp when status was last updated */
}

/** 'FindByStatus' query type */
export interface FindByStatusQuery {
  params: FindByStatusParams;
  result: FindByStatusResult;
}

const findByStatusIR: any = {"usedParamSet":{"status":true,"familyId":true},"params":[{"name":"status","required":false,"transform":{"type":"scalar"},"locs":[{"a":40,"b":46}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":66,"b":74}]}],"statement":"SELECT * FROM identities\nWHERE status = :status\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM identities
 * WHERE status = :status
 *   AND family_id = :familyId
 * ```
 */
export const findByStatus = new PreparedQuery<FindByStatusParams,FindByStatusResult>(findByStatusIR);


/** 'FindByRole' parameters type */
export interface FindByRoleParams {
  familyId?: string | null | void;
  role?: string | null | void;
}

/** 'FindByRole' return type */
export interface FindByRoleResult {
  can_create_guest_invites: boolean;
  can_create_invites: boolean;
  /** Opaque blob ID of the client-encrypted Circle avatar */
  avatar_blob_id: string | null;
  /** Timestamp when avatar was last changed */
  avatar_updated_at: Date | null;
  created_at: Date;
  encrypted_private_key: Json | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  identity_name: string | null;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  /** Timestamp when status was last updated */
}

/** 'FindByRole' query type */
export interface FindByRoleQuery {
  params: FindByRoleParams;
  result: FindByRoleResult;
}

const findByRoleIR: any = {"usedParamSet":{"role":true,"familyId":true},"params":[{"name":"role","required":false,"transform":{"type":"scalar"},"locs":[{"a":38,"b":42}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":62,"b":70}]}],"statement":"SELECT * FROM identities\nWHERE role = :role\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM identities
 * WHERE role = :role
 *   AND family_id = :familyId
 * ```
 */
export const findByRole = new PreparedQuery<FindByRoleParams,FindByRoleResult>(findByRoleIR);


/** 'FindAllIdentities' parameters type */
export interface FindAllIdentitiesParams {
  familyId?: string | null | void;
}

/** 'FindAllIdentities' return type */
export interface FindAllIdentitiesResult {
  can_create_guest_invites: boolean;
  can_create_invites: boolean;
  /** Opaque blob ID of the client-encrypted Circle avatar */
  avatar_blob_id: string | null;
  /** Timestamp when avatar was last changed */
  avatar_updated_at: Date | null;
  created_at: Date;
  encrypted_private_key: Json | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  identity_name: string | null;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  /** Timestamp when status was last updated */
}

/** 'FindAllIdentities' query type */
export interface FindAllIdentitiesQuery {
  params: FindAllIdentitiesParams;
  result: FindAllIdentitiesResult;
}

const findAllIdentitiesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":43,"b":51}]}],"statement":"SELECT * FROM identities\nWHERE family_id = :familyId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM identities
 * WHERE family_id = :familyId
 * ORDER BY created_at DESC
 * ```
 */
export const findAllIdentities = new PreparedQuery<FindAllIdentitiesParams,FindAllIdentitiesResult>(findAllIdentitiesIR);


/** 'FindActiveIdentities' parameters type */
export interface FindActiveIdentitiesParams {
  familyId?: string | null | void;
}

/** 'FindActiveIdentities' return type */
export interface FindActiveIdentitiesResult {
  /** Opaque blob ID of the client-encrypted Circle avatar */
  avatar_blob_id: string | null;
  /** Timestamp when avatar was last changed */
  avatar_updated_at: Date | null;
  created_at: Date;
  encrypted_private_key: Json | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  identity_name: string | null;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  /** Timestamp when status was last updated */
}

/** 'FindActiveIdentities' query type */
export interface FindActiveIdentitiesQuery {
  params: FindActiveIdentitiesParams;
  result: FindActiveIdentitiesResult;
}

const findActiveIdentitiesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":67,"b":75}]}],"statement":"SELECT * FROM identities\nWHERE status = 'active'\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM identities
 * WHERE status = 'active'
 *   AND family_id = :familyId
 * ```
 */
export const findActiveIdentities = new PreparedQuery<FindActiveIdentitiesParams,FindActiveIdentitiesResult>(findActiveIdentitiesIR);
