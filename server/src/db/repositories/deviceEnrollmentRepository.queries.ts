/** Types generated for queries found in "src/db/repositories/deviceEnrollmentRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

/** 'CreateDeviceEnrollment' parameters type */
export interface CreateDeviceEnrollmentParams {
  enrollmentId?: string | null | void;
  expiresAt?: DateOrString | null | void;
  familyId?: string | null | void;
  newDeviceCipher?: string | null | void;
  newDeviceCiphertext?: string | null | void;
  origin?: string | null | void;
  originVerified?: boolean | null | void;
  requestIp?: string | null | void;
  requestUserAgent?: string | null | void;
}

/** 'CreateDeviceEnrollment' return type */
export interface CreateDeviceEnrollmentResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_temporary_membership: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  new_device_cipher: string | null;
  new_device_ciphertext: string | null;
  new_device_encryption_public_key_algorithm: string | null;
  new_device_encryption_public_key_value: string | null;
  new_device_id: string | null;
  new_device_public_key_algorithm: string | null;
  new_device_public_key_value: string | null;
  origin: string | null;
  origin_verified: boolean;
  request_ip: string | null;
  request_user_agent: string | null;
  state: string;
  trusted_read_at: Date | null;
}

/** 'CreateDeviceEnrollment' query type */
export interface CreateDeviceEnrollmentQuery {
  params: CreateDeviceEnrollmentParams;
  result: CreateDeviceEnrollmentResult;
}

const createDeviceEnrollmentIR: any = {"usedParamSet":{"familyId":true,"enrollmentId":true,"newDeviceCiphertext":true,"newDeviceCipher":true,"origin":true,"originVerified":true,"requestIp":true,"requestUserAgent":true,"expiresAt":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":209,"b":217}]},{"name":"enrollmentId","required":false,"transform":{"type":"scalar"},"locs":[{"a":222,"b":234}]},{"name":"newDeviceCiphertext","required":false,"transform":{"type":"scalar"},"locs":[{"a":239,"b":258}]},{"name":"newDeviceCipher","required":false,"transform":{"type":"scalar"},"locs":[{"a":263,"b":278}]},{"name":"origin","required":false,"transform":{"type":"scalar"},"locs":[{"a":283,"b":289}]},{"name":"originVerified","required":false,"transform":{"type":"scalar"},"locs":[{"a":294,"b":308},{"a":362,"b":376}]},{"name":"requestIp","required":false,"transform":{"type":"scalar"},"locs":[{"a":313,"b":322}]},{"name":"requestUserAgent","required":false,"transform":{"type":"scalar"},"locs":[{"a":327,"b":343}]},{"name":"expiresAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":447,"b":456}]}],"statement":"INSERT INTO device_enrollments (\n  family_id,\n  enrollment_id,\n  new_device_ciphertext,\n  new_device_cipher,\n  origin,\n  origin_verified,\n  request_ip,\n  request_user_agent,\n  state,\n  expires_at\n) VALUES (\n  :familyId,\n  :enrollmentId,\n  :newDeviceCiphertext,\n  :newDeviceCipher,\n  :origin,\n  :originVerified,\n  :requestIp,\n  :requestUserAgent,\n  CASE\n    WHEN :originVerified THEN 'pending_trusted_read'\n    ELSE 'pending_origin_check'\n  END,\n  :expiresAt\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO device_enrollments (
 *   family_id,
 *   enrollment_id,
 *   new_device_ciphertext,
 *   new_device_cipher,
 *   origin,
 *   origin_verified,
 *   request_ip,
 *   request_user_agent,
 *   state,
 *   expires_at
 * ) VALUES (
 *   :familyId,
 *   :enrollmentId,
 *   :newDeviceCiphertext,
 *   :newDeviceCipher,
 *   :origin,
 *   :originVerified,
 *   :requestIp,
 *   :requestUserAgent,
 *   CASE
 *     WHEN :originVerified THEN 'pending_trusted_read'
 *     ELSE 'pending_origin_check'
 *   END,
 *   :expiresAt
 * ) RETURNING *
 * ```
 */
export const createDeviceEnrollment = new PreparedQuery<CreateDeviceEnrollmentParams,CreateDeviceEnrollmentResult>(createDeviceEnrollmentIR);


/** 'FindDeviceEnrollmentByEnrollmentId' parameters type */
export interface FindDeviceEnrollmentByEnrollmentIdParams {
  enrollmentId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindDeviceEnrollmentByEnrollmentId' return type */
export interface FindDeviceEnrollmentByEnrollmentIdResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_temporary_membership: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  new_device_cipher: string | null;
  new_device_ciphertext: string | null;
  new_device_encryption_public_key_algorithm: string | null;
  new_device_encryption_public_key_value: string | null;
  new_device_id: string | null;
  new_device_public_key_algorithm: string | null;
  new_device_public_key_value: string | null;
  origin: string | null;
  origin_verified: boolean;
  request_ip: string | null;
  request_user_agent: string | null;
  state: string;
  trusted_read_at: Date | null;
}

/** 'FindDeviceEnrollmentByEnrollmentId' query type */
export interface FindDeviceEnrollmentByEnrollmentIdQuery {
  params: FindDeviceEnrollmentByEnrollmentIdParams;
  result: FindDeviceEnrollmentByEnrollmentIdResult;
}

const findDeviceEnrollmentByEnrollmentIdIR: any = {"usedParamSet":{"familyId":true,"enrollmentId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":51,"b":59}]},{"name":"enrollmentId","required":false,"transform":{"type":"scalar"},"locs":[{"a":83,"b":95}]}],"statement":"SELECT *\nFROM device_enrollments\nWHERE family_id = :familyId\n  AND enrollment_id = :enrollmentId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM device_enrollments
 * WHERE family_id = :familyId
 *   AND enrollment_id = :enrollmentId
 * LIMIT 1
 * ```
 */
export const findDeviceEnrollmentByEnrollmentId = new PreparedQuery<FindDeviceEnrollmentByEnrollmentIdParams,FindDeviceEnrollmentByEnrollmentIdResult>(findDeviceEnrollmentByEnrollmentIdIR);


/** 'MarkDeviceEnrollmentTrustedRead' parameters type */
export interface MarkDeviceEnrollmentTrustedReadParams {
  enrollmentId?: string | null | void;
  familyId?: string | null | void;
}

/** 'MarkDeviceEnrollmentTrustedRead' return type */
export interface MarkDeviceEnrollmentTrustedReadResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_temporary_membership: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  new_device_cipher: string | null;
  new_device_ciphertext: string | null;
  new_device_encryption_public_key_algorithm: string | null;
  new_device_encryption_public_key_value: string | null;
  new_device_id: string | null;
  new_device_public_key_algorithm: string | null;
  new_device_public_key_value: string | null;
  origin: string | null;
  origin_verified: boolean;
  request_ip: string | null;
  request_user_agent: string | null;
  state: string;
  trusted_read_at: Date | null;
}

/** 'MarkDeviceEnrollmentTrustedRead' query type */
export interface MarkDeviceEnrollmentTrustedReadQuery {
  params: MarkDeviceEnrollmentTrustedReadParams;
  result: MarkDeviceEnrollmentTrustedReadResult;
}

const markDeviceEnrollmentTrustedReadIR: any = {"usedParamSet":{"familyId":true,"enrollmentId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":189,"b":197}]},{"name":"enrollmentId","required":false,"transform":{"type":"scalar"},"locs":[{"a":221,"b":233}]}],"statement":"UPDATE device_enrollments\nSET state = CASE\n      WHEN state = 'pending_trusted_read' THEN 'pending_trusted_approval'\n      ELSE state\n    END,\n    trusted_read_at = NOW()\nWHERE family_id = :familyId\n  AND enrollment_id = :enrollmentId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE device_enrollments
 * SET state = CASE
 *       WHEN state = 'pending_trusted_read' THEN 'pending_trusted_approval'
 *       ELSE state
 *     END,
 *     trusted_read_at = NOW()
 * WHERE family_id = :familyId
 *   AND enrollment_id = :enrollmentId
 * RETURNING *
 * ```
 */
export const markDeviceEnrollmentTrustedRead = new PreparedQuery<MarkDeviceEnrollmentTrustedReadParams,MarkDeviceEnrollmentTrustedReadResult>(markDeviceEnrollmentTrustedReadIR);


/** 'MarkDeviceEnrollmentApproved' parameters type */
export interface MarkDeviceEnrollmentApprovedParams {
  approvedByDeviceId?: string | null | void;
  cipher?: string | null | void;
  encryptedTemporaryMembership?: string | null | void;
  enrollmentId?: string | null | void;
  expiresAt?: DateOrString | null | void;
  familyId?: string | null | void;
  temporaryDeviceEncryptionPublicKeyAlgorithm?: string | null | void;
  temporaryDeviceEncryptionPublicKeyValue?: string | null | void;
  temporaryDeviceId?: string | null | void;
  temporaryDevicePublicKeyAlgorithm?: string | null | void;
  temporaryDevicePublicKeyValue?: string | null | void;
}

/** 'MarkDeviceEnrollmentApproved' return type */
export interface MarkDeviceEnrollmentApprovedResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_temporary_membership: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  new_device_cipher: string | null;
  new_device_ciphertext: string | null;
  new_device_encryption_public_key_algorithm: string | null;
  new_device_encryption_public_key_value: string | null;
  new_device_id: string | null;
  new_device_public_key_algorithm: string | null;
  new_device_public_key_value: string | null;
  origin: string | null;
  origin_verified: boolean;
  request_ip: string | null;
  request_user_agent: string | null;
  state: string;
  trusted_read_at: Date | null;
}

/** 'MarkDeviceEnrollmentApproved' query type */
export interface MarkDeviceEnrollmentApprovedQuery {
  params: MarkDeviceEnrollmentApprovedParams;
  result: MarkDeviceEnrollmentApprovedResult;
}

const markDeviceEnrollmentApprovedIR: any = {"usedParamSet":{"approvedByDeviceId":true,"temporaryDeviceId":true,"temporaryDevicePublicKeyAlgorithm":true,"temporaryDevicePublicKeyValue":true,"temporaryDeviceEncryptionPublicKeyAlgorithm":true,"temporaryDeviceEncryptionPublicKeyValue":true,"encryptedTemporaryMembership":true,"cipher":true,"expiresAt":true,"familyId":true,"enrollmentId":true},"params":[{"name":"approvedByDeviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":78,"b":96}]},{"name":"temporaryDeviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":119,"b":136}]},{"name":"temporaryDevicePublicKeyAlgorithm","required":false,"transform":{"type":"scalar"},"locs":[{"a":177,"b":210}]},{"name":"temporaryDevicePublicKeyValue","required":false,"transform":{"type":"scalar"},"locs":[{"a":247,"b":276}]},{"name":"temporaryDeviceEncryptionPublicKeyAlgorithm","required":false,"transform":{"type":"scalar"},"locs":[{"a":328,"b":371}]},{"name":"temporaryDeviceEncryptionPublicKeyValue","required":false,"transform":{"type":"scalar"},"locs":[{"a":419,"b":458}]},{"name":"encryptedTemporaryMembership","required":false,"transform":{"type":"scalar"},"locs":[{"a":498,"b":526}]},{"name":"cipher","required":false,"transform":{"type":"scalar"},"locs":[{"a":542,"b":548}]},{"name":"expiresAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":593,"b":602}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":622,"b":630}]},{"name":"enrollmentId","required":false,"transform":{"type":"scalar"},"locs":[{"a":654,"b":666}]}],"statement":"UPDATE device_enrollments\nSET state = 'approved',\n    approved_by_device_id = :approvedByDeviceId,\n    new_device_id = :temporaryDeviceId,\n    new_device_public_key_algorithm = :temporaryDevicePublicKeyAlgorithm,\n    new_device_public_key_value = :temporaryDevicePublicKeyValue,\n    new_device_encryption_public_key_algorithm = :temporaryDeviceEncryptionPublicKeyAlgorithm,\n    new_device_encryption_public_key_value = :temporaryDeviceEncryptionPublicKeyValue,\n    encrypted_temporary_membership = :encryptedTemporaryMembership,\n    cipher = :cipher,\n    approved_at = NOW(),\n    expires_at = :expiresAt\nWHERE family_id = :familyId\n  AND enrollment_id = :enrollmentId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE device_enrollments
 * SET state = 'approved',
 *     approved_by_device_id = :approvedByDeviceId,
 *     new_device_id = :temporaryDeviceId,
 *     new_device_public_key_algorithm = :temporaryDevicePublicKeyAlgorithm,
 *     new_device_public_key_value = :temporaryDevicePublicKeyValue,
 *     new_device_encryption_public_key_algorithm = :temporaryDeviceEncryptionPublicKeyAlgorithm,
 *     new_device_encryption_public_key_value = :temporaryDeviceEncryptionPublicKeyValue,
 *     encrypted_temporary_membership = :encryptedTemporaryMembership,
 *     cipher = :cipher,
 *     approved_at = NOW(),
 *     expires_at = :expiresAt
 * WHERE family_id = :familyId
 *   AND enrollment_id = :enrollmentId
 * RETURNING *
 * ```
 */
export const markDeviceEnrollmentApproved = new PreparedQuery<MarkDeviceEnrollmentApprovedParams,MarkDeviceEnrollmentApprovedResult>(markDeviceEnrollmentApprovedIR);


/** 'MarkDeviceEnrollmentRejected' parameters type */
export interface MarkDeviceEnrollmentRejectedParams {
  enrollmentId?: string | null | void;
  familyId?: string | null | void;
}

/** 'MarkDeviceEnrollmentRejected' return type */
export interface MarkDeviceEnrollmentRejectedResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_temporary_membership: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  new_device_cipher: string | null;
  new_device_ciphertext: string | null;
  new_device_encryption_public_key_algorithm: string | null;
  new_device_encryption_public_key_value: string | null;
  new_device_id: string | null;
  new_device_public_key_algorithm: string | null;
  new_device_public_key_value: string | null;
  origin: string | null;
  origin_verified: boolean;
  request_ip: string | null;
  request_user_agent: string | null;
  state: string;
  trusted_read_at: Date | null;
}

/** 'MarkDeviceEnrollmentRejected' query type */
export interface MarkDeviceEnrollmentRejectedQuery {
  params: MarkDeviceEnrollmentRejectedParams;
  result: MarkDeviceEnrollmentRejectedResult;
}

const markDeviceEnrollmentRejectedIR: any = {"usedParamSet":{"familyId":true,"enrollmentId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":67,"b":75}]},{"name":"enrollmentId","required":false,"transform":{"type":"scalar"},"locs":[{"a":99,"b":111}]}],"statement":"UPDATE device_enrollments\nSET state = 'rejected'\nWHERE family_id = :familyId\n  AND enrollment_id = :enrollmentId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE device_enrollments
 * SET state = 'rejected'
 * WHERE family_id = :familyId
 *   AND enrollment_id = :enrollmentId
 * RETURNING *
 * ```
 */
export const markDeviceEnrollmentRejected = new PreparedQuery<MarkDeviceEnrollmentRejectedParams,MarkDeviceEnrollmentRejectedResult>(markDeviceEnrollmentRejectedIR);


/** 'MarkDeviceEnrollmentConsumed' parameters type */
export interface MarkDeviceEnrollmentConsumedParams {
  enrollmentId?: string | null | void;
  familyId?: string | null | void;
}

/** 'MarkDeviceEnrollmentConsumed' return type */
export interface MarkDeviceEnrollmentConsumedResult {
  approved_at: Date | null;
  approved_by_device_id: string | null;
  cipher: string | null;
  consumed_at: Date | null;
  created_at: Date;
  encrypted_temporary_membership: string | null;
  enrollment_id: string;
  expires_at: Date;
  family_id: string;
  id: string;
  new_device_cipher: string | null;
  new_device_ciphertext: string | null;
  new_device_encryption_public_key_algorithm: string | null;
  new_device_encryption_public_key_value: string | null;
  new_device_id: string | null;
  new_device_public_key_algorithm: string | null;
  new_device_public_key_value: string | null;
  origin: string | null;
  origin_verified: boolean;
  request_ip: string | null;
  request_user_agent: string | null;
  state: string;
  trusted_read_at: Date | null;
}

/** 'MarkDeviceEnrollmentConsumed' query type */
export interface MarkDeviceEnrollmentConsumedQuery {
  params: MarkDeviceEnrollmentConsumedParams;
  result: MarkDeviceEnrollmentConsumedResult;
}

const markDeviceEnrollmentConsumedIR: any = {"usedParamSet":{"familyId":true,"enrollmentId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":92,"b":100}]},{"name":"enrollmentId","required":false,"transform":{"type":"scalar"},"locs":[{"a":124,"b":136}]}],"statement":"UPDATE device_enrollments\nSET state = 'consumed',\n    consumed_at = NOW()\nWHERE family_id = :familyId\n  AND enrollment_id = :enrollmentId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE device_enrollments
 * SET state = 'consumed',
 *     consumed_at = NOW()
 * WHERE family_id = :familyId
 *   AND enrollment_id = :enrollmentId
 * RETURNING *
 * ```
 */
export const markDeviceEnrollmentConsumed = new PreparedQuery<MarkDeviceEnrollmentConsumedParams,MarkDeviceEnrollmentConsumedResult>(markDeviceEnrollmentConsumedIR);


/** 'ExpireStaleDeviceEnrollments' parameters type */
export type ExpireStaleDeviceEnrollmentsParams = void;

/** 'ExpireStaleDeviceEnrollments' return type */
export type ExpireStaleDeviceEnrollmentsResult = void;

/** 'ExpireStaleDeviceEnrollments' query type */
export interface ExpireStaleDeviceEnrollmentsQuery {
  params: ExpireStaleDeviceEnrollmentsParams;
  result: ExpireStaleDeviceEnrollmentsResult;
}

const expireStaleDeviceEnrollmentsIR: any = {"usedParamSet":{},"params":[],"statement":"UPDATE device_enrollments\nSET state = 'expired'\nWHERE state IN ('pending_origin_check', 'pending_trusted_read', 'pending_trusted_approval', 'approved')\n  AND expires_at < NOW()"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE device_enrollments
 * SET state = 'expired'
 * WHERE state IN ('pending_origin_check', 'pending_trusted_read', 'pending_trusted_approval', 'approved')
 *   AND expires_at < NOW()
 * ```
 */
export const expireStaleDeviceEnrollments = new PreparedQuery<ExpireStaleDeviceEnrollmentsParams,ExpireStaleDeviceEnrollmentsResult>(expireStaleDeviceEnrollmentsIR);


