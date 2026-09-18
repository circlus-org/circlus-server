/** Types generated for queries found in "src/db/repositories/directGuestRegistrationRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** 'CreateDirectGuestRegistration' parameters type */
export interface CreateDirectGuestRegistrationParams {
  canCall?: boolean | null | void;
  canDirectFileTransfer?: boolean | null | void;
  canMessage?: boolean | null | void;
  canServerAttachments?: boolean | null | void;
  familyId?: string | null | void;
  guestCanCallHost?: boolean | null | void;
  guestCanDirectFileTransferHost?: boolean | null | void;
  guestCanMessageHost?: boolean | null | void;
  guestCanServerAttachmentsHost?: boolean | null | void;
  guestIdentityId?: string | null | void;
  hostCanCallGuest?: boolean | null | void;
  hostCanDirectFileTransferGuest?: boolean | null | void;
  hostCanMessageGuest?: boolean | null | void;
  hostCanServerAttachmentsGuest?: boolean | null | void;
  hostIdentityId?: string | null | void;
  linkId?: string | null | void;
  registrationId?: string | null | void;
}

/** 'CreateDirectGuestRegistration' return type */
export interface CreateDirectGuestRegistrationResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  guest_identity_id: string;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  last_seen_at: Date | null;
  link_id: string;
  registration_id: string;
  revoked_at: Date | null;
  status: string;
  updated_at: Date;
}

/** 'CreateDirectGuestRegistration' query type */
export interface CreateDirectGuestRegistrationQuery {
  params: CreateDirectGuestRegistrationParams;
  result: CreateDirectGuestRegistrationResult;
}

const createDirectGuestRegistrationIR: any = {"usedParamSet":{"registrationId":true,"familyId":true,"linkId":true,"hostIdentityId":true,"guestIdentityId":true,"canMessage":true,"canCall":true,"canDirectFileTransfer":true,"canServerAttachments":true,"hostCanMessageGuest":true,"guestCanMessageHost":true,"hostCanCallGuest":true,"guestCanCallHost":true,"hostCanDirectFileTransferGuest":true,"guestCanDirectFileTransferHost":true,"hostCanServerAttachmentsGuest":true,"guestCanServerAttachmentsHost":true},"params":[{"name":"registrationId","required":false,"transform":{"type":"scalar"},"locs":[{"a":468,"b":482}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":487,"b":495}]},{"name":"linkId","required":false,"transform":{"type":"scalar"},"locs":[{"a":500,"b":506}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":511,"b":525}]},{"name":"guestIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":530,"b":545}]},{"name":"canMessage","required":false,"transform":{"type":"scalar"},"locs":[{"a":550,"b":560}]},{"name":"canCall","required":false,"transform":{"type":"scalar"},"locs":[{"a":565,"b":572}]},{"name":"canDirectFileTransfer","required":false,"transform":{"type":"scalar"},"locs":[{"a":577,"b":598}]},{"name":"canServerAttachments","required":false,"transform":{"type":"scalar"},"locs":[{"a":603,"b":623}]},{"name":"hostCanMessageGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":628,"b":647}]},{"name":"guestCanMessageHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":652,"b":671}]},{"name":"hostCanCallGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":676,"b":692}]},{"name":"guestCanCallHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":697,"b":713}]},{"name":"hostCanDirectFileTransferGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":718,"b":748}]},{"name":"guestCanDirectFileTransferHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":753,"b":783}]},{"name":"hostCanServerAttachmentsGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":788,"b":817}]},{"name":"guestCanServerAttachmentsHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":822,"b":851}]}],"statement":"INSERT INTO direct_guest_registrations (\n  registration_id,\n  family_id,\n  link_id,\n  host_identity_id,\n  guest_identity_id,\n  can_message,\n  can_call,\n  can_direct_file_transfer,\n  can_server_attachments,\n  host_can_message_guest,\n  guest_can_message_host,\n  host_can_call_guest,\n  guest_can_call_host,\n  host_can_direct_file_transfer_guest,\n  guest_can_direct_file_transfer_host,\n  host_can_server_attachments_guest,\n  guest_can_server_attachments_host\n) VALUES (\n  :registrationId,\n  :familyId,\n  :linkId,\n  :hostIdentityId,\n  :guestIdentityId,\n  :canMessage,\n  :canCall,\n  :canDirectFileTransfer,\n  :canServerAttachments,\n  :hostCanMessageGuest,\n  :guestCanMessageHost,\n  :hostCanCallGuest,\n  :guestCanCallHost,\n  :hostCanDirectFileTransferGuest,\n  :guestCanDirectFileTransferHost,\n  :hostCanServerAttachmentsGuest,\n  :guestCanServerAttachmentsHost\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO direct_guest_registrations (
 *   registration_id,
 *   family_id,
 *   link_id,
 *   host_identity_id,
 *   guest_identity_id,
 *   can_message,
 *   can_call,
 *   can_direct_file_transfer,
 *   can_server_attachments,
 *   host_can_message_guest,
 *   guest_can_message_host,
 *   host_can_call_guest,
 *   guest_can_call_host,
 *   host_can_direct_file_transfer_guest,
 *   guest_can_direct_file_transfer_host,
 *   host_can_server_attachments_guest,
 *   guest_can_server_attachments_host
 * ) VALUES (
 *   :registrationId,
 *   :familyId,
 *   :linkId,
 *   :hostIdentityId,
 *   :guestIdentityId,
 *   :canMessage,
 *   :canCall,
 *   :canDirectFileTransfer,
 *   :canServerAttachments,
 *   :hostCanMessageGuest,
 *   :guestCanMessageHost,
 *   :hostCanCallGuest,
 *   :guestCanCallHost,
 *   :hostCanDirectFileTransferGuest,
 *   :guestCanDirectFileTransferHost,
 *   :hostCanServerAttachmentsGuest,
 *   :guestCanServerAttachmentsHost
 * ) RETURNING *
 * ```
 */
export const createDirectGuestRegistration = new PreparedQuery<CreateDirectGuestRegistrationParams,CreateDirectGuestRegistrationResult>(createDirectGuestRegistrationIR);


/** 'ListDirectGuestRegistrationsByLink' parameters type */
export interface ListDirectGuestRegistrationsByLinkParams {
  familyId?: string | null | void;
  hostIdentityId?: string | null | void;
  linkId?: string | null | void;
}

/** 'ListDirectGuestRegistrationsByLink' return type */
export interface ListDirectGuestRegistrationsByLinkResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  guest_identity_id: string;
  guest_identity_name: string | null;
  guest_public_key_algorithm: string;
  guest_public_key_value: string;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  last_seen_at: Date | null;
  link_id: string;
  registration_id: string;
  revoked_at: Date | null;
  status: string;
  updated_at: Date;
}

/** 'ListDirectGuestRegistrationsByLink' query type */
export interface ListDirectGuestRegistrationsByLinkQuery {
  params: ListDirectGuestRegistrationsByLinkParams;
  result: ListDirectGuestRegistrationsByLinkResult;
}

const listDirectGuestRegistrationsByLinkIR: any = {"usedParamSet":{"familyId":true,"linkId":true,"hostIdentityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":320,"b":328}]},{"name":"linkId","required":false,"transform":{"type":"scalar"},"locs":[{"a":348,"b":354}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":383,"b":397}]}],"statement":"SELECT r.*,\n       i.identity_name AS guest_identity_name,\n       i.public_key_algorithm AS guest_public_key_algorithm,\n       i.public_key_value AS guest_public_key_value\nFROM direct_guest_registrations r\nLEFT JOIN identities i\n  ON i.family_id = r.family_id AND i.identity_id = r.guest_identity_id\nWHERE r.family_id = :familyId\n  AND r.link_id = :linkId\n  AND r.host_identity_id = :hostIdentityId\nORDER BY r.created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT r.*,
 *        i.identity_name AS guest_identity_name,
 *        i.public_key_algorithm AS guest_public_key_algorithm,
 *        i.public_key_value AS guest_public_key_value
 * FROM direct_guest_registrations r
 * LEFT JOIN identities i
 *   ON i.family_id = r.family_id AND i.identity_id = r.guest_identity_id
 * WHERE r.family_id = :familyId
 *   AND r.link_id = :linkId
 *   AND r.host_identity_id = :hostIdentityId
 * ORDER BY r.created_at DESC
 * ```
 */
export const listDirectGuestRegistrationsByLink = new PreparedQuery<ListDirectGuestRegistrationsByLinkParams,ListDirectGuestRegistrationsByLinkResult>(listDirectGuestRegistrationsByLinkIR);


/** 'FindActiveDirectGuestRegistrationByPair' parameters type */
export interface FindActiveDirectGuestRegistrationByPairParams {
  familyId?: string | null | void;
  identityA?: string | null | void;
  identityB?: string | null | void;
}

/** 'FindActiveDirectGuestRegistrationByPair' return type */
export interface FindActiveDirectGuestRegistrationByPairResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  guest_identity_id: string;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  last_seen_at: Date | null;
  link_id: string;
  registration_id: string;
  revoked_at: Date | null;
  status: string;
  updated_at: Date;
}

/** 'FindActiveDirectGuestRegistrationByPair' query type */
export interface FindActiveDirectGuestRegistrationByPairQuery {
  params: FindActiveDirectGuestRegistrationByPairParams;
  result: FindActiveDirectGuestRegistrationByPairResult;
}

const findActiveDirectGuestRegistrationByPairIR: any = {"usedParamSet":{"familyId":true,"identityA":true,"identityB":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":59,"b":67}]},{"name":"identityA","required":false,"transform":{"type":"scalar"},"locs":[{"a":125,"b":134},{"a":238,"b":247}]},{"name":"identityB","required":false,"transform":{"type":"scalar"},"locs":[{"a":160,"b":169},{"a":203,"b":212}]}],"statement":"SELECT *\nFROM direct_guest_registrations\nWHERE family_id = :familyId\n  AND status = 'active'\n  AND (\n    (host_identity_id = :identityA AND guest_identity_id = :identityB)\n    OR\n    (host_identity_id = :identityB AND guest_identity_id = :identityA)\n  )\nORDER BY created_at DESC\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM direct_guest_registrations
 * WHERE family_id = :familyId
 *   AND status = 'active'
 *   AND (
 *     (host_identity_id = :identityA AND guest_identity_id = :identityB)
 *     OR
 *     (host_identity_id = :identityB AND guest_identity_id = :identityA)
 *   )
 * ORDER BY created_at DESC
 * LIMIT 1
 * ```
 */
export const findActiveDirectGuestRegistrationByPair = new PreparedQuery<FindActiveDirectGuestRegistrationByPairParams,FindActiveDirectGuestRegistrationByPairResult>(findActiveDirectGuestRegistrationByPairIR);


/** 'FindActiveDirectGuestRegistrationByHost' parameters type */
export interface FindActiveDirectGuestRegistrationByHostParams {
  familyId?: string | null | void;
  hostIdentityId?: string | null | void;
  registrationId?: string | null | void;
}

/** 'FindActiveDirectGuestRegistrationByHost' return type */
export interface FindActiveDirectGuestRegistrationByHostResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  guest_identity_id: string;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  last_seen_at: Date | null;
  link_id: string;
  registration_id: string;
  revoked_at: Date | null;
  status: string;
  updated_at: Date;
}

/** 'FindActiveDirectGuestRegistrationByHost' query type */
export interface FindActiveDirectGuestRegistrationByHostQuery {
  params: FindActiveDirectGuestRegistrationByHostParams;
  result: FindActiveDirectGuestRegistrationByHostResult;
}

const findActiveDirectGuestRegistrationByHostIR: any = {"usedParamSet":{"familyId":true,"registrationId":true,"hostIdentityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":59,"b":67}]},{"name":"registrationId","required":false,"transform":{"type":"scalar"},"locs":[{"a":93,"b":107}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":134,"b":148}]}],"statement":"SELECT *\nFROM direct_guest_registrations\nWHERE family_id = :familyId\n  AND registration_id = :registrationId\n  AND host_identity_id = :hostIdentityId\n  AND status = 'active'\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM direct_guest_registrations
 * WHERE family_id = :familyId
 *   AND registration_id = :registrationId
 *   AND host_identity_id = :hostIdentityId
 *   AND status = 'active'
 * LIMIT 1
 * ```
 */
export const findActiveDirectGuestRegistrationByHost = new PreparedQuery<FindActiveDirectGuestRegistrationByHostParams,FindActiveDirectGuestRegistrationByHostResult>(findActiveDirectGuestRegistrationByHostIR);


/** 'RevokeDirectGuestRegistrationByHost' parameters type */
export interface RevokeDirectGuestRegistrationByHostParams {
  familyId?: string | null | void;
  hostIdentityId?: string | null | void;
  registrationId?: string | null | void;
}

/** 'RevokeDirectGuestRegistrationByHost' return type */
export interface RevokeDirectGuestRegistrationByHostResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  guest_identity_id: string;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  last_seen_at: Date | null;
  link_id: string;
  registration_id: string;
  revoked_at: Date | null;
  status: string;
  updated_at: Date;
}

/** 'RevokeDirectGuestRegistrationByHost' query type */
export interface RevokeDirectGuestRegistrationByHostQuery {
  params: RevokeDirectGuestRegistrationByHostParams;
  result: RevokeDirectGuestRegistrationByHostResult;
}

const revokeDirectGuestRegistrationByHostIR: any = {"usedParamSet":{"familyId":true,"registrationId":true,"hostIdentityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":131,"b":139}]},{"name":"registrationId","required":false,"transform":{"type":"scalar"},"locs":[{"a":165,"b":179}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":206,"b":220}]}],"statement":"UPDATE direct_guest_registrations\nSET status = 'deleted_by_host',\n    revoked_at = NOW(),\n    updated_at = NOW()\nWHERE family_id = :familyId\n  AND registration_id = :registrationId\n  AND host_identity_id = :hostIdentityId\n  AND status = 'active'\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE direct_guest_registrations
 * SET status = 'deleted_by_host',
 *     revoked_at = NOW(),
 *     updated_at = NOW()
 * WHERE family_id = :familyId
 *   AND registration_id = :registrationId
 *   AND host_identity_id = :hostIdentityId
 *   AND status = 'active'
 * RETURNING *
 * ```
 */
export const revokeDirectGuestRegistrationByHost = new PreparedQuery<RevokeDirectGuestRegistrationByHostParams,RevokeDirectGuestRegistrationByHostResult>(revokeDirectGuestRegistrationByHostIR);


/** 'UpdateDirectGuestRegistrationPermissionsByHost' parameters type */
export interface UpdateDirectGuestRegistrationPermissionsByHostParams {
  canCall?: boolean | null | void;
  canDirectFileTransfer?: boolean | null | void;
  canMessage?: boolean | null | void;
  canServerAttachments?: boolean | null | void;
  familyId?: string | null | void;
  guestCanCallHost?: boolean | null | void;
  guestCanDirectFileTransferHost?: boolean | null | void;
  guestCanMessageHost?: boolean | null | void;
  guestCanServerAttachmentsHost?: boolean | null | void;
  hostCanCallGuest?: boolean | null | void;
  hostCanDirectFileTransferGuest?: boolean | null | void;
  hostCanMessageGuest?: boolean | null | void;
  hostCanServerAttachmentsGuest?: boolean | null | void;
  hostIdentityId?: string | null | void;
  registrationId?: string | null | void;
}

/** 'UpdateDirectGuestRegistrationPermissionsByHost' return type */
export interface UpdateDirectGuestRegistrationPermissionsByHostResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  guest_identity_id: string;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  last_seen_at: Date | null;
  link_id: string;
  registration_id: string;
  revoked_at: Date | null;
  status: string;
  updated_at: Date;
}

/** 'UpdateDirectGuestRegistrationPermissionsByHost' query type */
export interface UpdateDirectGuestRegistrationPermissionsByHostQuery {
  params: UpdateDirectGuestRegistrationPermissionsByHostParams;
  result: UpdateDirectGuestRegistrationPermissionsByHostResult;
}

const updateDirectGuestRegistrationPermissionsByHostIR: any = {"usedParamSet":{"canMessage":true,"canCall":true,"canDirectFileTransfer":true,"canServerAttachments":true,"hostCanMessageGuest":true,"guestCanMessageHost":true,"hostCanCallGuest":true,"guestCanCallHost":true,"hostCanDirectFileTransferGuest":true,"guestCanDirectFileTransferHost":true,"hostCanServerAttachmentsGuest":true,"guestCanServerAttachmentsHost":true,"familyId":true,"registrationId":true,"hostIdentityId":true},"params":[{"name":"canMessage","required":false,"transform":{"type":"scalar"},"locs":[{"a":52,"b":62}]},{"name":"canCall","required":false,"transform":{"type":"scalar"},"locs":[{"a":80,"b":87}]},{"name":"canDirectFileTransfer","required":false,"transform":{"type":"scalar"},"locs":[{"a":121,"b":142}]},{"name":"canServerAttachments","required":false,"transform":{"type":"scalar"},"locs":[{"a":174,"b":194}]},{"name":"hostCanMessageGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":226,"b":245}]},{"name":"guestCanMessageHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":277,"b":296}]},{"name":"hostCanCallGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":325,"b":341}]},{"name":"guestCanCallHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":370,"b":386}]},{"name":"hostCanDirectFileTransferGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":431,"b":461}]},{"name":"guestCanDirectFileTransferHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":506,"b":536}]},{"name":"hostCanServerAttachmentsGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":579,"b":608}]},{"name":"guestCanServerAttachmentsHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":651,"b":680}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":724,"b":732}]},{"name":"registrationId","required":false,"transform":{"type":"scalar"},"locs":[{"a":758,"b":772}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":799,"b":813}]}],"statement":"UPDATE direct_guest_registrations\nSET can_message = :canMessage,\n    can_call = :canCall,\n    can_direct_file_transfer = :canDirectFileTransfer,\n    can_server_attachments = :canServerAttachments,\n    host_can_message_guest = :hostCanMessageGuest,\n    guest_can_message_host = :guestCanMessageHost,\n    host_can_call_guest = :hostCanCallGuest,\n    guest_can_call_host = :guestCanCallHost,\n    host_can_direct_file_transfer_guest = :hostCanDirectFileTransferGuest,\n    guest_can_direct_file_transfer_host = :guestCanDirectFileTransferHost,\n    host_can_server_attachments_guest = :hostCanServerAttachmentsGuest,\n    guest_can_server_attachments_host = :guestCanServerAttachmentsHost,\n    updated_at = NOW()\nWHERE family_id = :familyId\n  AND registration_id = :registrationId\n  AND host_identity_id = :hostIdentityId\n  AND status = 'active'\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE direct_guest_registrations
 * SET can_message = :canMessage,
 *     can_call = :canCall,
 *     can_direct_file_transfer = :canDirectFileTransfer,
 *     can_server_attachments = :canServerAttachments,
 *     host_can_message_guest = :hostCanMessageGuest,
 *     guest_can_message_host = :guestCanMessageHost,
 *     host_can_call_guest = :hostCanCallGuest,
 *     guest_can_call_host = :guestCanCallHost,
 *     host_can_direct_file_transfer_guest = :hostCanDirectFileTransferGuest,
 *     guest_can_direct_file_transfer_host = :guestCanDirectFileTransferHost,
 *     host_can_server_attachments_guest = :hostCanServerAttachmentsGuest,
 *     guest_can_server_attachments_host = :guestCanServerAttachmentsHost,
 *     updated_at = NOW()
 * WHERE family_id = :familyId
 *   AND registration_id = :registrationId
 *   AND host_identity_id = :hostIdentityId
 *   AND status = 'active'
 * RETURNING *
 * ```
 */
export const updateDirectGuestRegistrationPermissionsByHost = new PreparedQuery<UpdateDirectGuestRegistrationPermissionsByHostParams,UpdateDirectGuestRegistrationPermissionsByHostResult>(updateDirectGuestRegistrationPermissionsByHostIR);


/** 'SelfDeleteDirectGuestRegistration' parameters type */
export interface SelfDeleteDirectGuestRegistrationParams {
  familyId?: string | null | void;
  guestIdentityId?: string | null | void;
}

/** 'SelfDeleteDirectGuestRegistration' return type */
export interface SelfDeleteDirectGuestRegistrationResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  guest_identity_id: string;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  last_seen_at: Date | null;
  link_id: string;
  registration_id: string;
  revoked_at: Date | null;
  status: string;
  updated_at: Date;
}

/** 'SelfDeleteDirectGuestRegistration' query type */
export interface SelfDeleteDirectGuestRegistrationQuery {
  params: SelfDeleteDirectGuestRegistrationParams;
  result: SelfDeleteDirectGuestRegistrationResult;
}

const selfDeleteDirectGuestRegistrationIR: any = {"usedParamSet":{"familyId":true,"guestIdentityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":132,"b":140}]},{"name":"guestIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":168,"b":183}]}],"statement":"UPDATE direct_guest_registrations\nSET status = 'deleted_by_guest',\n    revoked_at = NOW(),\n    updated_at = NOW()\nWHERE family_id = :familyId\n  AND guest_identity_id = :guestIdentityId\n  AND status = 'active'\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE direct_guest_registrations
 * SET status = 'deleted_by_guest',
 *     revoked_at = NOW(),
 *     updated_at = NOW()
 * WHERE family_id = :familyId
 *   AND guest_identity_id = :guestIdentityId
 *   AND status = 'active'
 * RETURNING *
 * ```
 */
export const selfDeleteDirectGuestRegistration = new PreparedQuery<SelfDeleteDirectGuestRegistrationParams,SelfDeleteDirectGuestRegistrationResult>(selfDeleteDirectGuestRegistrationIR);


/** 'TouchDirectGuestRegistrationLastSeen' parameters type */
export interface TouchDirectGuestRegistrationLastSeenParams {
  familyId?: string | null | void;
  guestIdentityId?: string | null | void;
}

/** 'TouchDirectGuestRegistrationLastSeen' return type */
export type TouchDirectGuestRegistrationLastSeenResult = void;

/** 'TouchDirectGuestRegistrationLastSeen' query type */
export interface TouchDirectGuestRegistrationLastSeenQuery {
  params: TouchDirectGuestRegistrationLastSeenParams;
  result: TouchDirectGuestRegistrationLastSeenResult;
}

const touchDirectGuestRegistrationLastSeenIR: any = {"usedParamSet":{"familyId":true,"guestIdentityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":101,"b":109}]},{"name":"guestIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":137,"b":152}]}],"statement":"UPDATE direct_guest_registrations\nSET last_seen_at = NOW(),\n    updated_at = NOW()\nWHERE family_id = :familyId\n  AND guest_identity_id = :guestIdentityId\n  AND status = 'active'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE direct_guest_registrations
 * SET last_seen_at = NOW(),
 *     updated_at = NOW()
 * WHERE family_id = :familyId
 *   AND guest_identity_id = :guestIdentityId
 *   AND status = 'active'
 * ```
 */
export const touchDirectGuestRegistrationLastSeen = new PreparedQuery<TouchDirectGuestRegistrationLastSeenParams,TouchDirectGuestRegistrationLastSeenResult>(touchDirectGuestRegistrationLastSeenIR);


/** 'RevokeAllDirectGuestRegistrationsByLink' parameters type */
export interface RevokeAllDirectGuestRegistrationsByLinkParams {
  familyId?: string | null | void;
  linkId?: string | null | void;
}

/** 'RevokeAllDirectGuestRegistrationsByLink' return type */
export type RevokeAllDirectGuestRegistrationsByLinkResult = void;

/** 'RevokeAllDirectGuestRegistrationsByLink' query type */
export interface RevokeAllDirectGuestRegistrationsByLinkQuery {
  params: RevokeAllDirectGuestRegistrationsByLinkParams;
  result: RevokeAllDirectGuestRegistrationsByLinkResult;
}

const revokeAllDirectGuestRegistrationsByLinkIR: any = {"usedParamSet":{"familyId":true,"linkId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":123,"b":131}]},{"name":"linkId","required":false,"transform":{"type":"scalar"},"locs":[{"a":149,"b":155}]}],"statement":"UPDATE direct_guest_registrations\nSET status = 'revoked',\n    revoked_at = NOW(),\n    updated_at = NOW()\nWHERE family_id = :familyId\n  AND link_id = :linkId\n  AND status = 'active'"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE direct_guest_registrations
 * SET status = 'revoked',
 *     revoked_at = NOW(),
 *     updated_at = NOW()
 * WHERE family_id = :familyId
 *   AND link_id = :linkId
 *   AND status = 'active'
 * ```
 */
export const revokeAllDirectGuestRegistrationsByLink = new PreparedQuery<RevokeAllDirectGuestRegistrationsByLinkParams,RevokeAllDirectGuestRegistrationsByLinkResult>(revokeAllDirectGuestRegistrationsByLinkIR);


