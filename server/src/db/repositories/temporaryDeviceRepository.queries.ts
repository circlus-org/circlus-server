/** Types generated for queries found in "src/db/repositories/temporaryDeviceRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

/** 'FindTemporaryDeviceByDeviceId' parameters type */
export interface FindTemporaryDeviceByDeviceIdParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindTemporaryDeviceByDeviceId' return type */
export interface FindTemporaryDeviceByDeviceIdResult {
  approval_attestation_payload: string | null;
  approval_attestation_signature: string | null;
  approved_by_device_id: string;
  approving_device_public_key: string | null;
  created_at: Date;
  device_id: string;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  status: string;
}

/** 'FindTemporaryDeviceByDeviceId' query type */
export interface FindTemporaryDeviceByDeviceIdQuery {
  params: FindTemporaryDeviceByDeviceIdParams;
  result: FindTemporaryDeviceByDeviceIdResult;
}

const findTemporaryDeviceByDeviceIdIR: any = {"usedParamSet":{"familyId":true,"deviceId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":50,"b":58}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":78,"b":86}]}],"statement":"SELECT *\nFROM temporary_devices\nWHERE family_id = :familyId\n  AND device_id = :deviceId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM temporary_devices
 * WHERE family_id = :familyId
 *   AND device_id = :deviceId
 * LIMIT 1
 * ```
 */
export const findTemporaryDeviceByDeviceId = new PreparedQuery<FindTemporaryDeviceByDeviceIdParams,FindTemporaryDeviceByDeviceIdResult>(findTemporaryDeviceByDeviceIdIR);


/** 'FindTemporaryDeviceByDeviceIdAnyFamily' parameters type */
export interface FindTemporaryDeviceByDeviceIdAnyFamilyParams {
  deviceId?: string | null | void;
}

/** 'FindTemporaryDeviceByDeviceIdAnyFamily' return type */
export interface FindTemporaryDeviceByDeviceIdAnyFamilyResult {
  approval_attestation_payload: string | null;
  approval_attestation_signature: string | null;
  approved_by_device_id: string;
  approving_device_public_key: string | null;
  created_at: Date;
  device_id: string;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  status: string;
}

/** 'FindTemporaryDeviceByDeviceIdAnyFamily' query type */
export interface FindTemporaryDeviceByDeviceIdAnyFamilyQuery {
  params: FindTemporaryDeviceByDeviceIdAnyFamilyParams;
  result: FindTemporaryDeviceByDeviceIdAnyFamilyResult;
}

const findTemporaryDeviceByDeviceIdAnyFamilyIR: any = {"usedParamSet":{"deviceId":true},"params":[{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":50,"b":58}]}],"statement":"SELECT *\nFROM temporary_devices\nWHERE device_id = :deviceId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM temporary_devices
 * WHERE device_id = :deviceId
 * LIMIT 1
 * ```
 */
export const findTemporaryDeviceByDeviceIdAnyFamily = new PreparedQuery<FindTemporaryDeviceByDeviceIdAnyFamilyParams,FindTemporaryDeviceByDeviceIdAnyFamilyResult>(findTemporaryDeviceByDeviceIdAnyFamilyIR);


/** 'FindTemporaryDeviceByPublicKey' parameters type */
export interface FindTemporaryDeviceByPublicKeyParams {
  familyId?: string | null | void;
  publicKeyValue?: string | null | void;
}

/** 'FindTemporaryDeviceByPublicKey' return type */
export interface FindTemporaryDeviceByPublicKeyResult {
  approval_attestation_payload: string | null;
  approval_attestation_signature: string | null;
  approved_by_device_id: string;
  approving_device_public_key: string | null;
  created_at: Date;
  device_id: string;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  status: string;
}

/** 'FindTemporaryDeviceByPublicKey' query type */
export interface FindTemporaryDeviceByPublicKeyQuery {
  params: FindTemporaryDeviceByPublicKeyParams;
  result: FindTemporaryDeviceByPublicKeyResult;
}

const findTemporaryDeviceByPublicKeyIR: any = {"usedParamSet":{"familyId":true,"publicKeyValue":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":50,"b":58}]},{"name":"publicKeyValue","required":false,"transform":{"type":"scalar"},"locs":[{"a":85,"b":99}]}],"statement":"SELECT *\nFROM temporary_devices\nWHERE family_id = :familyId\n  AND public_key_value = :publicKeyValue\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM temporary_devices
 * WHERE family_id = :familyId
 *   AND public_key_value = :publicKeyValue
 * LIMIT 1
 * ```
 */
export const findTemporaryDeviceByPublicKey = new PreparedQuery<FindTemporaryDeviceByPublicKeyParams,FindTemporaryDeviceByPublicKeyResult>(findTemporaryDeviceByPublicKeyIR);


/** 'FindTemporaryDevicesByIdentityId' parameters type */
export interface FindTemporaryDevicesByIdentityIdParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'FindTemporaryDevicesByIdentityId' return type */
export interface FindTemporaryDevicesByIdentityIdResult {
  approval_attestation_payload: string | null;
  approval_attestation_signature: string | null;
  approved_by_device_id: string;
  approving_device_public_key: string | null;
  created_at: Date;
  device_id: string;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  status: string;
}

/** 'FindTemporaryDevicesByIdentityId' query type */
export interface FindTemporaryDevicesByIdentityIdQuery {
  params: FindTemporaryDevicesByIdentityIdParams;
  result: FindTemporaryDevicesByIdentityIdResult;
}

const findTemporaryDevicesByIdentityIdIR: any = {"usedParamSet":{"familyId":true,"identityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":50,"b":58}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":80,"b":90}]}],"statement":"SELECT *\nFROM temporary_devices\nWHERE family_id = :familyId\n  AND identity_id = :identityId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM temporary_devices
 * WHERE family_id = :familyId
 *   AND identity_id = :identityId
 * ORDER BY created_at DESC
 * ```
 */
export const findTemporaryDevicesByIdentityId = new PreparedQuery<FindTemporaryDevicesByIdentityIdParams,FindTemporaryDevicesByIdentityIdResult>(findTemporaryDevicesByIdentityIdIR);


/** 'CreateOrRefreshTemporaryDevice' parameters type */
export interface CreateOrRefreshTemporaryDeviceParams {
  approvedByDeviceId?: string | null | void;
  deviceId?: string | null | void;
  encryptionPublicKeyAlgorithm?: string | null | void;
  encryptionPublicKeyValue?: string | null | void;
  expiresAt?: DateOrString | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  publicKeyAlgorithm?: string | null | void;
  publicKeyValue?: string | null | void;
}

/** 'CreateOrRefreshTemporaryDevice' return type */
export interface CreateOrRefreshTemporaryDeviceResult {
  approval_attestation_payload: string | null;
  approval_attestation_signature: string | null;
  approved_by_device_id: string;
  approving_device_public_key: string | null;
  created_at: Date;
  device_id: string;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  status: string;
}

/** 'CreateOrRefreshTemporaryDevice' query type */
export interface CreateOrRefreshTemporaryDeviceQuery {
  params: CreateOrRefreshTemporaryDeviceParams;
  result: CreateOrRefreshTemporaryDeviceResult;
}

const createOrRefreshTemporaryDeviceIR: any = {"usedParamSet":{"deviceId":true,"identityId":true,"familyId":true,"publicKeyAlgorithm":true,"publicKeyValue":true,"encryptionPublicKeyAlgorithm":true,"encryptionPublicKeyValue":true,"approvedByDeviceId":true,"expiresAt":true},"params":[{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":234,"b":242}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":247,"b":257}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":262,"b":270}]},{"name":"publicKeyAlgorithm","required":false,"transform":{"type":"scalar"},"locs":[{"a":275,"b":293}]},{"name":"publicKeyValue","required":false,"transform":{"type":"scalar"},"locs":[{"a":298,"b":312}]},{"name":"encryptionPublicKeyAlgorithm","required":false,"transform":{"type":"scalar"},"locs":[{"a":317,"b":345}]},{"name":"encryptionPublicKeyValue","required":false,"transform":{"type":"scalar"},"locs":[{"a":350,"b":374}]},{"name":"approvedByDeviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":379,"b":397}]},{"name":"expiresAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":402,"b":411}]}],"statement":"INSERT INTO temporary_devices (\n  device_id,\n  identity_id,\n  family_id,\n  public_key_algorithm,\n  public_key_value,\n  encryption_public_key_algorithm,\n  encryption_public_key_value,\n  approved_by_device_id,\n  expires_at\n) VALUES (\n  :deviceId,\n  :identityId,\n  :familyId,\n  :publicKeyAlgorithm,\n  :publicKeyValue,\n  :encryptionPublicKeyAlgorithm,\n  :encryptionPublicKeyValue,\n  :approvedByDeviceId,\n  :expiresAt\n)\nON CONFLICT (device_id) DO UPDATE\nSET identity_id = EXCLUDED.identity_id,\n    family_id = EXCLUDED.family_id,\n    public_key_algorithm = EXCLUDED.public_key_algorithm,\n    public_key_value = EXCLUDED.public_key_value,\n    encryption_public_key_algorithm = EXCLUDED.encryption_public_key_algorithm,\n    encryption_public_key_value = EXCLUDED.encryption_public_key_value,\n    approved_by_device_id = EXCLUDED.approved_by_device_id,\n    expires_at = EXCLUDED.expires_at,\n    status = 'active'\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO temporary_devices (
 *   device_id,
 *   identity_id,
 *   family_id,
 *   public_key_algorithm,
 *   public_key_value,
 *   encryption_public_key_algorithm,
 *   encryption_public_key_value,
 *   approved_by_device_id,
 *   expires_at
 * ) VALUES (
 *   :deviceId,
 *   :identityId,
 *   :familyId,
 *   :publicKeyAlgorithm,
 *   :publicKeyValue,
 *   :encryptionPublicKeyAlgorithm,
 *   :encryptionPublicKeyValue,
 *   :approvedByDeviceId,
 *   :expiresAt
 * )
 * ON CONFLICT (device_id) DO UPDATE
 * SET identity_id = EXCLUDED.identity_id,
 *     family_id = EXCLUDED.family_id,
 *     public_key_algorithm = EXCLUDED.public_key_algorithm,
 *     public_key_value = EXCLUDED.public_key_value,
 *     encryption_public_key_algorithm = EXCLUDED.encryption_public_key_algorithm,
 *     encryption_public_key_value = EXCLUDED.encryption_public_key_value,
 *     approved_by_device_id = EXCLUDED.approved_by_device_id,
 *     expires_at = EXCLUDED.expires_at,
 *     status = 'active'
 * RETURNING *
 * ```
 */
export const createOrRefreshTemporaryDevice = new PreparedQuery<CreateOrRefreshTemporaryDeviceParams,CreateOrRefreshTemporaryDeviceResult>(createOrRefreshTemporaryDeviceIR);


/** 'UpdateTemporaryDeviceLastSeen' parameters type */
export interface UpdateTemporaryDeviceLastSeenParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'UpdateTemporaryDeviceLastSeen' return type */
export type UpdateTemporaryDeviceLastSeenResult = void;

/** 'UpdateTemporaryDeviceLastSeen' query type */
export interface UpdateTemporaryDeviceLastSeenQuery {
  params: UpdateTemporaryDeviceLastSeenParams;
  result: UpdateTemporaryDeviceLastSeenResult;
}

const updateTemporaryDeviceLastSeenIR: any = {"usedParamSet":{"familyId":true,"deviceId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":68,"b":76}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":96,"b":104}]}],"statement":"UPDATE temporary_devices\nSET last_seen_at = NOW()\nWHERE family_id = :familyId\n  AND device_id = :deviceId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE temporary_devices
 * SET last_seen_at = NOW()
 * WHERE family_id = :familyId
 *   AND device_id = :deviceId
 * ```
 */
export const updateTemporaryDeviceLastSeen = new PreparedQuery<UpdateTemporaryDeviceLastSeenParams,UpdateTemporaryDeviceLastSeenResult>(updateTemporaryDeviceLastSeenIR);


/** 'UpdateTemporaryDeviceStatus' parameters type */
export interface UpdateTemporaryDeviceStatusParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
  status?: string | null | void;
}

/** 'UpdateTemporaryDeviceStatus' return type */
export interface UpdateTemporaryDeviceStatusResult {
  approval_attestation_payload: string | null;
  approval_attestation_signature: string | null;
  approved_by_device_id: string;
  approving_device_public_key: string | null;
  created_at: Date;
  device_id: string;
  encryption_public_key_algorithm: string | null;
  encryption_public_key_value: string | null;
  expires_at: Date;
  family_id: string;
  id: string;
  identity_id: string;
  last_seen_at: Date | null;
  public_key_algorithm: string;
  public_key_value: string;
  status: string;
}

/** 'UpdateTemporaryDeviceStatus' query type */
export interface UpdateTemporaryDeviceStatusQuery {
  params: UpdateTemporaryDeviceStatusParams;
  result: UpdateTemporaryDeviceStatusResult;
}

const updateTemporaryDeviceStatusIR: any = {"usedParamSet":{"status":true,"familyId":true,"deviceId":true},"params":[{"name":"status","required":false,"transform":{"type":"scalar"},"locs":[{"a":38,"b":44}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":64,"b":72}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":92,"b":100}]}],"statement":"UPDATE temporary_devices\nSET status = :status\nWHERE family_id = :familyId\n  AND device_id = :deviceId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE temporary_devices
 * SET status = :status
 * WHERE family_id = :familyId
 *   AND device_id = :deviceId
 * RETURNING *
 * ```
 */
export const updateTemporaryDeviceStatus = new PreparedQuery<UpdateTemporaryDeviceStatusParams,UpdateTemporaryDeviceStatusResult>(updateTemporaryDeviceStatusIR);


/** 'ExpireStaleTemporaryDevices' parameters type */
export type ExpireStaleTemporaryDevicesParams = void;

/** 'ExpireStaleTemporaryDevices' return type */
export type ExpireStaleTemporaryDevicesResult = void;

/** 'ExpireStaleTemporaryDevices' query type */
export interface ExpireStaleTemporaryDevicesQuery {
  params: ExpireStaleTemporaryDevicesParams;
  result: ExpireStaleTemporaryDevicesResult;
}

const expireStaleTemporaryDevicesIR: any = {"usedParamSet":{},"params":[],"statement":"UPDATE temporary_devices\nSET status = 'expired'\nWHERE status = 'active'\n  AND expires_at < NOW()"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE temporary_devices
 * SET status = 'expired'
 * WHERE status = 'active'
 *   AND expires_at < NOW()
 * ```
 */
export const expireStaleTemporaryDevices = new PreparedQuery<ExpireStaleTemporaryDevicesParams,ExpireStaleTemporaryDevicesResult>(expireStaleTemporaryDevicesIR);


