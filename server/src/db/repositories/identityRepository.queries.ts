/** Types generated for queries found in "src/db/repositories/identityRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type stringArray = (string)[];

/** 'FindByIdentityId' parameters type */
export interface FindByIdentityIdParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'FindByIdentityId' return type */
export interface FindByIdentityIdResult {
  /** Blob ID of the avatar image (stored unencrypted, publicly readable) */
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
  invite_quota: number;
  invite_used: number;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
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
  /** Blob ID of the avatar image (stored unencrypted, publicly readable) */
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
  invite_quota: number;
  invite_used: number;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
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


/** 'CreateIdentity' parameters type */
export interface CreateIdentityParams {
  encryptedPrivateKey?: Json | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  identityName?: string | null | void;
  publicKeyAlgorithm?: string | null | void;
  publicKeyValue?: string | null | void;
  publishIdentity?: boolean | null | void;
  role?: string | null | void;
}

/** 'CreateIdentity' return type */
export interface CreateIdentityResult {
  can_create_guest_invites: boolean;
  can_create_invites: boolean;
  /** Blob ID of the avatar image (stored unencrypted, publicly readable) */
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
  invite_quota: number;
  invite_used: number;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
}

/** 'CreateIdentity' query type */
export interface CreateIdentityQuery {
  params: CreateIdentityParams;
  result: CreateIdentityResult;
}

const createIdentityIR: any = {"usedParamSet":{"identityId":true,"familyId":true,"publicKeyAlgorithm":true,"publicKeyValue":true,"encryptedPrivateKey":true,"role":true,"publishIdentity":true,"identityName":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":179,"b":189}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":194,"b":202}]},{"name":"publicKeyAlgorithm","required":false,"transform":{"type":"scalar"},"locs":[{"a":207,"b":225}]},{"name":"publicKeyValue","required":false,"transform":{"type":"scalar"},"locs":[{"a":230,"b":244}]},{"name":"encryptedPrivateKey","required":false,"transform":{"type":"scalar"},"locs":[{"a":249,"b":268}]},{"name":"role","required":false,"transform":{"type":"scalar"},"locs":[{"a":280,"b":284}]},{"name":"publishIdentity","required":false,"transform":{"type":"scalar"},"locs":[{"a":289,"b":304}]},{"name":"identityName","required":false,"transform":{"type":"scalar"},"locs":[{"a":309,"b":321}]}],"statement":"INSERT INTO identities (\n  identity_id,\n  family_id,\n  public_key_algorithm,\n  public_key_value,\n  encrypted_private_key,\n  role,\n  publish_identity,\n  identity_name\n) VALUES (\n  :identityId,\n  :familyId,\n  :publicKeyAlgorithm,\n  :publicKeyValue,\n  :encryptedPrivateKey::jsonb,\n  :role,\n  :publishIdentity,\n  :identityName\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO identities (
 *   identity_id,
 *   family_id,
 *   public_key_algorithm,
 *   public_key_value,
 *   encrypted_private_key,
 *   role,
 *   publish_identity,
 *   identity_name
 * ) VALUES (
 *   :identityId,
 *   :familyId,
 *   :publicKeyAlgorithm,
 *   :publicKeyValue,
 *   :encryptedPrivateKey::jsonb,
 *   :role,
 *   :publishIdentity,
 *   :identityName
 * ) RETURNING *
 * ```
 */
export const createIdentity = new PreparedQuery<CreateIdentityParams,CreateIdentityResult>(createIdentityIR);


/** 'FindPublishedIdentities' parameters type */
export interface FindPublishedIdentitiesParams {
  familyId?: string | null | void;
}

/** 'FindPublishedIdentities' return type */
export interface FindPublishedIdentitiesResult {
  identity_id: string;
  identity_name: string | null;
  public_key_algorithm: string;
  public_key_value: string;
}

/** 'FindPublishedIdentities' query type */
export interface FindPublishedIdentitiesQuery {
  params: FindPublishedIdentitiesParams;
  result: FindPublishedIdentitiesResult;
}

const findPublishedIdentitiesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":108,"b":116}]}],"statement":"SELECT identity_id, public_key_algorithm, public_key_value, identity_name\nFROM identities\nWHERE family_id = :familyId\n  AND publish_identity = true\n  AND status = 'active'\n  AND COALESCE(role, '') <> 'guest'"};

/**
 * Query generated from SQL:
 * ```
 * SELECT identity_id, public_key_algorithm, public_key_value, identity_name
 * FROM identities
 * WHERE family_id = :familyId
 *   AND publish_identity = true
 *   AND status = 'active'
 *   AND COALESCE(role, '') <> 'guest'
 * ```
 */
export const findPublishedIdentities = new PreparedQuery<FindPublishedIdentitiesParams,FindPublishedIdentitiesResult>(findPublishedIdentitiesIR);


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
  /** Blob ID of the avatar image (stored unencrypted, publicly readable) */
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
  invite_quota: number;
  invite_used: number;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
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


/** 'UpdateRole' parameters type */
export interface UpdateRoleParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
  role?: string | null | void;
}

/** 'UpdateRole' return type */
export interface UpdateRoleResult {
  can_create_guest_invites: boolean;
  can_create_invites: boolean;
  /** Blob ID of the avatar image (stored unencrypted, publicly readable) */
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
  invite_quota: number;
  invite_used: number;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
}

/** 'UpdateRole' query type */
export interface UpdateRoleQuery {
  params: UpdateRoleParams;
  result: UpdateRoleResult;
}

const updateRoleIR: any = {"usedParamSet":{"role":true,"identityId":true,"familyId":true},"params":[{"name":"role","required":false,"transform":{"type":"scalar"},"locs":[{"a":29,"b":33}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":55,"b":65}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":85,"b":93}]}],"statement":"UPDATE identities\nSET role = :role\nWHERE identity_id = :identityId\n  AND family_id = :familyId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE identities
 * SET role = :role
 * WHERE identity_id = :identityId
 *   AND family_id = :familyId
 * RETURNING *
 * ```
 */
export const updateRole = new PreparedQuery<UpdateRoleParams,UpdateRoleResult>(updateRoleIR);


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
  /** Blob ID of the avatar image (stored unencrypted, publicly readable) */
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
  invite_quota: number;
  invite_used: number;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
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
  /** Blob ID of the avatar image (stored unencrypted, publicly readable) */
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
  invite_quota: number;
  invite_used: number;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
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
  /** Blob ID of the avatar image (stored unencrypted, publicly readable) */
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
  invite_quota: number;
  invite_used: number;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
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


/** 'UpdateStatusText' parameters type */
export interface UpdateStatusTextParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
  statusText?: string | null | void;
}

/** 'UpdateStatusText' return type */
export type UpdateStatusTextResult = void;

/** 'UpdateStatusText' query type */
export interface UpdateStatusTextQuery {
  params: UpdateStatusTextParams;
  result: UpdateStatusTextResult;
}

const updateStatusTextIR: any = {"usedParamSet":{"statusText":true,"identityId":true,"familyId":true},"params":[{"name":"statusText","required":false,"transform":{"type":"scalar"},"locs":[{"a":36,"b":46}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":99,"b":109}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":129,"b":137}]}],"statement":"UPDATE identities\nSET status_text = :statusText,\n    status_updated_at = NOW()\nWHERE identity_id = :identityId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE identities
 * SET status_text = :statusText,
 *     status_updated_at = NOW()
 * WHERE identity_id = :identityId
 *   AND family_id = :familyId
 * ```
 */
export const updateStatusText = new PreparedQuery<UpdateStatusTextParams,UpdateStatusTextResult>(updateStatusTextIR);


/** 'GetStatuses' parameters type */
export interface GetStatusesParams {
  familyId?: string | null | void;
  identityIds?: stringArray | null | void;
}

/** 'GetStatuses' return type */
export interface GetStatusesResult {
  identity_id: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
}

/** 'GetStatuses' query type */
export interface GetStatusesQuery {
  params: GetStatusesParams;
  result: GetStatusesResult;
}

const getStatusesIR: any = {"usedParamSet":{"identityIds":true,"familyId":true},"params":[{"name":"identityIds","required":false,"transform":{"type":"scalar"},"locs":[{"a":91,"b":102}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":123,"b":131}]}],"statement":"SELECT identity_id, status_text, status_updated_at\nFROM identities\nWHERE identity_id = ANY(:identityIds)\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT identity_id, status_text, status_updated_at
 * FROM identities
 * WHERE identity_id = ANY(:identityIds)
 *   AND family_id = :familyId
 * ```
 */
export const getStatuses = new PreparedQuery<GetStatusesParams,GetStatusesResult>(getStatusesIR);


/** 'FindActiveIdentities' parameters type */
export interface FindActiveIdentitiesParams {
  familyId?: string | null | void;
}

/** 'FindActiveIdentities' return type */
export interface FindActiveIdentitiesResult {
  /** Blob ID of the avatar image (stored unencrypted, publicly readable) */
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
  invite_quota: number;
  invite_used: number;
  /** Whether this identity shares online/last-seen presence in this circle */
  presence_visible: boolean;
  public_key_algorithm: string;
  public_key_value: string;
  publish_identity: boolean;
  role: string | null;
  status: string;
  /** User-defined text status (max 280 chars, like Twitter) */
  status_text: string | null;
  /** Timestamp when status was last updated */
  status_updated_at: Date | null;
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
