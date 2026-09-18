/** Types generated for queries found in "src/db/repositories/vaultRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 'FindByIdentityId' parameters type */
export interface FindByIdentityIdParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'FindByIdentityId' return type */
export interface FindByIdentityIdResult {
  encrypted_vault: Json;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  revision: number | null;
  status: string;
  updated_at: Date;
}

/** 'FindByIdentityId' query type */
export interface FindByIdentityIdQuery {
  params: FindByIdentityIdParams;
  result: FindByIdentityIdResult;
}

const findByIdentityIdIR: any = {"usedParamSet":{"identityId":true,"familyId":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":41,"b":51}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":71,"b":79}]}],"statement":"SELECT * FROM vaults\nWHERE identity_id = :identityId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM vaults
 * WHERE identity_id = :identityId
 *   AND family_id = :familyId
 * ```
 */
export const findByIdentityId = new PreparedQuery<FindByIdentityIdParams,FindByIdentityIdResult>(findByIdentityIdIR);


/** 'CreateVault' parameters type */
export interface CreateVaultParams {
  encryptedVault?: Json | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  revision?: number | null | void;
}

/** 'CreateVault' return type */
export interface CreateVaultResult {
  encrypted_vault: Json;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  revision: number | null;
  status: string;
  updated_at: Date;
}

/** 'CreateVault' query type */
export interface CreateVaultQuery {
  params: CreateVaultParams;
  result: CreateVaultResult;
}

const createVaultIR: any = {"usedParamSet":{"identityId":true,"familyId":true,"encryptedVault":true,"revision":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":92,"b":102}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":107,"b":115}]},{"name":"encryptedVault","required":false,"transform":{"type":"scalar"},"locs":[{"a":120,"b":134}]},{"name":"revision","required":false,"transform":{"type":"scalar"},"locs":[{"a":146,"b":154}]}],"statement":"INSERT INTO vaults (\n  identity_id,\n  family_id,\n  encrypted_vault,\n  revision\n) VALUES (\n  :identityId,\n  :familyId,\n  :encryptedVault::jsonb,\n  :revision\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO vaults (
 *   identity_id,
 *   family_id,
 *   encrypted_vault,
 *   revision
 * ) VALUES (
 *   :identityId,
 *   :familyId,
 *   :encryptedVault::jsonb,
 *   :revision
 * ) RETURNING *
 * ```
 */
export const createVault = new PreparedQuery<CreateVaultParams,CreateVaultResult>(createVaultIR);


/** 'UpsertVault' parameters type */
export interface UpsertVaultParams {
  encryptedVault?: Json | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  revision?: number | null | void;
}

/** 'UpsertVault' return type */
export interface UpsertVaultResult {
  encrypted_vault: Json;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  identity_id: string;
  revision: number | null;
  status: string;
  updated_at: Date;
}

/** 'UpsertVault' query type */
export interface UpsertVaultQuery {
  params: UpsertVaultParams;
  result: UpsertVaultResult;
}

const upsertVaultIR: any = {"usedParamSet":{"identityId":true,"familyId":true,"encryptedVault":true,"revision":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":92,"b":102}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":107,"b":115}]},{"name":"encryptedVault","required":false,"transform":{"type":"scalar"},"locs":[{"a":120,"b":134}]},{"name":"revision","required":false,"transform":{"type":"scalar"},"locs":[{"a":146,"b":154}]}],"statement":"INSERT INTO vaults (\n  identity_id,\n  family_id,\n  encrypted_vault,\n  revision\n) VALUES (\n  :identityId,\n  :familyId,\n  :encryptedVault::jsonb,\n  :revision\n) ON CONFLICT (identity_id)\nDO UPDATE SET\n  encrypted_vault = EXCLUDED.encrypted_vault,\n  revision = EXCLUDED.revision,\n  updated_at = NOW()\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO vaults (
 *   identity_id,
 *   family_id,
 *   encrypted_vault,
 *   revision
 * ) VALUES (
 *   :identityId,
 *   :familyId,
 *   :encryptedVault::jsonb,
 *   :revision
 * ) ON CONFLICT (identity_id)
 * DO UPDATE SET
 *   encrypted_vault = EXCLUDED.encrypted_vault,
 *   revision = EXCLUDED.revision,
 *   updated_at = NOW()
 * RETURNING *
 * ```
 */
export const upsertVault = new PreparedQuery<UpsertVaultParams,UpsertVaultResult>(upsertVaultIR);


/** 'DeleteVault' parameters type */
export interface DeleteVaultParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'DeleteVault' return type */
export type DeleteVaultResult = void;

/** 'DeleteVault' query type */
export interface DeleteVaultQuery {
  params: DeleteVaultParams;
  result: DeleteVaultResult;
}

const deleteVaultIR: any = {"usedParamSet":{"identityId":true,"familyId":true},"params":[{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":39,"b":49}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":69,"b":77}]}],"statement":"DELETE FROM vaults\nWHERE identity_id = :identityId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM vaults
 * WHERE identity_id = :identityId
 *   AND family_id = :familyId
 * ```
 */
export const deleteVault = new PreparedQuery<DeleteVaultParams,DeleteVaultResult>(deleteVaultIR);


/** 'UpdateVaultStatus' parameters type */
export interface UpdateVaultStatusParams {
  familyId?: string | null | void;
  identityId?: string | null | void;
  status?: string | null | void;
}

/** 'UpdateVaultStatus' return type */
export type UpdateVaultStatusResult = void;

/** 'UpdateVaultStatus' query type */
export interface UpdateVaultStatusQuery {
  params: UpdateVaultStatusParams;
  result: UpdateVaultStatusResult;
}

const updateVaultStatusIR: any = {"usedParamSet":{"status":true,"identityId":true,"familyId":true},"params":[{"name":"status","required":false,"transform":{"type":"scalar"},"locs":[{"a":27,"b":33}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":55,"b":65}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":85,"b":93}]}],"statement":"UPDATE vaults\nSET status = :status\nWHERE identity_id = :identityId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE vaults
 * SET status = :status
 * WHERE identity_id = :identityId
 *   AND family_id = :familyId
 * ```
 */
export const updateVaultStatus = new PreparedQuery<UpdateVaultStatusParams,UpdateVaultStatusResult>(updateVaultStatusIR);


