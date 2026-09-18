/** Types generated for queries found in "src/db/repositories/familyConfigRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type stringArray = (string)[];

/** 'FindByFamilyId' parameters type */
export interface FindByFamilyIdParams {
  familyId?: string | null | void;
}

/** 'FindByFamilyId' return type */
export interface FindByFamilyIdResult {
  attachment_retention_seconds: number | null;
  attachment_storage_quota_bytes: string | null;
  attachments_enabled: boolean;
  chat_epoch_key_retention_hours: number;
  chat_epoch_rotation_interval_hours: number;
  claimed_at: Date | null;
  created_at: Date;
  created_by_server_admin_id: string | null;
  extra_trusted_client_origins: stringArray;
  family_id: string;
  first_owner_invite_token: string | null;
  id: string;
  join_invite_id: string | null;
  max_attachment_file_size_bytes: string | null;
  message_archive_circle_max_bytes: string | null;
  message_archive_circle_policy: string;
  message_archive_server_max_bytes: string | null;
  message_archive_server_policy: string;
  message_ttl_hours: number;
  no_names_on_server: boolean;
  owner_identity_id: string | null;
  public_base_url: string | null;
  reserved_attachment_storage_bytes: string;
  revoked_at: Date | null;
  server_name: string;
  status: string;
  updated_at: Date;
  used_attachment_storage_bytes: string;
}

/** 'FindByFamilyId' query type */
export interface FindByFamilyIdQuery {
  params: FindByFamilyIdParams;
  result: FindByFamilyIdResult;
}

const findByFamilyIdIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":46,"b":54}]}],"statement":"SELECT * FROM family_config\nWHERE family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM family_config
 * WHERE family_id = :familyId
 * ```
 */
export const findByFamilyId = new PreparedQuery<FindByFamilyIdParams,FindByFamilyIdResult>(findByFamilyIdIR);


/** 'FindAllFamilyConfigs' parameters type */
export type FindAllFamilyConfigsParams = void;

/** 'FindAllFamilyConfigs' return type */
export interface FindAllFamilyConfigsResult {
  attachment_retention_seconds: number | null;
  attachment_storage_quota_bytes: string | null;
  attachments_enabled: boolean;
  chat_epoch_key_retention_hours: number;
  chat_epoch_rotation_interval_hours: number;
  claimed_at: Date | null;
  created_at: Date;
  created_by_server_admin_id: string | null;
  extra_trusted_client_origins: stringArray;
  family_id: string;
  first_owner_invite_token: string | null;
  id: string;
  join_invite_id: string | null;
  max_attachment_file_size_bytes: string | null;
  message_archive_circle_max_bytes: string | null;
  message_archive_circle_policy: string;
  message_archive_server_max_bytes: string | null;
  message_archive_server_policy: string;
  message_ttl_hours: number;
  no_names_on_server: boolean;
  owner_identity_id: string | null;
  public_base_url: string | null;
  reserved_attachment_storage_bytes: string;
  revoked_at: Date | null;
  server_name: string;
  status: string;
  updated_at: Date;
  used_attachment_storage_bytes: string;
}

/** 'FindAllFamilyConfigs' query type */
export interface FindAllFamilyConfigsQuery {
  params: FindAllFamilyConfigsParams;
  result: FindAllFamilyConfigsResult;
}

const findAllFamilyConfigsIR: any = {"usedParamSet":{},"params":[],"statement":"SELECT * FROM family_config\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM family_config
 * ORDER BY created_at DESC
 * ```
 */
export const findAllFamilyConfigs = new PreparedQuery<FindAllFamilyConfigsParams,FindAllFamilyConfigsResult>(findAllFamilyConfigsIR);


/** 'CreateFamilyConfig' parameters type */
export interface CreateFamilyConfigParams {
  familyId?: string | null | void;
  firstOwnerInviteToken?: string | null | void;
  noNamesOnServer?: boolean | null | void;
  publicBaseUrl?: string | null | void;
  serverName?: string | null | void;
}

/** 'CreateFamilyConfig' return type */
export interface CreateFamilyConfigResult {
  attachment_retention_seconds: number | null;
  attachment_storage_quota_bytes: string | null;
  attachments_enabled: boolean;
  chat_epoch_key_retention_hours: number;
  chat_epoch_rotation_interval_hours: number;
  claimed_at: Date | null;
  created_at: Date;
  created_by_server_admin_id: string | null;
  extra_trusted_client_origins: stringArray;
  family_id: string;
  first_owner_invite_token: string | null;
  id: string;
  join_invite_id: string | null;
  max_attachment_file_size_bytes: string | null;
  message_archive_circle_max_bytes: string | null;
  message_archive_circle_policy: string;
  message_archive_server_max_bytes: string | null;
  message_archive_server_policy: string;
  message_ttl_hours: number;
  no_names_on_server: boolean;
  owner_identity_id: string | null;
  public_base_url: string | null;
  reserved_attachment_storage_bytes: string;
  revoked_at: Date | null;
  server_name: string;
  status: string;
  updated_at: Date;
  used_attachment_storage_bytes: string;
}

/** 'CreateFamilyConfig' query type */
export interface CreateFamilyConfigQuery {
  params: CreateFamilyConfigParams;
  result: CreateFamilyConfigResult;
}

const createFamilyConfigIR: any = {"usedParamSet":{"familyId":true,"serverName":true,"publicBaseUrl":true,"firstOwnerInviteToken":true,"noNamesOnServer":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":137,"b":145}]},{"name":"serverName","required":false,"transform":{"type":"scalar"},"locs":[{"a":150,"b":160}]},{"name":"publicBaseUrl","required":false,"transform":{"type":"scalar"},"locs":[{"a":165,"b":178}]},{"name":"firstOwnerInviteToken","required":false,"transform":{"type":"scalar"},"locs":[{"a":183,"b":204}]},{"name":"noNamesOnServer","required":false,"transform":{"type":"scalar"},"locs":[{"a":209,"b":224}]}],"statement":"INSERT INTO family_config (\n  family_id,\n  server_name,\n  public_base_url,\n  first_owner_invite_token,\n  no_names_on_server\n) VALUES (\n  :familyId,\n  :serverName,\n  :publicBaseUrl,\n  :firstOwnerInviteToken,\n  :noNamesOnServer\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO family_config (
 *   family_id,
 *   server_name,
 *   public_base_url,
 *   first_owner_invite_token,
 *   no_names_on_server
 * ) VALUES (
 *   :familyId,
 *   :serverName,
 *   :publicBaseUrl,
 *   :firstOwnerInviteToken,
 *   :noNamesOnServer
 * ) RETURNING *
 * ```
 */
export const createFamilyConfig = new PreparedQuery<CreateFamilyConfigParams,CreateFamilyConfigResult>(createFamilyConfigIR);


/** 'UpdateServerName' parameters type */
export interface UpdateServerNameParams {
  familyId?: string | null | void;
  serverName?: string | null | void;
}

/** 'UpdateServerName' return type */
export interface UpdateServerNameResult {
  attachment_retention_seconds: number | null;
  attachment_storage_quota_bytes: string | null;
  attachments_enabled: boolean;
  chat_epoch_key_retention_hours: number;
  chat_epoch_rotation_interval_hours: number;
  claimed_at: Date | null;
  created_at: Date;
  created_by_server_admin_id: string | null;
  extra_trusted_client_origins: stringArray;
  family_id: string;
  first_owner_invite_token: string | null;
  id: string;
  join_invite_id: string | null;
  max_attachment_file_size_bytes: string | null;
  message_archive_circle_max_bytes: string | null;
  message_archive_circle_policy: string;
  message_archive_server_max_bytes: string | null;
  message_archive_server_policy: string;
  message_ttl_hours: number;
  no_names_on_server: boolean;
  owner_identity_id: string | null;
  public_base_url: string | null;
  reserved_attachment_storage_bytes: string;
  revoked_at: Date | null;
  server_name: string;
  status: string;
  updated_at: Date;
  used_attachment_storage_bytes: string;
}

/** 'UpdateServerName' query type */
export interface UpdateServerNameQuery {
  params: UpdateServerNameParams;
  result: UpdateServerNameResult;
}

const updateServerNameIR: any = {"usedParamSet":{"serverName":true,"familyId":true},"params":[{"name":"serverName","required":false,"transform":{"type":"scalar"},"locs":[{"a":39,"b":49}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":89,"b":97}]}],"statement":"UPDATE family_config\nSET server_name = :serverName, updated_at = NOW()\nWHERE family_id = :familyId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE family_config
 * SET server_name = :serverName, updated_at = NOW()
 * WHERE family_id = :familyId
 * RETURNING *
 * ```
 */
export const updateServerName = new PreparedQuery<UpdateServerNameParams,UpdateServerNameResult>(updateServerNameIR);


/** 'UpdatePublicBaseUrl' parameters type */
export interface UpdatePublicBaseUrlParams {
  familyId?: string | null | void;
  publicBaseUrl?: string | null | void;
}

/** 'UpdatePublicBaseUrl' return type */
export interface UpdatePublicBaseUrlResult {
  attachment_retention_seconds: number | null;
  attachment_storage_quota_bytes: string | null;
  attachments_enabled: boolean;
  chat_epoch_key_retention_hours: number;
  chat_epoch_rotation_interval_hours: number;
  claimed_at: Date | null;
  created_at: Date;
  created_by_server_admin_id: string | null;
  extra_trusted_client_origins: stringArray;
  family_id: string;
  first_owner_invite_token: string | null;
  id: string;
  join_invite_id: string | null;
  max_attachment_file_size_bytes: string | null;
  message_archive_circle_max_bytes: string | null;
  message_archive_circle_policy: string;
  message_archive_server_max_bytes: string | null;
  message_archive_server_policy: string;
  message_ttl_hours: number;
  no_names_on_server: boolean;
  owner_identity_id: string | null;
  public_base_url: string | null;
  reserved_attachment_storage_bytes: string;
  revoked_at: Date | null;
  server_name: string;
  status: string;
  updated_at: Date;
  used_attachment_storage_bytes: string;
}

/** 'UpdatePublicBaseUrl' query type */
export interface UpdatePublicBaseUrlQuery {
  params: UpdatePublicBaseUrlParams;
  result: UpdatePublicBaseUrlResult;
}

const updatePublicBaseUrlIR: any = {"usedParamSet":{"publicBaseUrl":true,"familyId":true},"params":[{"name":"publicBaseUrl","required":false,"transform":{"type":"scalar"},"locs":[{"a":43,"b":56}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":96,"b":104}]}],"statement":"UPDATE family_config\nSET public_base_url = :publicBaseUrl, updated_at = NOW()\nWHERE family_id = :familyId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE family_config
 * SET public_base_url = :publicBaseUrl, updated_at = NOW()
 * WHERE family_id = :familyId
 * RETURNING *
 * ```
 */
export const updatePublicBaseUrl = new PreparedQuery<UpdatePublicBaseUrlParams,UpdatePublicBaseUrlResult>(updatePublicBaseUrlIR);


/** 'UpdateFirstOwnerInviteToken' parameters type */
export interface UpdateFirstOwnerInviteTokenParams {
  familyId?: string | null | void;
  firstOwnerInviteToken?: string | null | void;
}

/** 'UpdateFirstOwnerInviteToken' return type */
export interface UpdateFirstOwnerInviteTokenResult {
  attachment_retention_seconds: number | null;
  attachment_storage_quota_bytes: string | null;
  attachments_enabled: boolean;
  chat_epoch_key_retention_hours: number;
  chat_epoch_rotation_interval_hours: number;
  claimed_at: Date | null;
  created_at: Date;
  created_by_server_admin_id: string | null;
  extra_trusted_client_origins: stringArray;
  family_id: string;
  first_owner_invite_token: string | null;
  id: string;
  join_invite_id: string | null;
  max_attachment_file_size_bytes: string | null;
  message_archive_circle_max_bytes: string | null;
  message_archive_circle_policy: string;
  message_archive_server_max_bytes: string | null;
  message_archive_server_policy: string;
  message_ttl_hours: number;
  no_names_on_server: boolean;
  owner_identity_id: string | null;
  public_base_url: string | null;
  reserved_attachment_storage_bytes: string;
  revoked_at: Date | null;
  server_name: string;
  status: string;
  updated_at: Date;
  used_attachment_storage_bytes: string;
}

/** 'UpdateFirstOwnerInviteToken' query type */
export interface UpdateFirstOwnerInviteTokenQuery {
  params: UpdateFirstOwnerInviteTokenParams;
  result: UpdateFirstOwnerInviteTokenResult;
}

const updateFirstOwnerInviteTokenIR: any = {"usedParamSet":{"firstOwnerInviteToken":true,"familyId":true},"params":[{"name":"firstOwnerInviteToken","required":false,"transform":{"type":"scalar"},"locs":[{"a":52,"b":73}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":113,"b":121}]}],"statement":"UPDATE family_config\nSET first_owner_invite_token = :firstOwnerInviteToken, updated_at = NOW()\nWHERE family_id = :familyId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE family_config
 * SET first_owner_invite_token = :firstOwnerInviteToken, updated_at = NOW()
 * WHERE family_id = :familyId
 * RETURNING *
 * ```
 */
export const updateFirstOwnerInviteToken = new PreparedQuery<UpdateFirstOwnerInviteTokenParams,UpdateFirstOwnerInviteTokenResult>(updateFirstOwnerInviteTokenIR);


/** 'UpsertFamilyConfig' parameters type */
export interface UpsertFamilyConfigParams {
  familyId?: string | null | void;
  firstOwnerInviteToken?: string | null | void;
  noNamesOnServer?: boolean | null | void;
  publicBaseUrl?: string | null | void;
  serverName?: string | null | void;
}

/** 'UpsertFamilyConfig' return type */
export interface UpsertFamilyConfigResult {
  attachment_retention_seconds: number | null;
  attachment_storage_quota_bytes: string | null;
  attachments_enabled: boolean;
  chat_epoch_key_retention_hours: number;
  chat_epoch_rotation_interval_hours: number;
  claimed_at: Date | null;
  created_at: Date;
  created_by_server_admin_id: string | null;
  extra_trusted_client_origins: stringArray;
  family_id: string;
  first_owner_invite_token: string | null;
  id: string;
  join_invite_id: string | null;
  max_attachment_file_size_bytes: string | null;
  message_archive_circle_max_bytes: string | null;
  message_archive_circle_policy: string;
  message_archive_server_max_bytes: string | null;
  message_archive_server_policy: string;
  message_ttl_hours: number;
  no_names_on_server: boolean;
  owner_identity_id: string | null;
  public_base_url: string | null;
  reserved_attachment_storage_bytes: string;
  revoked_at: Date | null;
  server_name: string;
  status: string;
  updated_at: Date;
  used_attachment_storage_bytes: string;
}

/** 'UpsertFamilyConfig' query type */
export interface UpsertFamilyConfigQuery {
  params: UpsertFamilyConfigParams;
  result: UpsertFamilyConfigResult;
}

const upsertFamilyConfigIR: any = {"usedParamSet":{"familyId":true,"serverName":true,"publicBaseUrl":true,"firstOwnerInviteToken":true,"noNamesOnServer":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":137,"b":145}]},{"name":"serverName","required":false,"transform":{"type":"scalar"},"locs":[{"a":150,"b":160}]},{"name":"publicBaseUrl","required":false,"transform":{"type":"scalar"},"locs":[{"a":165,"b":178}]},{"name":"firstOwnerInviteToken","required":false,"transform":{"type":"scalar"},"locs":[{"a":183,"b":204}]},{"name":"noNamesOnServer","required":false,"transform":{"type":"scalar"},"locs":[{"a":209,"b":224}]}],"statement":"INSERT INTO family_config (\n  family_id,\n  server_name,\n  public_base_url,\n  first_owner_invite_token,\n  no_names_on_server\n) VALUES (\n  :familyId,\n  :serverName,\n  :publicBaseUrl,\n  :firstOwnerInviteToken,\n  :noNamesOnServer\n) ON CONFLICT (family_id)\nDO UPDATE SET\n  server_name = EXCLUDED.server_name,\n  public_base_url = EXCLUDED.public_base_url,\n  first_owner_invite_token = EXCLUDED.first_owner_invite_token,\n  updated_at = NOW()\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO family_config (
 *   family_id,
 *   server_name,
 *   public_base_url,
 *   first_owner_invite_token,
 *   no_names_on_server
 * ) VALUES (
 *   :familyId,
 *   :serverName,
 *   :publicBaseUrl,
 *   :firstOwnerInviteToken,
 *   :noNamesOnServer
 * ) ON CONFLICT (family_id)
 * DO UPDATE SET
 *   server_name = EXCLUDED.server_name,
 *   public_base_url = EXCLUDED.public_base_url,
 *   first_owner_invite_token = EXCLUDED.first_owner_invite_token,
 *   updated_at = NOW()
 * RETURNING *
 * ```
 */
export const upsertFamilyConfig = new PreparedQuery<UpsertFamilyConfigParams,UpsertFamilyConfigResult>(upsertFamilyConfigIR);


/** 'DeleteFamilyConfig' parameters type */
export interface DeleteFamilyConfigParams {
  familyId?: string | null | void;
}

/** 'DeleteFamilyConfig' return type */
export type DeleteFamilyConfigResult = void;

/** 'DeleteFamilyConfig' query type */
export interface DeleteFamilyConfigQuery {
  params: DeleteFamilyConfigParams;
  result: DeleteFamilyConfigResult;
}

const deleteFamilyConfigIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":44,"b":52}]}],"statement":"DELETE FROM family_config\nWHERE family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM family_config
 * WHERE family_id = :familyId
 * ```
 */
export const deleteFamilyConfig = new PreparedQuery<DeleteFamilyConfigParams,DeleteFamilyConfigResult>(deleteFamilyConfigIR);


/** 'FamilyExists' parameters type */
export interface FamilyExistsParams {
  familyId?: string | null | void;
}

/** 'FamilyExists' return type */
export interface FamilyExistsResult {
  exists: boolean | null;
}

/** 'FamilyExists' query type */
export interface FamilyExistsQuery {
  params: FamilyExistsParams;
  result: FamilyExistsResult;
}

const familyExistsIR: any = {"usedParamSet":{"familyId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":60,"b":68}]}],"statement":"SELECT EXISTS(SELECT 1 FROM family_config WHERE family_id = :familyId) as exists"};

/**
 * Query generated from SQL:
 * ```
 * SELECT EXISTS(SELECT 1 FROM family_config WHERE family_id = :familyId) as exists
 * ```
 */
export const familyExists = new PreparedQuery<FamilyExistsParams,FamilyExistsResult>(familyExistsIR);


