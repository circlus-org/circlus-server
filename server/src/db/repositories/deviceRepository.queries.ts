/** Types generated for queries found in "src/db/repositories/deviceRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 'FindByDeviceId' parameters type */
export interface FindByDeviceIdParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindByDeviceId' return type */
export interface FindByDeviceIdResult {
  created_at: Date;
  device_id: string;
  encrypted_physical_device_id: Json | null;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  registration_attestation: Json | null;
  status: string;
  web_origin: string | null;
}

/** 'FindByDeviceId' query type */
export interface FindByDeviceIdQuery {
  params: FindByDeviceIdParams;
  result: FindByDeviceIdResult;
}

const findByDeviceIdIR: any = {"usedParamSet":{"deviceId":true,"familyId":true},"params":[{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":40,"b":48}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":68,"b":76}]}],"statement":"SELECT * FROM devices\nWHERE device_id = :deviceId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM devices
 * WHERE device_id = :deviceId
 *   AND family_id = :familyId
 * ```
 */
export const findByDeviceId = new PreparedQuery<FindByDeviceIdParams,FindByDeviceIdResult>(findByDeviceIdIR);


/** 'FindByPublicKey' parameters type */
export interface FindByPublicKeyParams {
  familyId?: string | null | void;
  publicKeyValue?: string | null | void;
}

/** 'FindByPublicKey' return type */
export interface FindByPublicKeyResult {
  created_at: Date;
  device_id: string;
  encrypted_physical_device_id: Json | null;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  registration_attestation: Json | null;
  status: string;
  web_origin: string | null;
}

/** 'FindByPublicKey' query type */
export interface FindByPublicKeyQuery {
  params: FindByPublicKeyParams;
  result: FindByPublicKeyResult;
}

const findByPublicKeyIR: any = {"usedParamSet":{"publicKeyValue":true,"familyId":true},"params":[{"name":"publicKeyValue","required":false,"transform":{"type":"scalar"},"locs":[{"a":47,"b":61}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":81,"b":89}]}],"statement":"SELECT * FROM devices\nWHERE public_key_value = :publicKeyValue\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM devices
 * WHERE public_key_value = :publicKeyValue
 *   AND family_id = :familyId
 * ```
 */
export const findByPublicKey = new PreparedQuery<FindByPublicKeyParams,FindByPublicKeyResult>(findByPublicKeyIR);


/** 'FindByIdentityId' parameters type */
export interface FindByIdentityIdParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'FindByIdentityId' return type */
export interface FindByIdentityIdResult {
  created_at: Date;
  device_id: string;
  encrypted_physical_device_id: Json | null;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  registration_attestation: Json | null;
  status: string;
  web_origin: string | null;
}

/** 'FindByIdentityId' query type */
export interface FindByIdentityIdQuery {
  params: FindByIdentityIdParams;
  result: FindByIdentityIdResult;
}

const findByIdentityIdIR: any = {"usedParamSet":{"identityId":true,"familyId":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":42,"b":52}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":72,"b":80}]}],"statement":"SELECT * FROM devices\nWHERE identity_id = :identityId\n  AND family_id = :familyId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM devices
 * WHERE identity_id = :identityId
 *   AND family_id = :familyId
 * ORDER BY created_at DESC
 * ```
 */
export const findByIdentityId = new PreparedQuery<FindByIdentityIdParams,FindByIdentityIdResult>(findByIdentityIdIR);


/** 'FindActiveByIdentityId' parameters type */
export interface FindActiveByIdentityIdParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'FindActiveByIdentityId' return type */
export interface FindActiveByIdentityIdResult {
  created_at: Date;
  device_id: string;
  encrypted_physical_device_id: Json | null;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  registration_attestation: Json | null;
  status: string;
  web_origin: string | null;
}

/** 'FindActiveByIdentityId' query type */
export interface FindActiveByIdentityIdQuery {
  params: FindActiveByIdentityIdParams;
  result: FindActiveByIdentityIdResult;
}

const findActiveByIdentityIdIR: any = {"usedParamSet":{"identityId":true,"familyId":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":42,"b":52}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":94,"b":102}]}],"statement":"SELECT * FROM devices\nWHERE identity_id = :identityId AND status = 'active'\n  AND family_id = :familyId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM devices
 * WHERE identity_id = :identityId AND status = 'active'
 *   AND family_id = :familyId
 * ORDER BY created_at DESC
 * ```
 */
export const findActiveByIdentityId = new PreparedQuery<FindActiveByIdentityIdParams,FindActiveByIdentityIdResult>(findActiveByIdentityIdIR);



/** 'UpdateStatus' parameters type */
export interface UpdateStatusParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
  status?: string | null | void;
}

/** 'UpdateStatus' return type */
export interface UpdateStatusResult {
  created_at: Date;
  device_id: string;
  encrypted_physical_device_id: Json | null;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  registration_attestation: Json | null;
  status: string;
  web_origin: string | null;
}

/** 'UpdateStatus' query type */
export interface UpdateStatusQuery {
  params: UpdateStatusParams;
  result: UpdateStatusResult;
}

const updateStatusIR: any = {"usedParamSet":{"status":true,"deviceId":true,"familyId":true},"params":[{"name":"status","required":false,"transform":{"type":"scalar"},"locs":[{"a":28,"b":34}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":54,"b":62}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":82,"b":90}]}],"statement":"UPDATE devices\nSET status = :status\nWHERE device_id = :deviceId\n  AND family_id = :familyId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE devices
 * SET status = :status
 * WHERE device_id = :deviceId
 *   AND family_id = :familyId
 * RETURNING *
 * ```
 */
export const updateStatus = new PreparedQuery<UpdateStatusParams,UpdateStatusResult>(updateStatusIR);


/** 'UpdateLastSeen' parameters type */
export interface UpdateLastSeenParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
  webOrigin?: string | null | void;
}

/** 'UpdateLastSeen' return type */
export type UpdateLastSeenResult = void;

/** 'UpdateLastSeen' query type */
export interface UpdateLastSeenQuery {
  params: UpdateLastSeenParams;
  result: UpdateLastSeenResult;
}

const updateLastSeenIR: any = {"usedParamSet":{"webOrigin":true,"deviceId":true,"familyId":true},"params":[{"name":"webOrigin","required":false,"transform":{"type":"scalar"},"locs":[{"a":67,"b":76}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":109,"b":117}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":137,"b":145}]}],"statement":"UPDATE devices\nSET last_seen_at = NOW(),\n    web_origin = COALESCE(:webOrigin, web_origin)\nWHERE device_id = :deviceId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE devices
 * SET last_seen_at = NOW(),
 *     web_origin = COALESCE(:webOrigin, web_origin)
 * WHERE device_id = :deviceId
 *   AND family_id = :familyId
 * ```
 */
export const updateLastSeen = new PreparedQuery<UpdateLastSeenParams,UpdateLastSeenResult>(updateLastSeenIR);


/** 'CountByIdentityId' parameters type */
export interface CountByIdentityIdParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'CountByIdentityId' return type */
export interface CountByIdentityIdResult {
  count: string | null;
}

/** 'CountByIdentityId' query type */
export interface CountByIdentityIdQuery {
  params: CountByIdentityIdParams;
  result: CountByIdentityIdResult;
}

const countByIdentityIdIR: any = {"usedParamSet":{"identityId":true,"familyId":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":58,"b":68}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":88,"b":96}]}],"statement":"SELECT COUNT(*) as count FROM devices\nWHERE identity_id = :identityId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT COUNT(*) as count FROM devices
 * WHERE identity_id = :identityId
 *   AND family_id = :familyId
 * ```
 */
export const countByIdentityId = new PreparedQuery<CountByIdentityIdParams,CountByIdentityIdResult>(countByIdentityIdIR);


/** 'CountDevices' parameters type */
export interface CountDevicesParams {
  familyId?: string | null | void;
}

/** 'CountDevices' return type */
export interface CountDevicesResult {
  count: string | null;
}

/** 'CountDevices' query type */
export interface CountDevicesQuery {
  params: CountDevicesParams;
  result: CountDevicesResult;
}

const countDevicesIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":56,"b":64}]}],"statement":"SELECT COUNT(*) as count FROM devices\nWHERE family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT COUNT(*) as count FROM devices
 * WHERE family_id = :familyId
 * ```
 */
export const countDevices = new PreparedQuery<CountDevicesParams,CountDevicesResult>(countDevicesIR);


/** 'CountActiveSince' parameters type */
export interface CountActiveSinceParams {
  familyId?: string | null | void;
  since?: DateOrString | null | void;
}

/** 'CountActiveSince' return type */
export interface CountActiveSinceResult {
  count: string | null;
}

/** 'CountActiveSince' query type */
export interface CountActiveSinceQuery {
  params: CountActiveSinceParams;
  result: CountActiveSinceResult;
}

const countActiveSinceIR: any = {"usedParamSet":{"since":true,"familyId":true},"params":[{"name":"since","required":false,"transform":{"type":"scalar"},"locs":[{"a":82,"b":87}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":107,"b":115}]}],"statement":"SELECT COUNT(*) as count FROM devices\nWHERE status = 'active' AND last_seen_at >= :since\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT COUNT(*) as count FROM devices
 * WHERE status = 'active' AND last_seen_at >= :since
 *   AND family_id = :familyId
 * ```
 */
export const countActiveSince = new PreparedQuery<CountActiveSinceParams,CountActiveSinceResult>(countActiveSinceIR);

