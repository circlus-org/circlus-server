/** Types generated for queries found in "src/db/repositories/messageRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NumberOrString = number | string;

/** 'FindMessageByClientMessageId' parameters type */
export interface FindMessageByClientMessageIdParams {
  clientMessageId?: string | null | void;
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindMessageByClientMessageId' return type */
export interface FindMessageByClientMessageIdResult {
  created_at: string;
  server_message_id: string;
}

/** 'FindMessageByClientMessageId' query type */
export interface FindMessageByClientMessageIdQuery {
  params: FindMessageByClientMessageIdParams;
  result: FindMessageByClientMessageIdResult;
}

const findMessageByClientMessageIdIR: any = {"usedParamSet":{"familyId":true,"deviceId":true,"clientMessageId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":69,"b":77}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":104,"b":112}]},{"name":"clientMessageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":140,"b":155}]}],"statement":"SELECT server_message_id, created_at\nFROM messages\nWHERE family_id = :familyId\n  AND sender_device_id = :deviceId\n  AND client_message_id = :clientMessageId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT server_message_id, created_at
 * FROM messages
 * WHERE family_id = :familyId
 *   AND sender_device_id = :deviceId
 *   AND client_message_id = :clientMessageId
 * LIMIT 1
 * ```
 */
export const findMessageByClientMessageId = new PreparedQuery<FindMessageByClientMessageIdParams,FindMessageByClientMessageIdResult>(findMessageByClientMessageIdIR);


/** 'InsertDirectMessage' parameters type */
export interface InsertDirectMessageParams {
  ciphertext?: string | null | void;
  clientCreatedAt?: NumberOrString | null | void;
  clientMessageId?: string | null | void;
  createdAt?: NumberOrString | null | void;
  familyId?: string | null | void;
  recipientIdentityId?: string | null | void;
  senderCiphertext?: string | null | void;
  senderDeviceId?: string | null | void;
  senderIdentityId?: string | null | void;
  senderSignature?: string | null | void;
  serverMessageId?: string | null | void;
  status?: string | null | void;
  statusUpdatedAt?: NumberOrString | null | void;
}

/** 'InsertDirectMessage' return type */
export type InsertDirectMessageResult = void;

/** 'InsertDirectMessage' query type */
export interface InsertDirectMessageQuery {
  params: InsertDirectMessageParams;
  result: InsertDirectMessageResult;
}

const insertDirectMessageIR: any = {"usedParamSet":{"serverMessageId":true,"familyId":true,"senderIdentityId":true,"recipientIdentityId":true,"senderDeviceId":true,"ciphertext":true,"senderCiphertext":true,"senderSignature":true,"clientMessageId":true,"clientCreatedAt":true,"createdAt":true,"status":true,"statusUpdatedAt":true},"params":[{"name":"serverMessageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":312,"b":327}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":332,"b":340}]},{"name":"senderIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":345,"b":361}]},{"name":"recipientIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":366,"b":385}]},{"name":"senderDeviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":390,"b":404}]},{"name":"ciphertext","required":false,"transform":{"type":"scalar"},"locs":[{"a":409,"b":419}]},{"name":"senderCiphertext","required":false,"transform":{"type":"scalar"},"locs":[{"a":424,"b":440}]},{"name":"senderSignature","required":false,"transform":{"type":"scalar"},"locs":[{"a":445,"b":460}]},{"name":"clientMessageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":465,"b":480}]},{"name":"clientCreatedAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":485,"b":500}]},{"name":"createdAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":505,"b":514},{"a":519,"b":528}]},{"name":"status","required":false,"transform":{"type":"scalar"},"locs":[{"a":538,"b":544}]},{"name":"statusUpdatedAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":549,"b":564}]}],"statement":"INSERT INTO messages (\n  server_message_id,\n  family_id,\n  sender_identity_id,\n  recipient_identity_id,\n  sender_device_id,\n  ciphertext,\n  sender_ciphertext,\n  sender_signature,\n  client_message_id,\n  client_created_at,\n  created_at,\n  content_updated_at,\n  revision,\n  status,\n  status_updated_at\n) VALUES (\n  :serverMessageId,\n  :familyId,\n  :senderIdentityId,\n  :recipientIdentityId,\n  :senderDeviceId,\n  :ciphertext,\n  :senderCiphertext,\n  :senderSignature,\n  :clientMessageId,\n  :clientCreatedAt,\n  :createdAt,\n  :createdAt,\n  1,\n  :status,\n  :statusUpdatedAt\n)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO messages (
 *   server_message_id,
 *   family_id,
 *   sender_identity_id,
 *   recipient_identity_id,
 *   sender_device_id,
 *   ciphertext,
 *   sender_ciphertext,
 *   sender_signature,
 *   client_message_id,
 *   client_created_at,
 *   created_at,
 *   content_updated_at,
 *   revision,
 *   status,
 *   status_updated_at
 * ) VALUES (
 *   :serverMessageId,
 *   :familyId,
 *   :senderIdentityId,
 *   :recipientIdentityId,
 *   :senderDeviceId,
 *   :ciphertext,
 *   :senderCiphertext,
 *   :senderSignature,
 *   :clientMessageId,
 *   :clientCreatedAt,
 *   :createdAt,
 *   :createdAt,
 *   1,
 *   :status,
 *   :statusUpdatedAt
 * )
 * ```
 */
export const insertDirectMessage = new PreparedQuery<InsertDirectMessageParams,InsertDirectMessageResult>(insertDirectMessageIR);


/** 'UpdateDirectMessageStatus' parameters type */
export interface UpdateDirectMessageStatusParams {
  familyId?: string | null | void;
  serverMessageId?: string | null | void;
  status?: string | null | void;
  statusUpdatedAt?: NumberOrString | null | void;
}

/** 'UpdateDirectMessageStatus' return type */
export type UpdateDirectMessageStatusResult = void;

/** 'UpdateDirectMessageStatus' query type */
export interface UpdateDirectMessageStatusQuery {
  params: UpdateDirectMessageStatusParams;
  result: UpdateDirectMessageStatusResult;
}

const updateDirectMessageStatusIR: any = {"usedParamSet":{"status":true,"statusUpdatedAt":true,"familyId":true,"serverMessageId":true},"params":[{"name":"status","required":false,"transform":{"type":"scalar"},"locs":[{"a":29,"b":35}]},{"name":"statusUpdatedAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":62,"b":77}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":97,"b":105}]},{"name":"serverMessageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":133,"b":148}]}],"statement":"UPDATE messages\nSET status = :status,\n    status_updated_at = :statusUpdatedAt\nWHERE family_id = :familyId\n  AND server_message_id = :serverMessageId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE messages
 * SET status = :status,
 *     status_updated_at = :statusUpdatedAt
 * WHERE family_id = :familyId
 *   AND server_message_id = :serverMessageId
 * ```
 */
export const updateDirectMessageStatus = new PreparedQuery<UpdateDirectMessageStatusParams,UpdateDirectMessageStatusResult>(updateDirectMessageStatusIR);


/** 'FindDirectMessageById' parameters type */
export interface FindDirectMessageByIdParams {
  familyId?: string | null | void;
  serverMessageId?: string | null | void;
}

/** 'FindDirectMessageById' return type */
export interface FindDirectMessageByIdResult {
  chat_seq: string;
  ciphertext: string;
  client_created_at: string | null;
  client_message_id: string;
  content_updated_at: string;
  created_at: string;
  deleted_at: string | null;
  direct_chat_id: string;
  edited_at: string | null;
  epoch: number | null;
  family_id: string;
  recipient_identity_id: string;
  revision: number;
  sender_ciphertext: string | null;
  sender_device_id: string;
  sender_identity_id: string;
  sender_signature: string;
  server_message_id: string;
  status: string;
  status_updated_at: string;
  temporary_identity_delegation: Json | null;
}

/** 'FindDirectMessageById' query type */
export interface FindDirectMessageByIdQuery {
  params: FindDirectMessageByIdParams;
  result: FindDirectMessageByIdResult;
}

const findDirectMessageByIdIR: any = {"usedParamSet":{"familyId":true,"serverMessageId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":41,"b":49}]},{"name":"serverMessageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":77,"b":92}]}],"statement":"SELECT *\nFROM messages\nWHERE family_id = :familyId\n  AND server_message_id = :serverMessageId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM messages
 * WHERE family_id = :familyId
 *   AND server_message_id = :serverMessageId
 * LIMIT 1
 * ```
 */
export const findDirectMessageById = new PreparedQuery<FindDirectMessageByIdParams,FindDirectMessageByIdResult>(findDirectMessageByIdIR);


/** 'FetchDirectMessagesForSync' parameters type */
export interface FetchDirectMessagesForSyncParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  limit?: NumberOrString | null | void;
  since?: NumberOrString | null | void;
}

/** 'FetchDirectMessagesForSync' return type */
export interface FetchDirectMessagesForSyncResult {
  chat_seq: string;
  ciphertext: string;
  client_created_at: string | null;
  client_message_id: string;
  content_updated_at: string;
  created_at: string;
  deleted_at: string | null;
  direct_chat_id: string;
  edited_at: string | null;
  epoch: number | null;
  family_id: string;
  recipient_identity_id: string;
  revision: number;
  sender_ciphertext: string | null;
  sender_device_id: string;
  sender_identity_id: string;
  sender_signature: string;
  server_message_id: string;
  status: string;
  status_updated_at: string;
  temporary_identity_delegation: Json | null;
}

/** 'FetchDirectMessagesForSync' query type */
export interface FetchDirectMessagesForSyncQuery {
  params: FetchDirectMessagesForSyncParams;
  result: FetchDirectMessagesForSyncResult;
}

const fetchDirectMessagesForSyncIR: any = {"usedParamSet":{"familyId":true,"since":true,"identityId":true,"deviceId":true,"limit":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":41,"b":49}]},{"name":"since","required":false,"transform":{"type":"scalar"},"locs":[{"a":100,"b":105}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":143,"b":153},{"a":184,"b":194}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":220,"b":228}]},{"name":"limit","required":false,"transform":{"type":"scalar"},"locs":[{"a":311,"b":316}]}],"statement":"SELECT *\nFROM messages\nWHERE family_id = :familyId\n  AND GREATEST(created_at, content_updated_at) > :since\n  AND (\n    recipient_identity_id = :identityId\n    OR (sender_identity_id = :identityId AND sender_device_id <> :deviceId)\n  )\nORDER BY GREATEST(created_at, content_updated_at) ASC, created_at ASC\nLIMIT :limit"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM messages
 * WHERE family_id = :familyId
 *   AND GREATEST(created_at, content_updated_at) > :since
 *   AND (
 *     recipient_identity_id = :identityId
 *     OR (sender_identity_id = :identityId AND sender_device_id <> :deviceId)
 *   )
 * ORDER BY GREATEST(created_at, content_updated_at) ASC, created_at ASC
 * LIMIT :limit
 * ```
 */
export const fetchDirectMessagesForSync = new PreparedQuery<FetchDirectMessagesForSyncParams,FetchDirectMessagesForSyncResult>(fetchDirectMessagesForSyncIR);


/** 'FetchDirectMessageStatusUpdatesForSync' parameters type */
export interface FetchDirectMessageStatusUpdatesForSyncParams {
  familyId?: string | null | void;
  limit?: NumberOrString | null | void;
  senderIdentityId?: string | null | void;
  since?: NumberOrString | null | void;
}

/** 'FetchDirectMessageStatusUpdatesForSync' return type */
export interface FetchDirectMessageStatusUpdatesForSyncResult {
  chat_seq: string;
  ciphertext: string;
  client_created_at: string | null;
  client_message_id: string;
  content_updated_at: string;
  created_at: string;
  deleted_at: string | null;
  direct_chat_id: string;
  edited_at: string | null;
  epoch: number | null;
  family_id: string;
  recipient_identity_id: string;
  revision: number;
  sender_ciphertext: string | null;
  sender_device_id: string;
  sender_identity_id: string;
  sender_signature: string;
  server_message_id: string;
  status: string;
  status_updated_at: string;
  temporary_identity_delegation: Json | null;
}

/** 'FetchDirectMessageStatusUpdatesForSync' query type */
export interface FetchDirectMessageStatusUpdatesForSyncQuery {
  params: FetchDirectMessageStatusUpdatesForSyncParams;
  result: FetchDirectMessageStatusUpdatesForSyncResult;
}

const fetchDirectMessageStatusUpdatesForSyncIR: any = {"usedParamSet":{"familyId":true,"senderIdentityId":true,"since":true,"limit":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":41,"b":49}]},{"name":"senderIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":78,"b":94}]},{"name":"since","required":false,"transform":{"type":"scalar"},"locs":[{"a":144,"b":149}]},{"name":"limit","required":false,"transform":{"type":"scalar"},"locs":[{"a":188,"b":193}]}],"statement":"SELECT *\nFROM messages\nWHERE family_id = :familyId\n  AND sender_identity_id = :senderIdentityId\n  AND status <> 'new'\n  AND status_updated_at > :since\nORDER BY status_updated_at ASC\nLIMIT :limit"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM messages
 * WHERE family_id = :familyId
 *   AND sender_identity_id = :senderIdentityId
 *   AND status <> 'new'
 *   AND status_updated_at > :since
 * ORDER BY status_updated_at ASC
 * LIMIT :limit
 * ```
 */
export const fetchDirectMessageStatusUpdatesForSync = new PreparedQuery<FetchDirectMessageStatusUpdatesForSyncParams,FetchDirectMessageStatusUpdatesForSyncResult>(fetchDirectMessageStatusUpdatesForSyncIR);


/** 'FetchReadDirectMessagesForSenderUpTo' parameters type */
export interface FetchReadDirectMessagesForSenderUpToParams {
  familyId?: string | null | void;
  senderIdentityId?: string | null | void;
  syncedThrough?: NumberOrString | null | void;
}

/** 'FetchReadDirectMessagesForSenderUpTo' return type */
export interface FetchReadDirectMessagesForSenderUpToResult {
  chat_seq: string;
  ciphertext: string;
  client_created_at: string | null;
  client_message_id: string;
  content_updated_at: string;
  created_at: string;
  deleted_at: string | null;
  direct_chat_id: string;
  edited_at: string | null;
  epoch: number | null;
  family_id: string;
  recipient_identity_id: string;
  revision: number;
  sender_ciphertext: string | null;
  sender_device_id: string;
  sender_identity_id: string;
  sender_signature: string;
  server_message_id: string;
  status: string;
  status_updated_at: string;
  temporary_identity_delegation: Json | null;
}

/** 'FetchReadDirectMessagesForSenderUpTo' query type */
export interface FetchReadDirectMessagesForSenderUpToQuery {
  params: FetchReadDirectMessagesForSenderUpToParams;
  result: FetchReadDirectMessagesForSenderUpToResult;
}

const fetchReadDirectMessagesForSenderUpToIR: any = {"usedParamSet":{"familyId":true,"senderIdentityId":true,"syncedThrough":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":41,"b":49}]},{"name":"senderIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":78,"b":94}]},{"name":"syncedThrough","required":false,"transform":{"type":"scalar"},"locs":[{"a":145,"b":158}]}],"statement":"SELECT *\nFROM messages\nWHERE family_id = :familyId\n  AND sender_identity_id = :senderIdentityId\n  AND status = 'read'\n  AND status_updated_at <= :syncedThrough"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM messages
 * WHERE family_id = :familyId
 *   AND sender_identity_id = :senderIdentityId
 *   AND status = 'read'
 *   AND status_updated_at <= :syncedThrough
 * ```
 */
export const fetchReadDirectMessagesForSenderUpTo = new PreparedQuery<FetchReadDirectMessagesForSenderUpToParams,FetchReadDirectMessagesForSenderUpToResult>(fetchReadDirectMessagesForSenderUpToIR);


/** 'FindMessageDeviceSyncState' parameters type */
export interface FindMessageDeviceSyncStateParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindMessageDeviceSyncState' return type */
export interface FindMessageDeviceSyncStateResult {
  last_mutation_sync_at: string;
  last_status_sync_at: string;
  last_sync_at: string;
}

/** 'FindMessageDeviceSyncState' query type */
export interface FindMessageDeviceSyncStateQuery {
  params: FindMessageDeviceSyncStateParams;
  result: FindMessageDeviceSyncStateResult;
}

const findMessageDeviceSyncStateIR: any = {"usedParamSet":{"familyId":true,"deviceId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":107,"b":115}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":135,"b":143}]}],"statement":"SELECT last_sync_at, last_status_sync_at, last_mutation_sync_at\nFROM message_device_sync\nWHERE family_id = :familyId\n  AND device_id = :deviceId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT last_sync_at, last_status_sync_at, last_mutation_sync_at
 * FROM message_device_sync
 * WHERE family_id = :familyId
 *   AND device_id = :deviceId
 * ```
 */
export const findMessageDeviceSyncState = new PreparedQuery<FindMessageDeviceSyncStateParams,FindMessageDeviceSyncStateResult>(findMessageDeviceSyncStateIR);


/** 'EnsureMessageDeviceSyncState' parameters type */
export interface EnsureMessageDeviceSyncStateParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'EnsureMessageDeviceSyncState' return type */
export type EnsureMessageDeviceSyncStateResult = void;

/** 'EnsureMessageDeviceSyncState' query type */
export interface EnsureMessageDeviceSyncStateQuery {
  params: EnsureMessageDeviceSyncStateParams;
  result: EnsureMessageDeviceSyncStateResult;
}

const ensureMessageDeviceSyncStateIR: any = {"usedParamSet":{"familyId":true,"deviceId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":121,"b":129}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":132,"b":140}]}],"statement":"INSERT INTO message_device_sync (family_id, device_id, last_sync_at, last_status_sync_at, last_mutation_sync_at)\nVALUES (:familyId, :deviceId, 0, 0, 0)\nON CONFLICT DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO message_device_sync (family_id, device_id, last_sync_at, last_status_sync_at, last_mutation_sync_at)
 * VALUES (:familyId, :deviceId, 0, 0, 0)
 * ON CONFLICT DO NOTHING
 * ```
 */
export const ensureMessageDeviceSyncState = new PreparedQuery<EnsureMessageDeviceSyncStateParams,EnsureMessageDeviceSyncStateResult>(ensureMessageDeviceSyncStateIR);


/** 'UpsertMessageDeviceSyncState' parameters type */
export interface UpsertMessageDeviceSyncStateParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
  lastMutationSyncAt?: NumberOrString | null | void;
  lastStatusSyncAt?: NumberOrString | null | void;
  lastSyncAt?: NumberOrString | null | void;
}

/** 'UpsertMessageDeviceSyncState' return type */
export type UpsertMessageDeviceSyncStateResult = void;

/** 'UpsertMessageDeviceSyncState' query type */
export interface UpsertMessageDeviceSyncStateQuery {
  params: UpsertMessageDeviceSyncStateParams;
  result: UpsertMessageDeviceSyncStateResult;
}

const upsertMessageDeviceSyncStateIR: any = {"usedParamSet":{"familyId":true,"deviceId":true,"lastSyncAt":true,"lastStatusSyncAt":true,"lastMutationSyncAt":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":121,"b":129}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":132,"b":140}]},{"name":"lastSyncAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":143,"b":153}]},{"name":"lastStatusSyncAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":156,"b":172}]},{"name":"lastMutationSyncAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":175,"b":193}]}],"statement":"INSERT INTO message_device_sync (family_id, device_id, last_sync_at, last_status_sync_at, last_mutation_sync_at)\nVALUES (:familyId, :deviceId, :lastSyncAt, :lastStatusSyncAt, :lastMutationSyncAt)\nON CONFLICT (family_id, device_id)\nDO UPDATE SET\n  last_sync_at = GREATEST(message_device_sync.last_sync_at, EXCLUDED.last_sync_at),\n  last_status_sync_at = GREATEST(message_device_sync.last_status_sync_at, EXCLUDED.last_status_sync_at),\n  last_mutation_sync_at = GREATEST(message_device_sync.last_mutation_sync_at, EXCLUDED.last_mutation_sync_at)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO message_device_sync (family_id, device_id, last_sync_at, last_status_sync_at, last_mutation_sync_at)
 * VALUES (:familyId, :deviceId, :lastSyncAt, :lastStatusSyncAt, :lastMutationSyncAt)
 * ON CONFLICT (family_id, device_id)
 * DO UPDATE SET
 *   last_sync_at = GREATEST(message_device_sync.last_sync_at, EXCLUDED.last_sync_at),
 *   last_status_sync_at = GREATEST(message_device_sync.last_status_sync_at, EXCLUDED.last_status_sync_at),
 *   last_mutation_sync_at = GREATEST(message_device_sync.last_mutation_sync_at, EXCLUDED.last_mutation_sync_at)
 * ```
 */
export const upsertMessageDeviceSyncState = new PreparedQuery<UpsertMessageDeviceSyncStateParams,UpsertMessageDeviceSyncStateResult>(upsertMessageDeviceSyncStateIR);


/** 'DeleteDirectMessage' parameters type */
export interface DeleteDirectMessageParams {
  familyId?: string | null | void;
  serverMessageId?: string | null | void;
}

/** 'DeleteDirectMessage' return type */
export type DeleteDirectMessageResult = void;

/** 'DeleteDirectMessage' query type */
export interface DeleteDirectMessageQuery {
  params: DeleteDirectMessageParams;
  result: DeleteDirectMessageResult;
}

const deleteDirectMessageIR: any = {"usedParamSet":{"familyId":true,"serverMessageId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":39,"b":47}]},{"name":"serverMessageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":75,"b":90}]}],"statement":"DELETE FROM messages\nWHERE family_id = :familyId\n  AND server_message_id = :serverMessageId"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM messages
 * WHERE family_id = :familyId
 *   AND server_message_id = :serverMessageId
 * ```
 */
export const deleteDirectMessage = new PreparedQuery<DeleteDirectMessageParams,DeleteDirectMessageResult>(deleteDirectMessageIR);


