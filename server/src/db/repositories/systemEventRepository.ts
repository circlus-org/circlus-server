import { nanoid } from 'nanoid';
import { pool } from '../index';
import type { CircleId, DeviceId, IdentityId, SystemEventRecord, SystemEventType } from '@shared/types';
import { getCallRuntimeConfig } from '../../config/serverRuntimeConfig';
import type { Json, FetchSystemEventsForSyncResult } from './systemEventRepository.queries';
import {
  insertSystemEvent,
  fetchSystemEventsForSync,
  findSystemDeviceSyncState,
  ensureSystemDeviceSyncState,
  upsertSystemDeviceSyncState,
  cleanupExpiredSystemEvents,
} from './systemEventRepository.queries';

export type SystemEventRow = {
  event_id: string;
  family_id: string;
  recipient_identity_id: string;
  circle_id: string;
  type: string;
  payload: unknown;
  created_at: number;
};

export const MAX_SYSTEM_SYNC_BATCH = getCallRuntimeConfig().webSocket.systemEventSyncBatch;

function mapSystemEventRow(row: FetchSystemEventsForSyncResult): SystemEventRecord {
  return {
    eventId: row.event_id,
    recipientIdentityId: row.recipient_identity_id as IdentityId,
    circleId: row.circle_id as CircleId,
    type: row.type as SystemEventType,
    payload: row.payload as any,
    serverTimestamp: Number(row.created_at)
  };
}

export class SystemEventRepository {
  createEventId(): string {
    return `sev_${nanoid()}`;
  }

  async insertEvent(params: {
    eventId: string;
    familyId: string;
    recipientIdentityId: IdentityId;
    circleId: CircleId;
    type: SystemEventType;
    payload: unknown;
    createdAt: number;
  }): Promise<void> {
    await insertSystemEvent.run({
      eventId: params.eventId,
      familyId: params.familyId,
      recipientIdentityId: params.recipientIdentityId,
      circleId: params.circleId,
      type: params.type,
      payload: JSON.stringify(params.payload ?? {}) as Json,
      createdAt: params.createdAt
    }, pool);
  }

  async fetchEventsForSync(params: {
    familyId: string;
    recipientIdentityId: IdentityId;
    since: number;
    limit?: number;
  }): Promise<SystemEventRecord[]> {
    const limit = Math.max(1, Math.floor(params.limit ?? MAX_SYSTEM_SYNC_BATCH));
    const results = await fetchSystemEventsForSync.run({
      familyId: params.familyId,
      recipientIdentityId: params.recipientIdentityId,
      since: params.since,
      limit,
    }, pool);

    return results.map(mapSystemEventRow);
  }

  async getSyncState(
    familyId: string,
    deviceId: DeviceId
  ): Promise<{ last_system_sync_at: number }> {
    const results = await findSystemDeviceSyncState.run({ familyId, deviceId }, pool);
    if (results[0]) {
      return { last_system_sync_at: Number(results[0].last_system_sync_at) };
    }

    await ensureSystemDeviceSyncState.run({ familyId, deviceId }, pool);

    return { last_system_sync_at: 0 };
  }

  async updateSyncState(
    familyId: string,
    deviceId: DeviceId,
    lastSystemSyncAt: number
  ): Promise<void> {
    await upsertSystemDeviceSyncState.run({ familyId, deviceId, lastSystemSyncAt }, pool);
  }

  async cleanupExpiredEvents(cutoff: number): Promise<number> {
    const results = await cleanupExpiredSystemEvents.run({ cutoff }, pool);
    return results.length;
  }
}

export const systemEventRepository = new SystemEventRepository();
