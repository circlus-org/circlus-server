/** Types generated for queries found in "src/db/repositories/directGuestLinkRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 'CreateDirectGuestLink' parameters type */
export interface CreateDirectGuestLinkParams {
  canCall?: boolean | null | void;
  canDirectFileTransfer?: boolean | null | void;
  canMessage?: boolean | null | void;
  canServerAttachments?: boolean | null | void;
  createdByIdentityId?: string | null | void;
  encryptedSecret?: Json | null | void;
  familyId?: string | null | void;
  guestCanCallHost?: boolean | null | void;
  guestCanDirectFileTransferHost?: boolean | null | void;
  guestCanMessageHost?: boolean | null | void;
  guestCanServerAttachmentsHost?: boolean | null | void;
  autoSubscribeToChannel?: boolean | null | void;
  hostCanCallGuest?: boolean | null | void;
  hostCanDirectFileTransferGuest?: boolean | null | void;
  hostCanMessageGuest?: boolean | null | void;
  hostCanServerAttachmentsGuest?: boolean | null | void;
  hostIdentityId?: string | null | void;
  linkId?: string | null | void;
  maxUses?: number | null | void;
  presentationDescription?: string | null | void;
  presentationImageUrl?: string | null | void;
  presentationTitle?: string | null | void;
  publicSiteChannelSlug?: string | null | void;
  publicSiteCtaLabel?: string | null | void;
  publicSiteGuestLinkUrl?: string | null | void;
  publicSiteIntroImageUrl?: string | null | void;
  publicSiteIntroText?: string | null | void;
  publicSiteIntroTitle?: string | null | void;
  publicSiteVisible?: boolean | null | void;
  secretHash?: string | null | void;
  title?: string | null | void;
}

/** 'CreateDirectGuestLink' return type */
export interface CreateDirectGuestLinkResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  created_by_identity_id: string;
  encrypted_secret: Json | null;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  auto_subscribe_to_channel: boolean;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  link_id: string;
  max_uses: number | null;
  presentation_description: string | null;
  presentation_image_url: string | null;
  presentation_title: string | null;
  public_site_channel_slug: string | null;
  public_site_cta_label: string | null;
  public_site_guest_link_url: string | null;
  public_site_intro_image_url: string | null;
  public_site_intro_text: string | null;
  public_site_intro_title: string | null;
  public_site_visible: boolean;
  revoked_at: Date | null;
  secret_hash: string;
  status: string;
  title: string | null;
  updated_at: Date;
}

/** 'CreateDirectGuestLink' query type */
export interface CreateDirectGuestLinkQuery {
  params: CreateDirectGuestLinkParams;
  result: CreateDirectGuestLinkResult;
}

const createDirectGuestLinkIR: any = {"usedParamSet":{"linkId":true,"familyId":true,"hostIdentityId":true,"createdByIdentityId":true,"secretHash":true,"encryptedSecret":true,"canMessage":true,"canCall":true,"canDirectFileTransfer":true,"canServerAttachments":true,"title":true,"presentationTitle":true,"presentationDescription":true,"presentationImageUrl":true,"maxUses":true,"hostCanMessageGuest":true,"guestCanMessageHost":true,"hostCanCallGuest":true,"guestCanCallHost":true,"hostCanDirectFileTransferGuest":true,"guestCanDirectFileTransferHost":true,"hostCanServerAttachmentsGuest":true,"guestCanServerAttachmentsHost":true,"autoSubscribeToChannel":true,"publicSiteVisible":true,"publicSiteChannelSlug":true,"publicSiteCtaLabel":true,"publicSiteIntroTitle":true,"publicSiteIntroText":true,"publicSiteIntroImageUrl":true,"publicSiteGuestLinkUrl":true},"params":[{"name":"linkId","required":false,"transform":{"type":"scalar"},"locs":[{"a":805,"b":811}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":816,"b":824}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":829,"b":843}]},{"name":"createdByIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":848,"b":867}]},{"name":"secretHash","required":false,"transform":{"type":"scalar"},"locs":[{"a":872,"b":882}]},{"name":"encryptedSecret","required":false,"transform":{"type":"scalar"},"locs":[{"a":887,"b":902}]},{"name":"canMessage","required":false,"transform":{"type":"scalar"},"locs":[{"a":907,"b":917}]},{"name":"canCall","required":false,"transform":{"type":"scalar"},"locs":[{"a":922,"b":929}]},{"name":"canDirectFileTransfer","required":false,"transform":{"type":"scalar"},"locs":[{"a":934,"b":955}]},{"name":"canServerAttachments","required":false,"transform":{"type":"scalar"},"locs":[{"a":960,"b":980}]},{"name":"title","required":false,"transform":{"type":"scalar"},"locs":[{"a":985,"b":990}]},{"name":"presentationTitle","required":false,"transform":{"type":"scalar"},"locs":[{"a":995,"b":1012}]},{"name":"presentationDescription","required":false,"transform":{"type":"scalar"},"locs":[{"a":1017,"b":1040}]},{"name":"presentationImageUrl","required":false,"transform":{"type":"scalar"},"locs":[{"a":1045,"b":1065}]},{"name":"maxUses","required":false,"transform":{"type":"scalar"},"locs":[{"a":1070,"b":1077}]},{"name":"hostCanMessageGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":1082,"b":1101}]},{"name":"guestCanMessageHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":1106,"b":1125}]},{"name":"hostCanCallGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":1130,"b":1146}]},{"name":"guestCanCallHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":1151,"b":1167}]},{"name":"hostCanDirectFileTransferGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":1172,"b":1202}]},{"name":"guestCanDirectFileTransferHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":1207,"b":1237}]},{"name":"hostCanServerAttachmentsGuest","required":false,"transform":{"type":"scalar"},"locs":[{"a":1242,"b":1271}]},{"name":"guestCanServerAttachmentsHost","required":false,"transform":{"type":"scalar"},"locs":[{"a":1276,"b":1305}]},{"name":"autoSubscribeToChannel","required":false,"transform":{"type":"scalar"},"locs":[{"a":1310,"b":1338}]},{"name":"publicSiteVisible","required":false,"transform":{"type":"scalar"},"locs":[{"a":1343,"b":1360}]},{"name":"publicSiteChannelSlug","required":false,"transform":{"type":"scalar"},"locs":[{"a":1365,"b":1386}]},{"name":"publicSiteCtaLabel","required":false,"transform":{"type":"scalar"},"locs":[{"a":1391,"b":1409}]},{"name":"publicSiteIntroTitle","required":false,"transform":{"type":"scalar"},"locs":[{"a":1414,"b":1434}]},{"name":"publicSiteIntroText","required":false,"transform":{"type":"scalar"},"locs":[{"a":1439,"b":1458}]},{"name":"publicSiteIntroImageUrl","required":false,"transform":{"type":"scalar"},"locs":[{"a":1463,"b":1486}]},{"name":"publicSiteGuestLinkUrl","required":false,"transform":{"type":"scalar"},"locs":[{"a":1491,"b":1513}]}],"statement":"INSERT INTO direct_guest_links (\n  link_id,\n  family_id,\n  host_identity_id,\n  created_by_identity_id,\n  secret_hash,\n  encrypted_secret,\n  can_message,\n  can_call,\n  can_direct_file_transfer,\n  can_server_attachments,\n  title,\n  presentation_title,\n  presentation_description,\n  presentation_image_url,\n  max_uses,\n  host_can_message_guest,\n  guest_can_message_host,\n  host_can_call_guest,\n  guest_can_call_host,\n  host_can_direct_file_transfer_guest,\n  guest_can_direct_file_transfer_host,\n  host_can_server_attachments_guest,\n  guest_can_server_attachments_host,\n  auto_subscribe_to_channel,\n  public_site_visible,\n  public_site_channel_slug,\n  public_site_cta_label,\n  public_site_intro_title,\n  public_site_intro_text,\n  public_site_intro_image_url,\n  public_site_guest_link_url\n) VALUES (\n  :linkId,\n  :familyId,\n  :hostIdentityId,\n  :createdByIdentityId,\n  :secretHash,\n  :encryptedSecret,\n  :canMessage,\n  :canCall,\n  :canDirectFileTransfer,\n  :canServerAttachments,\n  :title,\n  :presentationTitle,\n  :presentationDescription,\n  :presentationImageUrl,\n  :maxUses,\n  :hostCanMessageGuest,\n  :guestCanMessageHost,\n  :hostCanCallGuest,\n  :guestCanCallHost,\n  :hostCanDirectFileTransferGuest,\n  :guestCanDirectFileTransferHost,\n  :hostCanServerAttachmentsGuest,\n  :guestCanServerAttachmentsHost,\n  :autoSubscribeToChannel,\n  :publicSiteVisible,\n  :publicSiteChannelSlug,\n  :publicSiteCtaLabel,\n  :publicSiteIntroTitle,\n  :publicSiteIntroText,\n  :publicSiteIntroImageUrl,\n  :publicSiteGuestLinkUrl\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO direct_guest_links (
 *   link_id,
 *   family_id,
 *   host_identity_id,
 *   created_by_identity_id,
 *   secret_hash,
 *   encrypted_secret,
 *   can_message,
 *   can_call,
 *   can_direct_file_transfer,
 *   can_server_attachments,
 *   title,
 *   presentation_title,
 *   presentation_description,
 *   presentation_image_url,
 *   max_uses,
 *   host_can_message_guest,
 *   guest_can_message_host,
 *   host_can_call_guest,
 *   guest_can_call_host,
 *   host_can_direct_file_transfer_guest,
 *   guest_can_direct_file_transfer_host,
 *   host_can_server_attachments_guest,
 *   guest_can_server_attachments_host,
 *   auto_subscribe_to_channel,
 *   public_site_visible,
 *   public_site_channel_slug,
 *   public_site_cta_label,
 *   public_site_intro_title,
 *   public_site_intro_text,
 *   public_site_intro_image_url,
 *   public_site_guest_link_url
 * ) VALUES (
 *   :linkId,
 *   :familyId,
 *   :hostIdentityId,
 *   :createdByIdentityId,
 *   :secretHash,
 *   :encryptedSecret,
 *   :canMessage,
 *   :canCall,
 *   :canDirectFileTransfer,
 *   :canServerAttachments,
 *   :title,
 *   :presentationTitle,
 *   :presentationDescription,
 *   :presentationImageUrl,
 *   :maxUses,
 *   :hostCanMessageGuest,
 *   :guestCanMessageHost,
 *   :hostCanCallGuest,
 *   :guestCanCallHost,
 *   :hostCanDirectFileTransferGuest,
 *   :guestCanDirectFileTransferHost,
 *   :hostCanServerAttachmentsGuest,
 *   :guestCanServerAttachmentsHost,
 *   :autoSubscribeToChannel,
 *   :publicSiteVisible,
 *   :publicSiteChannelSlug,
 *   :publicSiteCtaLabel,
 *   :publicSiteIntroTitle,
 *   :publicSiteIntroText,
 *   :publicSiteIntroImageUrl,
 *   :publicSiteGuestLinkUrl
 * ) RETURNING *
 * ```
 */
export const createDirectGuestLink = new PreparedQuery<CreateDirectGuestLinkParams,CreateDirectGuestLinkResult>(createDirectGuestLinkIR);


/** 'FindDirectGuestLinkById' parameters type */
export interface FindDirectGuestLinkByIdParams {
  familyId?: string | null | void;
  linkId?: string | null | void;
}

/** 'FindDirectGuestLinkById' return type */
export interface FindDirectGuestLinkByIdResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  created_by_identity_id: string;
  encrypted_secret: Json | null;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  auto_subscribe_to_channel: boolean;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  link_id: string;
  max_uses: number | null;
  presentation_description: string | null;
  presentation_image_url: string | null;
  presentation_title: string | null;
  public_site_channel_slug: string | null;
  public_site_cta_label: string | null;
  public_site_guest_link_url: string | null;
  public_site_intro_image_url: string | null;
  public_site_intro_text: string | null;
  public_site_intro_title: string | null;
  public_site_visible: boolean;
  revoked_at: Date | null;
  secret_hash: string;
  status: string;
  title: string | null;
  updated_at: Date;
}

/** 'FindDirectGuestLinkById' query type */
export interface FindDirectGuestLinkByIdQuery {
  params: FindDirectGuestLinkByIdParams;
  result: FindDirectGuestLinkByIdResult;
}

const findDirectGuestLinkByIdIR: any = {"usedParamSet":{"familyId":true,"linkId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":51,"b":59}]},{"name":"linkId","required":false,"transform":{"type":"scalar"},"locs":[{"a":77,"b":83}]}],"statement":"SELECT *\nFROM direct_guest_links\nWHERE family_id = :familyId\n  AND link_id = :linkId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT *
 * FROM direct_guest_links
 * WHERE family_id = :familyId
 *   AND link_id = :linkId
 * LIMIT 1
 * ```
 */
export const findDirectGuestLinkById = new PreparedQuery<FindDirectGuestLinkByIdParams,FindDirectGuestLinkByIdResult>(findDirectGuestLinkByIdIR);


/** 'ListDirectGuestLinksByHostIdentity' parameters type */
export interface ListDirectGuestLinksByHostIdentityParams {
  familyId?: string | null | void;
  hostIdentityId?: string | null | void;
}

/** 'ListDirectGuestLinksByHostIdentity' return type */
export interface ListDirectGuestLinksByHostIdentityResult {
  active_registration_count: string | null;
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  created_by_identity_id: string;
  encrypted_secret: Json | null;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  auto_subscribe_to_channel: boolean;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  link_id: string;
  max_uses: number | null;
  presentation_description: string | null;
  presentation_image_url: string | null;
  presentation_title: string | null;
  public_site_channel_slug: string | null;
  public_site_cta_label: string | null;
  public_site_guest_link_url: string | null;
  public_site_intro_image_url: string | null;
  public_site_intro_text: string | null;
  public_site_intro_title: string | null;
  public_site_visible: boolean;
  registration_count: string | null;
  revoked_at: Date | null;
  secret_hash: string;
  status: string;
  title: string | null;
  updated_at: Date;
}

/** 'ListDirectGuestLinksByHostIdentity' query type */
export interface ListDirectGuestLinksByHostIdentityQuery {
  params: ListDirectGuestLinksByHostIdentityParams;
  result: ListDirectGuestLinksByHostIdentityResult;
}

const listDirectGuestLinksByHostIdentityIR: any = {"usedParamSet":{"familyId":true,"hostIdentityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":301,"b":309}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":338,"b":352}]}],"statement":"SELECT l.*,\n       COUNT(r.registration_id)::text AS registration_count,\n       COUNT(*) FILTER (WHERE r.status = 'active')::text AS active_registration_count\nFROM direct_guest_links l\nLEFT JOIN direct_guest_registrations r\n  ON r.family_id = l.family_id AND r.link_id = l.link_id\nWHERE l.family_id = :familyId\n  AND l.host_identity_id = :hostIdentityId\nGROUP BY l.link_id\nORDER BY l.created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT l.*,
 *        COUNT(r.registration_id)::text AS registration_count,
 *        COUNT(*) FILTER (WHERE r.status = 'active')::text AS active_registration_count
 * FROM direct_guest_links l
 * LEFT JOIN direct_guest_registrations r
 *   ON r.family_id = l.family_id AND r.link_id = l.link_id
 * WHERE l.family_id = :familyId
 *   AND l.host_identity_id = :hostIdentityId
 * GROUP BY l.link_id
 * ORDER BY l.created_at DESC
 * ```
 */
export const listDirectGuestLinksByHostIdentity = new PreparedQuery<ListDirectGuestLinksByHostIdentityParams,ListDirectGuestLinksByHostIdentityResult>(listDirectGuestLinksByHostIdentityIR);


/** 'RevokeDirectGuestLink' parameters type */
export interface RevokeDirectGuestLinkParams {
  familyId?: string | null | void;
  hostIdentityId?: string | null | void;
  linkId?: string | null | void;
}

/** 'RevokeDirectGuestLink' return type */
export interface RevokeDirectGuestLinkResult {
  can_call: boolean;
  can_direct_file_transfer: boolean;
  can_message: boolean;
  can_server_attachments: boolean;
  created_at: Date;
  created_by_identity_id: string;
  encrypted_secret: Json | null;
  family_id: string;
  guest_can_call_host: boolean;
  guest_can_direct_file_transfer_host: boolean;
  guest_can_message_host: boolean;
  guest_can_server_attachments_host: boolean;
  auto_subscribe_to_channel: boolean;
  host_can_call_guest: boolean;
  host_can_direct_file_transfer_guest: boolean;
  host_can_message_guest: boolean;
  host_can_server_attachments_guest: boolean;
  host_identity_id: string;
  link_id: string;
  max_uses: number | null;
  presentation_description: string | null;
  presentation_image_url: string | null;
  presentation_title: string | null;
  public_site_channel_slug: string | null;
  public_site_cta_label: string | null;
  public_site_guest_link_url: string | null;
  public_site_intro_image_url: string | null;
  public_site_intro_text: string | null;
  public_site_intro_title: string | null;
  public_site_visible: boolean;
  revoked_at: Date | null;
  secret_hash: string;
  status: string;
  title: string | null;
  updated_at: Date;
}

/** 'RevokeDirectGuestLink' query type */
export interface RevokeDirectGuestLinkQuery {
  params: RevokeDirectGuestLinkParams;
  result: RevokeDirectGuestLinkResult;
}

const revokeDirectGuestLinkIR: any = {"usedParamSet":{"familyId":true,"linkId":true,"hostIdentityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":115,"b":123}]},{"name":"linkId","required":false,"transform":{"type":"scalar"},"locs":[{"a":141,"b":147}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":174,"b":188}]}],"statement":"UPDATE direct_guest_links\nSET status = 'revoked',\n    revoked_at = NOW(),\n    updated_at = NOW()\nWHERE family_id = :familyId\n  AND link_id = :linkId\n  AND host_identity_id = :hostIdentityId\n  AND status = 'active'\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE direct_guest_links
 * SET status = 'revoked',
 *     revoked_at = NOW(),
 *     updated_at = NOW()
 * WHERE family_id = :familyId
 *   AND link_id = :linkId
 *   AND host_identity_id = :hostIdentityId
 *   AND status = 'active'
 * RETURNING *
 * ```
 */
export const revokeDirectGuestLink = new PreparedQuery<RevokeDirectGuestLinkParams,RevokeDirectGuestLinkResult>(revokeDirectGuestLinkIR);


/** 'GetDirectGuestLinkDefaults' parameters type */
export interface GetDirectGuestLinkDefaultsParams {
  familyId?: string | null | void;
  hostIdentityId?: string | null | void;
}

/** 'GetDirectGuestLinkDefaults' return type */
export interface GetDirectGuestLinkDefaultsResult {
  presentation_description: string | null;
  presentation_image_url: string | null;
  presentation_title: string | null;
}

/** 'GetDirectGuestLinkDefaults' query type */
export interface GetDirectGuestLinkDefaultsQuery {
  params: GetDirectGuestLinkDefaultsParams;
  result: GetDirectGuestLinkDefaultsResult;
}

const getDirectGuestLinkDefaultsIR: any = {"usedParamSet":{"familyId":true,"hostIdentityId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":126,"b":134}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":161,"b":175}]}],"statement":"SELECT presentation_title, presentation_description, presentation_image_url\nFROM direct_guest_link_defaults\nWHERE family_id = :familyId\n  AND host_identity_id = :hostIdentityId\nLIMIT 1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT presentation_title, presentation_description, presentation_image_url
 * FROM direct_guest_link_defaults
 * WHERE family_id = :familyId
 *   AND host_identity_id = :hostIdentityId
 * LIMIT 1
 * ```
 */
export const getDirectGuestLinkDefaults = new PreparedQuery<GetDirectGuestLinkDefaultsParams,GetDirectGuestLinkDefaultsResult>(getDirectGuestLinkDefaultsIR);


/** 'UpsertDirectGuestLinkDefaults' parameters type */
export interface UpsertDirectGuestLinkDefaultsParams {
  familyId?: string | null | void;
  hostIdentityId?: string | null | void;
  presentationDescription?: string | null | void;
  presentationImageUrl?: string | null | void;
  presentationTitle?: string | null | void;
}

/** 'UpsertDirectGuestLinkDefaults' return type */
export interface UpsertDirectGuestLinkDefaultsResult {
  presentation_description: string | null;
  presentation_image_url: string | null;
  presentation_title: string | null;
}

/** 'UpsertDirectGuestLinkDefaults' query type */
export interface UpsertDirectGuestLinkDefaultsQuery {
  params: UpsertDirectGuestLinkDefaultsParams;
  result: UpsertDirectGuestLinkDefaultsResult;
}

const upsertDirectGuestLinkDefaultsIR: any = {"usedParamSet":{"familyId":true,"hostIdentityId":true,"presentationTitle":true,"presentationDescription":true,"presentationImageUrl":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":162,"b":170}]},{"name":"hostIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":175,"b":189}]},{"name":"presentationTitle","required":false,"transform":{"type":"scalar"},"locs":[{"a":194,"b":211}]},{"name":"presentationDescription","required":false,"transform":{"type":"scalar"},"locs":[{"a":216,"b":239}]},{"name":"presentationImageUrl","required":false,"transform":{"type":"scalar"},"locs":[{"a":244,"b":264}]}],"statement":"INSERT INTO direct_guest_link_defaults (\n  family_id,\n  host_identity_id,\n  presentation_title,\n  presentation_description,\n  presentation_image_url\n) VALUES (\n  :familyId,\n  :hostIdentityId,\n  :presentationTitle,\n  :presentationDescription,\n  :presentationImageUrl\n)\nON CONFLICT (family_id, host_identity_id) DO UPDATE\nSET presentation_title = EXCLUDED.presentation_title,\n    presentation_description = EXCLUDED.presentation_description,\n    presentation_image_url = EXCLUDED.presentation_image_url,\n    updated_at = NOW()\nRETURNING presentation_title, presentation_description, presentation_image_url"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO direct_guest_link_defaults (
 *   family_id,
 *   host_identity_id,
 *   presentation_title,
 *   presentation_description,
 *   presentation_image_url
 * ) VALUES (
 *   :familyId,
 *   :hostIdentityId,
 *   :presentationTitle,
 *   :presentationDescription,
 *   :presentationImageUrl
 * )
 * ON CONFLICT (family_id, host_identity_id) DO UPDATE
 * SET presentation_title = EXCLUDED.presentation_title,
 *     presentation_description = EXCLUDED.presentation_description,
 *     presentation_image_url = EXCLUDED.presentation_image_url,
 *     updated_at = NOW()
 * RETURNING presentation_title, presentation_description, presentation_image_url
 * ```
 */
export const upsertDirectGuestLinkDefaults = new PreparedQuery<UpsertDirectGuestLinkDefaultsParams,UpsertDirectGuestLinkDefaultsResult>(upsertDirectGuestLinkDefaultsIR);


/** 'RevokeExhaustedDirectGuestLink' parameters type */
export interface RevokeExhaustedDirectGuestLinkParams {
  familyId?: string | null | void;
  linkId?: string | null | void;
}

/** 'RevokeExhaustedDirectGuestLink' return type */
export type RevokeExhaustedDirectGuestLinkResult = void;

/** 'RevokeExhaustedDirectGuestLink' query type */
export interface RevokeExhaustedDirectGuestLinkQuery {
  params: RevokeExhaustedDirectGuestLinkParams;
  result: RevokeExhaustedDirectGuestLinkResult;
}

const revokeExhaustedDirectGuestLinkIR: any = {"usedParamSet":{"familyId":true,"linkId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":115,"b":123},{"a":286,"b":294}]},{"name":"linkId","required":false,"transform":{"type":"scalar"},"locs":[{"a":141,"b":147},{"a":316,"b":322}]}],"statement":"UPDATE direct_guest_links\nSET status = 'revoked',\n    revoked_at = NOW(),\n    updated_at = NOW()\nWHERE family_id = :familyId\n  AND link_id = :linkId\n  AND status = 'active'\n  AND max_uses IS NOT NULL\n  AND (\n    SELECT COUNT(*)\n    FROM direct_guest_registrations\n    WHERE family_id = :familyId\n      AND link_id = :linkId\n  ) >= max_uses"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE direct_guest_links
 * SET status = 'revoked',
 *     revoked_at = NOW(),
 *     updated_at = NOW()
 * WHERE family_id = :familyId
 *   AND link_id = :linkId
 *   AND status = 'active'
 *   AND max_uses IS NOT NULL
 *   AND (
 *     SELECT COUNT(*)
 *     FROM direct_guest_registrations
 *     WHERE family_id = :familyId
 *       AND link_id = :linkId
 *   ) >= max_uses
 * ```
 */
export const revokeExhaustedDirectGuestLink = new PreparedQuery<RevokeExhaustedDirectGuestLinkParams,RevokeExhaustedDirectGuestLinkResult>(revokeExhaustedDirectGuestLinkIR);

