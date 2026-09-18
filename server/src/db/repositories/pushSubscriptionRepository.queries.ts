/** Types generated for queries found in "src/db/repositories/pushSubscriptionRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** 'FindByPushId' parameters type */
export interface FindByPushIdParams {
  familyId?: string | null | void;
  pushId?: string | null | void;
}

/** 'FindByPushId' return type */
export interface FindByPushIdResult {
  created_at: Date;
  delivery_method: string;
  device_id: string;
  endpoint: string;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  keys_auth: string;
  keys_p256dh: string;
  push_encryption_public_key: string;
  push_id: string;
  relay_token: string | null;
  status: string;
  updated_at: Date;
}

/** 'FindByPushId' query type */
export interface FindByPushIdQuery {
  params: FindByPushIdParams;
  result: FindByPushIdResult;
}

const findByPushIdIR: any = {"usedParamSet":{"pushId":true,"familyId":true},"params":[{"name":"pushId","required":false,"transform":{"type":"scalar"},"locs":[{"a":49,"b":55}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":75,"b":83}]}],"statement":"SELECT * FROM push_subscriptions\nWHERE push_id = :pushId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM push_subscriptions
 * WHERE push_id = :pushId
 *   AND family_id = :familyId
 * ```
 */
export const findByPushId = new PreparedQuery<FindByPushIdParams,FindByPushIdResult>(findByPushIdIR);


/** 'FindByDeviceAndEndpoint' parameters type */
export interface FindByDeviceAndEndpointParams {
  deviceId?: string | null | void;
  endpoint?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindByDeviceAndEndpoint' return type */
export interface FindByDeviceAndEndpointResult {
  created_at: Date;
  delivery_method: string;
  device_id: string;
  endpoint: string;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  keys_auth: string;
  keys_p256dh: string;
  push_encryption_public_key: string;
  push_id: string;
  relay_token: string | null;
  status: string;
  updated_at: Date;
}

/** 'FindByDeviceAndEndpoint' query type */
export interface FindByDeviceAndEndpointQuery {
  params: FindByDeviceAndEndpointParams;
  result: FindByDeviceAndEndpointResult;
}

const findByDeviceAndEndpointIR: any = {"usedParamSet":{"deviceId":true,"endpoint":true,"familyId":true},"params":[{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":51,"b":59}]},{"name":"endpoint","required":false,"transform":{"type":"scalar"},"locs":[{"a":76,"b":84}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":104,"b":112}]}],"statement":"SELECT * FROM push_subscriptions\nWHERE device_id = :deviceId AND endpoint = :endpoint\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM push_subscriptions
 * WHERE device_id = :deviceId AND endpoint = :endpoint
 *   AND family_id = :familyId
 * ```
 */
export const findByDeviceAndEndpoint = new PreparedQuery<FindByDeviceAndEndpointParams,FindByDeviceAndEndpointResult>(findByDeviceAndEndpointIR);


/** 'FindByDeviceId' parameters type */
export interface FindByDeviceIdParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindByDeviceId' return type */
export interface FindByDeviceIdResult {
  created_at: Date;
  delivery_method: string;
  device_id: string;
  endpoint: string;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  keys_auth: string;
  keys_p256dh: string;
  push_encryption_public_key: string;
  push_id: string;
  relay_token: string | null;
  status: string;
  updated_at: Date;
}

/** 'FindByDeviceId' query type */
export interface FindByDeviceIdQuery {
  params: FindByDeviceIdParams;
  result: FindByDeviceIdResult;
}

const findByDeviceIdIR: any = {"usedParamSet":{"deviceId":true,"familyId":true},"params":[{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":51,"b":59}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":79,"b":87}]}],"statement":"SELECT * FROM push_subscriptions\nWHERE device_id = :deviceId\n  AND family_id = :familyId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM push_subscriptions
 * WHERE device_id = :deviceId
 *   AND family_id = :familyId
 * ORDER BY created_at DESC
 * ```
 */
export const findByDeviceId = new PreparedQuery<FindByDeviceIdParams,FindByDeviceIdResult>(findByDeviceIdIR);


/** 'FindActiveByDeviceId' parameters type */
export interface FindActiveByDeviceIdParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindActiveByDeviceId' return type */
export interface FindActiveByDeviceIdResult {
  created_at: Date;
  delivery_method: string;
  device_id: string;
  endpoint: string;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  keys_auth: string;
  keys_p256dh: string;
  push_encryption_public_key: string;
  push_id: string;
  relay_token: string | null;
  status: string;
  updated_at: Date;
}

/** 'FindActiveByDeviceId' query type */
export interface FindActiveByDeviceIdQuery {
  params: FindActiveByDeviceIdParams;
  result: FindActiveByDeviceIdResult;
}

const findActiveByDeviceIdIR: any = {"usedParamSet":{"deviceId":true,"familyId":true},"params":[{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":51,"b":59}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":101,"b":109}]}],"statement":"SELECT * FROM push_subscriptions\nWHERE device_id = :deviceId AND status = 'active'\n  AND family_id = :familyId\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM push_subscriptions
 * WHERE device_id = :deviceId AND status = 'active'
 *   AND family_id = :familyId
 * ORDER BY created_at DESC
 * ```
 */
export const findActiveByDeviceId = new PreparedQuery<FindActiveByDeviceIdParams,FindActiveByDeviceIdResult>(findActiveByDeviceIdIR);


/** 'CreatePushSubscription' parameters type */
export interface CreatePushSubscriptionParams {
  deliveryMethod?: string | null | void;
  deviceId?: string | null | void;
  endpoint?: string | null | void;
  familyId?: string | null | void;
  keysAuth?: string | null | void;
  keysP256dh?: string | null | void;
  pushEncryptionPublicKey?: string | null | void;
  pushId?: string | null | void;
  relayToken?: string | null | void;
}

/** 'CreatePushSubscription' return type */
export interface CreatePushSubscriptionResult {
  created_at: Date;
  delivery_method: string;
  device_id: string;
  endpoint: string;
  /** Family/tenant identifier for multi-tenancy isolation */
  family_id: string;
  id: string;
  keys_auth: string;
  keys_p256dh: string;
  push_encryption_public_key: string;
  push_id: string;
  relay_token: string | null;
  status: string;
  updated_at: Date;
}

/** 'CreatePushSubscription' query type */
export interface CreatePushSubscriptionQuery {
  params: CreatePushSubscriptionParams;
  result: CreatePushSubscriptionResult;
}

const createPushSubscriptionIR: any = {"usedParamSet":{"pushId":true,"deviceId":true,"familyId":true,"endpoint":true,"keysP256dh":true,"keysAuth":true,"deliveryMethod":true,"relayToken":true,"pushEncryptionPublicKey":true},"params":[{"name":"pushId","required":false,"transform":{"type":"scalar"},"locs":[{"a":186,"b":192}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":197,"b":205}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":210,"b":218}]},{"name":"endpoint","required":false,"transform":{"type":"scalar"},"locs":[{"a":223,"b":231}]},{"name":"keysP256dh","required":false,"transform":{"type":"scalar"},"locs":[{"a":236,"b":246}]},{"name":"keysAuth","required":false,"transform":{"type":"scalar"},"locs":[{"a":251,"b":259}]},{"name":"deliveryMethod","required":false,"transform":{"type":"scalar"},"locs":[{"a":264,"b":278}]},{"name":"relayToken","required":false,"transform":{"type":"scalar"},"locs":[{"a":283,"b":293}]},{"name":"pushEncryptionPublicKey","required":false,"transform":{"type":"scalar"},"locs":[{"a":298,"b":321}]}],"statement":"INSERT INTO push_subscriptions (\n  push_id,\n  device_id,\n  family_id,\n  endpoint,\n  keys_p256dh,\n  keys_auth,\n  delivery_method,\n  relay_token,\n  push_encryption_public_key\n) VALUES (\n  :pushId,\n  :deviceId,\n  :familyId,\n  :endpoint,\n  :keysP256dh,\n  :keysAuth,\n  :deliveryMethod,\n  :relayToken,\n  :pushEncryptionPublicKey\n) RETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO push_subscriptions (
 *   push_id,
 *   device_id,
 *   family_id,
 *   endpoint,
 *   keys_p256dh,
 *   keys_auth,
 *   delivery_method,
 *   relay_token,
 *   push_encryption_public_key
 * ) VALUES (
 *   :pushId,
 *   :deviceId,
 *   :familyId,
 *   :endpoint,
 *   :keysP256dh,
 *   :keysAuth,
 *   :deliveryMethod,
 *   :relayToken,
 *   :pushEncryptionPublicKey
 * ) RETURNING *
 * ```
 */
export const createPushSubscription = new PreparedQuery<CreatePushSubscriptionParams,CreatePushSubscriptionResult>(createPushSubscriptionIR);


/** 'UpdatePushSubscription' parameters type */
export interface UpdatePushSubscriptionParams {
  deliveryMethod?: string | null | void;
  familyId?: string | null | void;
  keysAuth?: string | null | void;
  keysP256dh?: string | null | void;
  pushEncryptionPublicKey?: string | null | void;
  pushId?: string | null | void;
  relayToken?: string | null | void;
}

/** 'UpdatePushSubscription' return type */
export type UpdatePushSubscriptionResult = void;

/** 'UpdatePushSubscription' query type */
export interface UpdatePushSubscriptionQuery {
  params: UpdatePushSubscriptionParams;
  result: UpdatePushSubscriptionResult;
}

const updatePushSubscriptionIR: any = {"usedParamSet":{"keysP256dh":true,"keysAuth":true,"deliveryMethod":true,"relayToken":true,"pushEncryptionPublicKey":true,"pushId":true,"familyId":true},"params":[{"name":"keysP256dh","required":false,"transform":{"type":"scalar"},"locs":[{"a":46,"b":56}]},{"name":"keysAuth","required":false,"transform":{"type":"scalar"},"locs":[{"a":73,"b":81}]},{"name":"deliveryMethod","required":false,"transform":{"type":"scalar"},"locs":[{"a":104,"b":118}]},{"name":"relayToken","required":false,"transform":{"type":"scalar"},"locs":[{"a":137,"b":147}]},{"name":"pushEncryptionPublicKey","required":false,"transform":{"type":"scalar"},"locs":[{"a":181,"b":204}]},{"name":"pushId","required":false,"transform":{"type":"scalar"},"locs":[{"a":222,"b":228}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":248,"b":256}]}],"statement":"UPDATE push_subscriptions\nSET\n  keys_p256dh = :keysP256dh,\n  keys_auth = :keysAuth,\n  delivery_method = :deliveryMethod,\n  relay_token = :relayToken,\n  push_encryption_public_key = :pushEncryptionPublicKey\nWHERE push_id = :pushId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE push_subscriptions
 * SET
 *   keys_p256dh = :keysP256dh,
 *   keys_auth = :keysAuth,
 *   delivery_method = :deliveryMethod,
 *   relay_token = :relayToken,
 *   push_encryption_public_key = :pushEncryptionPublicKey
 * WHERE push_id = :pushId
 *   AND family_id = :familyId
 * ```
 */
export const updatePushSubscription = new PreparedQuery<UpdatePushSubscriptionParams,UpdatePushSubscriptionResult>(updatePushSubscriptionIR);


/** 'UpdatePushStatus' parameters type */
export interface UpdatePushStatusParams {
  familyId?: string | null | void;
  pushId?: string | null | void;
  status?: string | null | void;
}

/** 'UpdatePushStatus' return type */
export type UpdatePushStatusResult = void;

/** 'UpdatePushStatus' query type */
export interface UpdatePushStatusQuery {
  params: UpdatePushStatusParams;
  result: UpdatePushStatusResult;
}

const updatePushStatusIR: any = {"usedParamSet":{"status":true,"pushId":true,"familyId":true},"params":[{"name":"status","required":false,"transform":{"type":"scalar"},"locs":[{"a":39,"b":45}]},{"name":"pushId","required":false,"transform":{"type":"scalar"},"locs":[{"a":63,"b":69}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":89,"b":97}]}],"statement":"UPDATE push_subscriptions\nSET status = :status\nWHERE push_id = :pushId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE push_subscriptions
 * SET status = :status
 * WHERE push_id = :pushId
 *   AND family_id = :familyId
 * ```
 */
export const updatePushStatus = new PreparedQuery<UpdatePushStatusParams,UpdatePushStatusResult>(updatePushStatusIR);


/** 'DeletePushSubscription' parameters type */
export interface DeletePushSubscriptionParams {
  familyId?: string | null | void;
  pushId?: string | null | void;
}

/** 'DeletePushSubscription' return type */
export type DeletePushSubscriptionResult = void;

/** 'DeletePushSubscription' query type */
export interface DeletePushSubscriptionQuery {
  params: DeletePushSubscriptionParams;
  result: DeletePushSubscriptionResult;
}

const deletePushSubscriptionIR: any = {"usedParamSet":{"pushId":true,"familyId":true},"params":[{"name":"pushId","required":false,"transform":{"type":"scalar"},"locs":[{"a":47,"b":53}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":73,"b":81}]}],"statement":"DELETE FROM push_subscriptions\nWHERE push_id = :pushId\n  AND family_id = :familyId"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM push_subscriptions
 * WHERE push_id = :pushId
 *   AND family_id = :familyId
 * ```
 */
export const deletePushSubscription = new PreparedQuery<DeletePushSubscriptionParams,DeletePushSubscriptionResult>(deletePushSubscriptionIR);


