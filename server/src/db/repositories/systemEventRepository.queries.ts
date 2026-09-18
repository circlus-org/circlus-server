/** Types generated for queries found in "src/db/repositories/systemEventRepository.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NumberOrString = number | string;

/** 'InsertSystemEvent' parameters type */
export interface InsertSystemEventParams {
  createdAt?: NumberOrString | null | void;
  eventId?: string | null | void;
  familyId?: string | null | void;
  payload?: Json | null | void;
  recipientIdentityId?: string | null | void;
  circleId?: string | null | void;
  type?: string | null | void;
}

/** 'InsertSystemEvent' return type */
export type InsertSystemEventResult = void;

/** 'InsertSystemEvent' query type */
export interface InsertSystemEventQuery {
  params: InsertSystemEventParams;
  result: InsertSystemEventResult;
}

const insertSystemEventIR: any = {"usedParamSet":{"eventId":true,"familyId":true,"recipientIdentityId":true,"circleId":true,"type":true,"payload":true,"createdAt":true},"params":[{"name":"eventId","required":false,"transform":{"type":"scalar"},"locs":[{"a":136,"b":143}]},{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":148,"b":156}]},{"name":"recipientIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":161,"b":180}]},{"name":"circleId","required":false,"transform":{"type":"scalar"},"locs":[{"a":185,"b":193}]},{"name":"type","required":false,"transform":{"type":"scalar"},"locs":[{"a":198,"b":202}]},{"name":"payload","required":false,"transform":{"type":"scalar"},"locs":[{"a":207,"b":214}]},{"name":"createdAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":226,"b":235}]}],"statement":"INSERT INTO system_events (\n  event_id,\n  family_id,\n  recipient_identity_id,\n  circle_id,\n  type,\n  payload,\n  created_at\n) VALUES (\n  :eventId,\n  :familyId,\n  :recipientIdentityId,\n  :circleId,\n  :type,\n  :payload::jsonb,\n  :createdAt\n)\nON CONFLICT (event_id) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO system_events (
 *   event_id,
 *   family_id,
 *   recipient_identity_id,
 *   circle_id,
 *   type,
 *   payload,
 *   created_at
 * ) VALUES (
 *   :eventId,
 *   :familyId,
 *   :recipientIdentityId,
 *   :circleId,
 *   :type,
 *   :payload::jsonb,
 *   :createdAt
 * )
 * ON CONFLICT (event_id) DO NOTHING
 * ```
 */
export const insertSystemEvent = new PreparedQuery<InsertSystemEventParams,InsertSystemEventResult>(insertSystemEventIR);


/** 'FetchSystemEventsForSync' parameters type */
export interface FetchSystemEventsForSyncParams {
  familyId?: string | null | void;
  limit?: NumberOrString | null | void;
  recipientIdentityId?: string | null | void;
  since?: NumberOrString | null | void;
}

/** 'FetchSystemEventsForSync' return type */
export interface FetchSystemEventsForSyncResult {
  created_at: string;
  event_id: string;
  payload: Json;
  recipient_identity_id: string;
  circle_id: string;
  type: string;
}

/** 'FetchSystemEventsForSync' query type */
export interface FetchSystemEventsForSyncQuery {
  params: FetchSystemEventsForSyncParams;
  result: FetchSystemEventsForSyncResult;
}

const fetchSystemEventsForSyncIR: any = {"usedParamSet":{"familyId":true,"recipientIdentityId":true,"since":true,"limit":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":114,"b":122}]},{"name":"recipientIdentityId","required":false,"transform":{"type":"scalar"},"locs":[{"a":154,"b":173}]},{"name":"since","required":false,"transform":{"type":"scalar"},"locs":[{"a":194,"b":199}]},{"name":"limit","required":false,"transform":{"type":"scalar"},"locs":[{"a":231,"b":236}]}],"statement":"SELECT event_id, recipient_identity_id, circle_id, type, payload, created_at\nFROM system_events\nWHERE family_id = :familyId\n  AND recipient_identity_id = :recipientIdentityId\n  AND created_at > :since\nORDER BY created_at ASC\nLIMIT :limit"};

/**
 * Query generated from SQL:
 * ```
 * SELECT event_id, recipient_identity_id, circle_id, type, payload, created_at
 * FROM system_events
 * WHERE family_id = :familyId
 *   AND recipient_identity_id = :recipientIdentityId
 *   AND created_at > :since
 * ORDER BY created_at ASC
 * LIMIT :limit
 * ```
 */
export const fetchSystemEventsForSync = new PreparedQuery<FetchSystemEventsForSyncParams,FetchSystemEventsForSyncResult>(fetchSystemEventsForSyncIR);


/** 'FindSystemDeviceSyncState' parameters type */
export interface FindSystemDeviceSyncStateParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'FindSystemDeviceSyncState' return type */
export interface FindSystemDeviceSyncStateResult {
  last_system_sync_at: string;
}

/** 'FindSystemDeviceSyncState' query type */
export interface FindSystemDeviceSyncStateQuery {
  params: FindSystemDeviceSyncStateParams;
  result: FindSystemDeviceSyncStateResult;
}

const findSystemDeviceSyncStateIR: any = {"usedParamSet":{"familyId":true,"deviceId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":69,"b":77}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":97,"b":105}]}],"statement":"SELECT last_system_sync_at\nFROM system_device_sync\nWHERE family_id = :familyId\n  AND device_id = :deviceId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT last_system_sync_at
 * FROM system_device_sync
 * WHERE family_id = :familyId
 *   AND device_id = :deviceId
 * ```
 */
export const findSystemDeviceSyncState = new PreparedQuery<FindSystemDeviceSyncStateParams,FindSystemDeviceSyncStateResult>(findSystemDeviceSyncStateIR);


/** 'EnsureSystemDeviceSyncState' parameters type */
export interface EnsureSystemDeviceSyncStateParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
}

/** 'EnsureSystemDeviceSyncState' return type */
export type EnsureSystemDeviceSyncStateResult = void;

/** 'EnsureSystemDeviceSyncState' query type */
export interface EnsureSystemDeviceSyncStateQuery {
  params: EnsureSystemDeviceSyncStateParams;
  result: EnsureSystemDeviceSyncStateResult;
}

const ensureSystemDeviceSyncStateIR: any = {"usedParamSet":{"familyId":true,"deviceId":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":83,"b":91}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":94,"b":102}]}],"statement":"INSERT INTO system_device_sync (family_id, device_id, last_system_sync_at)\nVALUES (:familyId, :deviceId, 0)\nON CONFLICT DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO system_device_sync (family_id, device_id, last_system_sync_at)
 * VALUES (:familyId, :deviceId, 0)
 * ON CONFLICT DO NOTHING
 * ```
 */
export const ensureSystemDeviceSyncState = new PreparedQuery<EnsureSystemDeviceSyncStateParams,EnsureSystemDeviceSyncStateResult>(ensureSystemDeviceSyncStateIR);


/** 'UpsertSystemDeviceSyncState' parameters type */
export interface UpsertSystemDeviceSyncStateParams {
  deviceId?: string | null | void;
  familyId?: string | null | void;
  lastSystemSyncAt?: NumberOrString | null | void;
}

/** 'UpsertSystemDeviceSyncState' return type */
export type UpsertSystemDeviceSyncStateResult = void;

/** 'UpsertSystemDeviceSyncState' query type */
export interface UpsertSystemDeviceSyncStateQuery {
  params: UpsertSystemDeviceSyncStateParams;
  result: UpsertSystemDeviceSyncStateResult;
}

const upsertSystemDeviceSyncStateIR: any = {"usedParamSet":{"familyId":true,"deviceId":true,"lastSystemSyncAt":true},"params":[{"name":"familyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":83,"b":91}]},{"name":"deviceId","required":false,"transform":{"type":"scalar"},"locs":[{"a":94,"b":102}]},{"name":"lastSystemSyncAt","required":false,"transform":{"type":"scalar"},"locs":[{"a":105,"b":121}]}],"statement":"INSERT INTO system_device_sync (family_id, device_id, last_system_sync_at)\nVALUES (:familyId, :deviceId, :lastSystemSyncAt)\nON CONFLICT (family_id, device_id)\nDO UPDATE SET\n  last_system_sync_at = GREATEST(system_device_sync.last_system_sync_at, EXCLUDED.last_system_sync_at)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO system_device_sync (family_id, device_id, last_system_sync_at)
 * VALUES (:familyId, :deviceId, :lastSystemSyncAt)
 * ON CONFLICT (family_id, device_id)
 * DO UPDATE SET
 *   last_system_sync_at = GREATEST(system_device_sync.last_system_sync_at, EXCLUDED.last_system_sync_at)
 * ```
 */
export const upsertSystemDeviceSyncState = new PreparedQuery<UpsertSystemDeviceSyncStateParams,UpsertSystemDeviceSyncStateResult>(upsertSystemDeviceSyncStateIR);


/** 'CleanupExpiredSystemEvents' parameters type */
export interface CleanupExpiredSystemEventsParams {
  cutoff?: NumberOrString | null | void;
}

/** 'CleanupExpiredSystemEvents' return type */
export type CleanupExpiredSystemEventsResult = void;

/** 'CleanupExpiredSystemEvents' query type */
export interface CleanupExpiredSystemEventsQuery {
  params: CleanupExpiredSystemEventsParams;
  result: CleanupExpiredSystemEventsResult;
}

const cleanupExpiredSystemEventsIR: any = {"usedParamSet":{"cutoff":true},"params":[{"name":"cutoff","required":false,"transform":{"type":"scalar"},"locs":[{"a":45,"b":51}]}],"statement":"DELETE FROM system_events\nWHERE created_at < :cutoff"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM system_events
 * WHERE created_at < :cutoff
 * ```
 */
export const cleanupExpiredSystemEvents = new PreparedQuery<CleanupExpiredSystemEventsParams,CleanupExpiredSystemEventsResult>(cleanupExpiredSystemEventsIR);


