/** Types generated for queries found in "src/db/repositories/groupChatRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NumberOrString = number | string;

/** 'InsertGroupChatParticipant' parameters type */
export interface InsertGroupChatParticipantParams {
  addedByIdentityId?: string | null | void;
  chatId?: string | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  joinedAt?: NumberOrString | null | void;
  joinOrder?: number | null | void;
}

/** 'InsertGroupChatParticipant' return type */
export type InsertGroupChatParticipantResult = void;

/** 'InsertGroupChatParticipant' query type */
export interface InsertGroupChatParticipantQuery {
  params: InsertGroupChatParticipantParams;
  result: InsertGroupChatParticipantResult;
}

const insertGroupChatParticipantIR: any = {"usedParamSet":{"chatId":true,"familyId":true,"identityId":true,"addedByIdentityId":true,"joinedAt":true,"joinOrder":true},"params":[{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":138,"b":144}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":147,"b":155}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":158,"b":168}]},{"name":"addedByIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":171,"b":188}]},{"name":"joinedAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":191,"b":199}]},{"name":"joinOrder","required":false,"transform":{"type":"scalar"},"locs":[{"a":208,"b":217}]}],"statement":"INSERT INTO group_chat_participants\n  (chat_id, family_id, identity_id, added_by_identity_id, joined_at, is_active, join_order)\nVALUES\n  (:chatId, :familyId, :identityId, :addedByIdentityId, :joinedAt, TRUE, :joinOrder)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO group_chat_participants
 *   (chat_id, family_id, identity_id, added_by_identity_id, joined_at, is_active, join_order)
 * VALUES
 *   (:chatId, :familyId, :identityId, :addedByIdentityId, :joinedAt, TRUE, :joinOrder)
 * ```
 */
export const insertGroupChatParticipant = new PreparedQuery<InsertGroupChatParticipantParams,InsertGroupChatParticipantResult>(insertGroupChatParticipantIR);


/** 'EnsureGroupChatReadState' parameters type */
export interface EnsureGroupChatReadStateParams {
  chatId?: string | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  lastReadAt?: NumberOrString | null | void;
}

/** 'EnsureGroupChatReadState' return type */
export type EnsureGroupChatReadStateResult = void;

/** 'EnsureGroupChatReadState' query type */
export interface EnsureGroupChatReadStateQuery {
  params: EnsureGroupChatReadStateParams;
  result: EnsureGroupChatReadStateResult;
}

const ensureGroupChatReadStateIR: any = {"usedParamSet":{"chatId":true,"familyId":true,"identityId":true,"lastReadAt":true},"params":[{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":85,"b":91}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":94,"b":102}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":105,"b":115}]},{"name":"lastReadAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":118,"b":128}]}],"statement":"INSERT INTO group_chat_reads (chat_id, family_id, identity_id, last_read_at)\nVALUES (:chatId, :familyId, :identityId, :lastReadAt)\nON CONFLICT DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO group_chat_reads (chat_id, family_id, identity_id, last_read_at)
 * VALUES (:chatId, :familyId, :identityId, :lastReadAt)
 * ON CONFLICT DO NOTHING
 * ```
 */
export const ensureGroupChatReadState = new PreparedQuery<EnsureGroupChatReadStateParams,EnsureGroupChatReadStateResult>(ensureGroupChatReadStateIR);


/** 'FindGroupChat' parameters type */
export interface FindGroupChatParams {
  chatId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindGroupChat' return type */
export interface FindGroupChatResult {
  chat_id: string;
  created_at: string;
  family_id: string;
  key_epoch: number;
  key_epoch_updated_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  owner_identity_id: string;
  /** Opaque gct1 encrypted title; plaintext group titles must never be stored */
  title_ciphertext: string;
  updated_at: string;
}

/** 'FindGroupChat' query type */
export interface FindGroupChatQuery {
  params: FindGroupChatParams;
  result: FindGroupChatResult;
}

const findGroupChatIR: any = {"usedParamSet":{"familyId":true,"chatId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":44,"b":52}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":70,"b":76}]}],"statement":"SELECT *\nFROM group_chats\nWHERE family_id = :familyId\n  AND chat_id = :chatId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM group_chats
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 * LIMIT 1
 * ```
 */
export const findGroupChat = new PreparedQuery<FindGroupChatParams,FindGroupChatResult>(findGroupChatIR);


/** 'FindGroupChatParticipant' parameters type */
export interface FindGroupChatParticipantParams {
  chatId?: string | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'FindGroupChatParticipant' return type */
export interface FindGroupChatParticipantResult {
  added_by_identity_id: string;
  chat_id: string;
  family_id: string;
  identity_id: string;
  is_active: boolean;
  join_order: number;
  joined_at: string;
  left_at: string | null;
  muted: boolean;
}

/** 'FindGroupChatParticipant' query type */
export interface FindGroupChatParticipantQuery {
  params: FindGroupChatParticipantParams;
  result: FindGroupChatParticipantResult;
}

const findGroupChatParticipantIR: any = {"usedParamSet":{"familyId":true,"chatId":true,"identityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":56,"b":64}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":82,"b":88}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":110,"b":120}]}],"statement":"SELECT *\nFROM group_chat_participants\nWHERE family_id = :familyId\n  AND chat_id = :chatId\n  AND identity_id = :identityId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM group_chat_participants
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 *   AND identity_id = :identityId
 * LIMIT 1
 * ```
 */
export const findGroupChatParticipant = new PreparedQuery<FindGroupChatParticipantParams,FindGroupChatParticipantResult>(findGroupChatParticipantIR);


/** 'ListActiveGroupChatParticipants' parameters type */
export interface ListActiveGroupChatParticipantsParams {
  chatId?: string | null | void;
  familyId?: string | null | void;
}

/** 'ListActiveGroupChatParticipants' return type */
export interface ListActiveGroupChatParticipantsResult {
  added_by_identity_id: string;
  chat_id: string;
  family_id: string;
  identity_id: string;
  is_active: boolean;
  join_order: number;
  joined_at: string;
  left_at: string | null;
  muted: boolean;
}

/** 'ListActiveGroupChatParticipants' query type */
export interface ListActiveGroupChatParticipantsQuery {
  params: ListActiveGroupChatParticipantsParams;
  result: ListActiveGroupChatParticipantsResult;
}

const listActiveGroupChatParticipantsIR: any = {"usedParamSet":{"familyId":true,"chatId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":56,"b":64}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":82,"b":88}]}],"statement":"SELECT *\nFROM group_chat_participants\nWHERE family_id = :familyId\n  AND chat_id = :chatId\n  AND is_active = TRUE\nORDER BY join_order ASC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM group_chat_participants
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 *   AND is_active = TRUE
 * ORDER BY join_order ASC
 * ```
 */
export const listActiveGroupChatParticipants = new PreparedQuery<ListActiveGroupChatParticipantsParams,ListActiveGroupChatParticipantsResult>(listActiveGroupChatParticipantsIR);


/** 'SetGroupChatParticipantMuted' parameters type */
export interface SetGroupChatParticipantMutedParams {
  chatId?: string | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  muted?: boolean | null | void;
}

/** 'SetGroupChatParticipantMuted' return type */
export type SetGroupChatParticipantMutedResult = void;

/** 'SetGroupChatParticipantMuted' query type */
export interface SetGroupChatParticipantMutedQuery {
  params: SetGroupChatParticipantMutedParams;
  result: SetGroupChatParticipantMutedResult;
}

const setGroupChatParticipantMutedIR: any = {"usedParamSet":{"muted":true,"familyId":true,"chatId":true,"identityId":true},"params":[{"name":"muted","required":false,"transform":{"type":"scalar"},"locs":[{"a":43,"b":48}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":68,"b":76}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":94,"b":100}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":122,"b":132}]}],"statement":"UPDATE group_chat_participants\nSET muted = :muted\nWHERE family_id = :familyId\n  AND chat_id = :chatId\n  AND identity_id = :identityId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE group_chat_participants
 * SET muted = :muted
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 *   AND identity_id = :identityId
 * ```
 */
export const setGroupChatParticipantMuted = new PreparedQuery<SetGroupChatParticipantMutedParams,SetGroupChatParticipantMutedResult>(setGroupChatParticipantMutedIR);


/** 'ReactivateGroupChatParticipant' parameters type */
export interface ReactivateGroupChatParticipantParams {
  addedByIdentityId?: string | null | void;
  chatId?: string | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  joinedAt?: NumberOrString | null | void;
  joinOrder?: number | null | void;
}

/** 'ReactivateGroupChatParticipant' return type */
export type ReactivateGroupChatParticipantResult = void;

/** 'ReactivateGroupChatParticipant' query type */
export interface ReactivateGroupChatParticipantQuery {
  params: ReactivateGroupChatParticipantParams;
  result: ReactivateGroupChatParticipantResult;
}

const reactivateGroupChatParticipantIR: any = {"usedParamSet":{"joinedAt":true,"addedByIdentityId":true,"joinOrder":true,"familyId":true,"chatId":true,"identityId":true},"params":[{"name":"joinedAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":89,"b":97}]},{"name":"addedByIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":127,"b":144}]},{"name":"joinOrder","required":false,"transform":{"type":"scalar"},"locs":[{"a":164,"b":173}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":193,"b":201}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":219,"b":225}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":247,"b":257}]}],"statement":"UPDATE group_chat_participants\nSET is_active = TRUE,\n    left_at = NULL,\n    joined_at = :joinedAt,\n    added_by_identity_id = :addedByIdentityId,\n    join_order = :joinOrder\nWHERE family_id = :familyId\n  AND chat_id = :chatId\n  AND identity_id = :identityId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE group_chat_participants
 * SET is_active = TRUE,
 *     left_at = NULL,
 *     joined_at = :joinedAt,
 *     added_by_identity_id = :addedByIdentityId,
 *     join_order = :joinOrder
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 *   AND identity_id = :identityId
 * ```
 */
export const reactivateGroupChatParticipant = new PreparedQuery<ReactivateGroupChatParticipantParams,ReactivateGroupChatParticipantResult>(reactivateGroupChatParticipantIR);


/** 'RemoveGroupChatParticipant' parameters type */
export interface RemoveGroupChatParticipantParams {
  chatId?: string | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  leftAt?: NumberOrString | null | void;
}

/** 'RemoveGroupChatParticipant' return type */
export type RemoveGroupChatParticipantResult = void;

/** 'RemoveGroupChatParticipant' query type */
export interface RemoveGroupChatParticipantQuery {
  params: RemoveGroupChatParticipantParams;
  result: RemoveGroupChatParticipantResult;
}

const removeGroupChatParticipantIR: any = {"usedParamSet":{"leftAt":true,"familyId":true,"chatId":true,"identityId":true},"params":[{"name":"leftAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":68,"b":74}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":94,"b":102}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":120,"b":126}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":148,"b":158}]}],"statement":"UPDATE group_chat_participants\nSET is_active = FALSE,\n    left_at = :leftAt\nWHERE family_id = :familyId\n  AND chat_id = :chatId\n  AND identity_id = :identityId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE group_chat_participants
 * SET is_active = FALSE,
 *     left_at = :leftAt
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 *   AND identity_id = :identityId
 * ```
 */
export const removeGroupChatParticipant = new PreparedQuery<RemoveGroupChatParticipantParams,RemoveGroupChatParticipantResult>(removeGroupChatParticipantIR);


/** 'FindGroupChatMessageByClientMessageId' parameters type */
export interface FindGroupChatMessageByClientMessageIdParams {
  chatId?: string | null | void;
  clientMessageId?: string | null | void;
  familyId?: string | null | void;
  senderDeviceId?: string | null | void;
}

/** 'FindGroupChatMessageByClientMessageId' return type */
export interface FindGroupChatMessageByClientMessageIdResult {
  created_at: string;
  message_id: string;
}

/** 'FindGroupChatMessageByClientMessageId' query type */
export interface FindGroupChatMessageByClientMessageIdQuery {
  params: FindGroupChatMessageByClientMessageIdParams;
  result: FindGroupChatMessageByClientMessageIdResult;
}

const findGroupChatMessageByClientMessageIdIR: any = {"usedParamSet":{"familyId":true,"chatId":true,"senderDeviceId":true,"clientMessageId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":73,"b":81}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":99,"b":105}]},{"name":"senderDeviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":132,"b":146}]},{"name":"clientMessageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":174,"b":189}]}],"statement":"SELECT message_id, created_at\nFROM group_chat_messages\nWHERE family_id = :familyId\n  AND chat_id = :chatId\n  AND sender_device_id = :senderDeviceId\n  AND client_message_id = :clientMessageId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT message_id, created_at
 * FROM group_chat_messages
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 *   AND sender_device_id = :senderDeviceId
 *   AND client_message_id = :clientMessageId
 * LIMIT 1
 * ```
 */
export const findGroupChatMessageByClientMessageId = new PreparedQuery<FindGroupChatMessageByClientMessageIdParams,FindGroupChatMessageByClientMessageIdResult>(findGroupChatMessageByClientMessageIdIR);


/** 'InsertGroupChatMessage' parameters type */
export interface InsertGroupChatMessageParams {
  chatId?: string | null | void;
  ciphertext?: string | null | void;
  clientCreatedAt?: NumberOrString | null | void;
  clientMessageId?: string | null | void;
  createdAt?: NumberOrString | null | void;
  epoch?: number | null | void;
  familyId?: string | null | void;
  kind?: string | null | void;
  messageId?: string | null | void;
  senderDeviceId?: string | null | void;
  senderIdentityId?: string | null | void;
  senderSignature?: string | null | void;
  systemPayloadJson?: string | null | void;
  systemType?: string | null | void;
}

/** 'InsertGroupChatMessage' return type */
export type InsertGroupChatMessageResult = void;

/** 'InsertGroupChatMessage' query type */
export interface InsertGroupChatMessageQuery {
  params: InsertGroupChatMessageParams;
  result: InsertGroupChatMessageResult;
}

const insertGroupChatMessageIR: any = {"usedParamSet":{"messageId":true,"familyId":true,"chatId":true,"senderIdentityId":true,"senderDeviceId":true,"kind":true,"ciphertext":true,"senderSignature":true,"clientMessageId":true,"clientCreatedAt":true,"createdAt":true,"systemType":true,"systemPayloadJson":true,"epoch":true},"params":[{"name":"messageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":272,"b":281}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":284,"b":292}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":295,"b":301}]},{"name":"senderIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":304,"b":320}]},{"name":"senderDeviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":323,"b":337}]},{"name":"kind","required":false,"transform":{"type":"scalar"},"locs":[{"a":340,"b":344}]},{"name":"ciphertext","required":false,"transform":{"type":"scalar"},"locs":[{"a":347,"b":357}]},{"name":"senderSignature","required":false,"transform":{"type":"scalar"},"locs":[{"a":360,"b":375}]},{"name":"clientMessageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":378,"b":393}]},{"name":"clientCreatedAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":396,"b":411}]},{"name":"createdAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":414,"b":423},{"a":426,"b":435}]},{"name":"systemType","required":false,"transform":{"type":"scalar"},"locs":[{"a":441,"b":451}]},{"name":"systemPayloadJson","required":false,"transform":{"type":"scalar"},"locs":[{"a":454,"b":471}]},{"name":"epoch","required":false,"transform":{"type":"scalar"},"locs":[{"a":474,"b":479}]}],"statement":"INSERT INTO group_chat_messages\n  (message_id, family_id, chat_id, sender_identity_id, sender_device_id, kind, ciphertext, sender_signature, client_message_id, client_created_at, created_at, content_updated_at, revision, system_type, system_payload_json, epoch)\nVALUES\n  (:messageId, :familyId, :chatId, :senderIdentityId, :senderDeviceId, :kind, :ciphertext, :senderSignature, :clientMessageId, :clientCreatedAt, :createdAt, :createdAt, 1, :systemType, :systemPayloadJson, :epoch)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO group_chat_messages
 *   (message_id, family_id, chat_id, sender_identity_id, sender_device_id, kind, ciphertext, sender_signature, client_message_id, client_created_at, created_at, content_updated_at, revision, system_type, system_payload_json, epoch)
 * VALUES
 *   (:messageId, :familyId, :chatId, :senderIdentityId, :senderDeviceId, :kind, :ciphertext, :senderSignature, :clientMessageId, :clientCreatedAt, :createdAt, :createdAt, 1, :systemType, :systemPayloadJson, :epoch)
 * ```
 */
export const insertGroupChatMessage = new PreparedQuery<InsertGroupChatMessageParams,InsertGroupChatMessageResult>(insertGroupChatMessageIR);


/** 'UpdateGroupChatPreview' parameters type */
export interface UpdateGroupChatPreviewParams {
  chatId?: string | null | void;
  createdAt?: NumberOrString | null | void;
  familyId?: string | null | void;
  preview?: string | null | void;
}

/** 'UpdateGroupChatPreview' return type */
export type UpdateGroupChatPreviewResult = void;

/** 'UpdateGroupChatPreview' query type */
export interface UpdateGroupChatPreviewQuery {
  params: UpdateGroupChatPreviewParams;
  result: UpdateGroupChatPreviewResult;
}

const updateGroupChatPreviewIR: any = {"usedParamSet":{"createdAt":true,"preview":true,"familyId":true,"chatId":true},"params":[{"name":"createdAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":41,"b":50},{"a":70,"b":79}]},{"name":"preview","required":false,"transform":{"type":"scalar"},"locs":[{"a":109,"b":116}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":136,"b":144}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":162,"b":168}]}],"statement":"UPDATE group_chats\nSET last_message_at = :createdAt,\n    updated_at = :createdAt,\n    last_message_preview = :preview\nWHERE family_id = :familyId\n  AND chat_id = :chatId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE group_chats
 * SET last_message_at = :createdAt,
 *     updated_at = :createdAt,
 *     last_message_preview = :preview
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 * ```
 */
export const updateGroupChatPreview = new PreparedQuery<UpdateGroupChatPreviewParams,UpdateGroupChatPreviewResult>(updateGroupChatPreviewIR);


/** 'ListGroupChatMessages' parameters type */
export interface ListGroupChatMessagesParams {
  chatId?: string | null | void;
  familyId?: string | null | void;
  limit?: NumberOrString | null | void;
  since?: NumberOrString | null | void;
}

/** 'ListGroupChatMessages' return type */
export interface ListGroupChatMessagesResult {
  chat_id: string;
  chat_seq: string;
  ciphertext: string | null;
  client_created_at: string | null;
  client_message_id: string | null;
  content_updated_at: string;
  created_at: string;
  deleted_at: string | null;
  edited_at: string | null;
  epoch: number;
  family_id: string;
  kind: string;
  message_id: string;
  revision: number;
  sender_device_id: string | null;
  sender_identity_id: string | null;
  sender_signature: string | null;
  system_payload_json: string | null;
  system_type: string | null;
  temporary_identity_delegation: Json | null;
}

/** 'ListGroupChatMessages' query type */
export interface ListGroupChatMessagesQuery {
  params: ListGroupChatMessagesParams;
  result: ListGroupChatMessagesResult;
}

const listGroupChatMessagesIR: any = {"usedParamSet":{"familyId":true,"chatId":true,"since":true,"limit":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":52,"b":60}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":78,"b":84}]},{"name":"since","required":false,"transform":{"type":"scalar"},"locs":[{"a":135,"b":140}]},{"name":"limit","required":false,"transform":{"type":"scalar"},"locs":[{"a":218,"b":223}]}],"statement":"SELECT *\nFROM group_chat_messages\nWHERE family_id = :familyId\n  AND chat_id = :chatId\n  AND GREATEST(created_at, content_updated_at) > :since\nORDER BY GREATEST(created_at, content_updated_at) ASC, created_at ASC\nLIMIT :limit"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM group_chat_messages
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 *   AND GREATEST(created_at, content_updated_at) > :since
 * ORDER BY GREATEST(created_at, content_updated_at) ASC, created_at ASC
 * LIMIT :limit
 * ```
 */
export const listGroupChatMessages = new PreparedQuery<ListGroupChatMessagesParams,ListGroupChatMessagesResult>(listGroupChatMessagesIR);


/** 'UpsertGroupChatRead' parameters type */
export interface UpsertGroupChatReadParams {
  chatId?: string | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  readAt?: NumberOrString | null | void;
}

/** 'UpsertGroupChatRead' return type */
export type UpsertGroupChatReadResult = void;

/** 'UpsertGroupChatRead' query type */
export interface UpsertGroupChatReadQuery {
  params: UpsertGroupChatReadParams;
  result: UpsertGroupChatReadResult;
}

const upsertGroupChatReadIR: any = {"usedParamSet":{"chatId":true,"familyId":true,"identityId":true,"readAt":true},"params":[{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":85,"b":91}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":94,"b":102}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":105,"b":115}]},{"name":"readAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":118,"b":124}]}],"statement":"INSERT INTO group_chat_reads (chat_id, family_id, identity_id, last_read_at)\nVALUES (:chatId, :familyId, :identityId, :readAt)\nON CONFLICT (chat_id, family_id, identity_id)\nDO UPDATE SET last_read_at = GREATEST(group_chat_reads.last_read_at, EXCLUDED.last_read_at)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO group_chat_reads (chat_id, family_id, identity_id, last_read_at)
 * VALUES (:chatId, :familyId, :identityId, :readAt)
 * ON CONFLICT (chat_id, family_id, identity_id)
 * DO UPDATE SET last_read_at = GREATEST(group_chat_reads.last_read_at, EXCLUDED.last_read_at)
 * ```
 */
export const upsertGroupChatRead = new PreparedQuery<UpsertGroupChatReadParams,UpsertGroupChatReadResult>(upsertGroupChatReadIR);


/** 'UpsertGroupChatKeyEnvelope' parameters type */
export interface UpsertGroupChatKeyEnvelopeParams {
  chatId?: string | null | void;
  createdAt?: NumberOrString | null | void;
  envelopeCiphertext?: string | null | void;
  epoch?: number | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
  publisherIdentityId?: string | null | void;
}

/** 'UpsertGroupChatKeyEnvelope' return type */
export type UpsertGroupChatKeyEnvelopeResult = void;

/** 'UpsertGroupChatKeyEnvelope' query type */
export interface UpsertGroupChatKeyEnvelopeQuery {
  params: UpsertGroupChatKeyEnvelopeParams;
  result: UpsertGroupChatKeyEnvelopeResult;
}

const upsertGroupChatKeyEnvelopeIR: any = {"usedParamSet":{"chatId":true,"familyId":true,"epoch":true,"identityId":true,"envelopeCiphertext":true,"publisherIdentityId":true,"createdAt":true},"params":[{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":142,"b":148}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":151,"b":159}]},{"name":"epoch","required":false,"transform":{"type":"scalar"},"locs":[{"a":162,"b":167}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":170,"b":180}]},{"name":"envelopeCiphertext","required":false,"transform":{"type":"scalar"},"locs":[{"a":183,"b":201}]},{"name":"publisherIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":204,"b":223}]},{"name":"createdAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":226,"b":235}]}],"statement":"INSERT INTO group_chat_key_envelopes (chat_id, family_id, epoch, identity_id, envelope_ciphertext, publisher_identity_id, created_at)\nVALUES (:chatId, :familyId, :epoch, :identityId, :envelopeCiphertext, :publisherIdentityId, :createdAt)\nON CONFLICT (chat_id, family_id, epoch, identity_id)\nDO UPDATE SET\n  envelope_ciphertext = EXCLUDED.envelope_ciphertext,\n  publisher_identity_id = EXCLUDED.publisher_identity_id,\n  created_at = EXCLUDED.created_at"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO group_chat_key_envelopes (chat_id, family_id, epoch, identity_id, envelope_ciphertext, publisher_identity_id, created_at)
 * VALUES (:chatId, :familyId, :epoch, :identityId, :envelopeCiphertext, :publisherIdentityId, :createdAt)
 * ON CONFLICT (chat_id, family_id, epoch, identity_id)
 * DO UPDATE SET
 *   envelope_ciphertext = EXCLUDED.envelope_ciphertext,
 *   publisher_identity_id = EXCLUDED.publisher_identity_id,
 *   created_at = EXCLUDED.created_at
 * ```
 */
export const upsertGroupChatKeyEnvelope = new PreparedQuery<UpsertGroupChatKeyEnvelopeParams,UpsertGroupChatKeyEnvelopeResult>(upsertGroupChatKeyEnvelopeIR);


/** 'FindGroupChatKeyEnvelopeForIdentity' parameters type */
export interface FindGroupChatKeyEnvelopeForIdentityParams {
  chatId?: string | null | void;
  epoch?: number | null | void;
  familyId?: string | null | void;
  identityId?: string | null | void;
}

/** 'FindGroupChatKeyEnvelopeForIdentity' return type */
export interface FindGroupChatKeyEnvelopeForIdentityResult {
  chat_id: string;
  created_at: string;
  envelope_ciphertext: string;
  epoch: number;
  family_id: string;
  identity_id: string;
  publisher_identity_id: string;
}

/** 'FindGroupChatKeyEnvelopeForIdentity' query type */
export interface FindGroupChatKeyEnvelopeForIdentityQuery {
  params: FindGroupChatKeyEnvelopeForIdentityParams;
  result: FindGroupChatKeyEnvelopeForIdentityResult;
}

const findGroupChatKeyEnvelopeForIdentityIR: any = {"usedParamSet":{"familyId":true,"chatId":true,"epoch":true,"identityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":150,"b":158}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":176,"b":182}]},{"name":"epoch","required":false,"transform":{"type":"scalar"},"locs":[{"a":198,"b":203}]},{"name":"identityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":225,"b":235}]}],"statement":"SELECT chat_id, family_id, epoch, identity_id, envelope_ciphertext, publisher_identity_id, created_at\nFROM group_chat_key_envelopes\nWHERE family_id = :familyId\n  AND chat_id = :chatId\n  AND epoch = :epoch\n  AND identity_id = :identityId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT chat_id, family_id, epoch, identity_id, envelope_ciphertext, publisher_identity_id, created_at
 * FROM group_chat_key_envelopes
 * WHERE family_id = :familyId
 *   AND chat_id = :chatId
 *   AND epoch = :epoch
 *   AND identity_id = :identityId
 * LIMIT 1
 * ```
 */
export const findGroupChatKeyEnvelopeForIdentity = new PreparedQuery<FindGroupChatKeyEnvelopeForIdentityParams,FindGroupChatKeyEnvelopeForIdentityResult>(findGroupChatKeyEnvelopeForIdentityIR);


/** 'FindGroupChatEpochKeyCommitment' parameters type */
export interface FindGroupChatEpochKeyCommitmentParams {
  chatId?: string | null | void;
  epoch?: number | null | void;
  familyId?: string | null | void;
}

/** 'FindGroupChatEpochKeyCommitment' return type */
export interface FindGroupChatEpochKeyCommitmentResult {
  key_commitment: string;
}

/** 'FindGroupChatEpochKeyCommitment' query type */
export interface FindGroupChatEpochKeyCommitmentQuery {
  params: FindGroupChatEpochKeyCommitmentParams;
  result: FindGroupChatEpochKeyCommitmentResult;
}

const findGroupChatEpochKeyCommitmentIR: any = {"usedParamSet":{"chatId":true,"familyId":true,"epoch":true},"params":[{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":65,"b":71}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":91,"b":99}]},{"name":"epoch","required":false,"transform":{"type":"scalar"},"locs":[{"a":115,"b":120}]}],"statement":"SELECT key_commitment\nFROM group_chat_epoch_keys\nWHERE chat_id = :chatId\n  AND family_id = :familyId\n  AND epoch = :epoch\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT key_commitment
 * FROM group_chat_epoch_keys
 * WHERE chat_id = :chatId
 *   AND family_id = :familyId
 *   AND epoch = :epoch
 * LIMIT 1
 * ```
 */
export const findGroupChatEpochKeyCommitment = new PreparedQuery<FindGroupChatEpochKeyCommitmentParams,FindGroupChatEpochKeyCommitmentResult>(findGroupChatEpochKeyCommitmentIR);


/** 'ListActiveGroupChatParticipantsWithIdentityKeys' parameters type */
export interface ListActiveGroupChatParticipantsWithIdentityKeysParams {
  chatId?: string | null | void;
  familyId?: string | null | void;
}

/** 'ListActiveGroupChatParticipantsWithIdentityKeys' return type */
export interface ListActiveGroupChatParticipantsWithIdentityKeysResult {
  identity_id: string;
  join_order: number;
  joined_at: string;
  public_key_algorithm: string;
  public_key_value: string;
}

/** 'ListActiveGroupChatParticipantsWithIdentityKeys' query type */
export interface ListActiveGroupChatParticipantsWithIdentityKeysQuery {
  params: ListActiveGroupChatParticipantsWithIdentityKeysParams;
  result: ListActiveGroupChatParticipantsWithIdentityKeysResult;
}

const listActiveGroupChatParticipantsWithIdentityKeysIR: any = {"usedParamSet":{"familyId":true,"chatId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":245,"b":253}]},{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":279,"b":285}]}],"statement":"SELECT p.identity_id, p.join_order, p.joined_at, i.public_key_algorithm, i.public_key_value\nFROM group_chat_participants p\nJOIN identities i\n  ON i.identity_id = p.identity_id\n AND i.family_id::text = p.family_id::text\nWHERE p.family_id::text = :familyId::text\n  AND p.chat_id = :chatId::text\n  AND p.is_active = TRUE\nORDER BY p.join_order ASC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT p.identity_id, p.join_order, p.joined_at, i.public_key_algorithm, i.public_key_value
 * FROM group_chat_participants p
 * JOIN identities i
 *   ON i.identity_id = p.identity_id
 *  AND i.family_id::text = p.family_id::text
 * WHERE p.family_id::text = :familyId::text
 *   AND p.chat_id = :chatId::text
 *   AND p.is_active = TRUE
 * ORDER BY p.join_order ASC
 * ```
 */
export const listActiveGroupChatParticipantsWithIdentityKeys = new PreparedQuery<ListActiveGroupChatParticipantsWithIdentityKeysParams,ListActiveGroupChatParticipantsWithIdentityKeysResult>(listActiveGroupChatParticipantsWithIdentityKeysIR);


/** 'FindGroupChatEpochKey' parameters type */
export interface FindGroupChatEpochKeyParams {
  chatId?: string | null | void;
  epoch?: number | null | void;
  familyId?: string | null | void;
}

/** 'FindGroupChatEpochKey' return type */
export interface FindGroupChatEpochKeyResult {
  chat_id: string;
  created_at: string;
  epoch: number;
  family_id: string;
  key_commitment: string;
  proposer_device_id: string | null;
  proposer_identity_id: string;
  signed_epoch_transition: Json | null;
}

/** 'FindGroupChatEpochKey' query type */
export interface FindGroupChatEpochKeyQuery {
  params: FindGroupChatEpochKeyParams;
  result: FindGroupChatEpochKeyResult;
}

const findGroupChatEpochKeyIR: any = {"usedParamSet":{"chatId":true,"familyId":true,"epoch":true},"params":[{"name":"chatId","required":false,"transform":{"type":"scalar"},"locs":[{"a":171,"b":177}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":197,"b":205}]},{"name":"epoch","required":false,"transform":{"type":"scalar"},"locs":[{"a":221,"b":226}]}],"statement":"SELECT chat_id, family_id, epoch, key_commitment, proposer_identity_id, proposer_device_id, signed_epoch_transition, created_at\nFROM group_chat_epoch_keys\nWHERE chat_id = :chatId\n  AND family_id = :familyId\n  AND epoch = :epoch\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT chat_id, family_id, epoch, key_commitment, proposer_identity_id, proposer_device_id, signed_epoch_transition, created_at
 * FROM group_chat_epoch_keys
 * WHERE chat_id = :chatId
 *   AND family_id = :familyId
 *   AND epoch = :epoch
 * LIMIT 1
 * ```
 */
export const findGroupChatEpochKey = new PreparedQuery<FindGroupChatEpochKeyParams,FindGroupChatEpochKeyResult>(findGroupChatEpochKeyIR);


