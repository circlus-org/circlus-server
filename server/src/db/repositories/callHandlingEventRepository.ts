import type { CallHandlingEventReport, CallSessionId, DeviceId, IdentityId } from '@shared/types';
import { pool, query } from '../index';

export type CallHandlingEventRow = {
  event_id: string;
  call_session_id: string;
  identity_id: string;
  device_id: string;
  family_id: string;
  event_type: string;
  reason_code: string | null;
  occurred_at: number;
  recorded_at: number;
};

function mapRow(row: CallHandlingEventRow): CallHandlingEventRow {
  return {
    ...row,
    occurred_at: Number(row.occurred_at),
    recorded_at: Number(row.recorded_at)
  };
}

export class CallHandlingEventRepository {
  async save(params: {
    familyId: string;
    callSessionId: CallSessionId;
    identityId: IdentityId;
    deviceId: DeviceId;
    report: CallHandlingEventReport;
  }): Promise<void> {
    const recordedAt = Date.now();
    await pool.query(
      `INSERT INTO call_handling_events (
         call_session_id, identity_id, device_id, family_id,
         event_type, reason_code, occurred_at, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.callSessionId,
        params.identityId,
        params.deviceId,
        params.familyId,
        params.report.eventType,
        params.report.reasonCode || null,
        params.report.occurredAt,
        recordedAt
      ]
    );
  }

  async listByCallSession(familyId: string, callSessionId: CallSessionId): Promise<CallHandlingEventRow[]> {
    const result = await query<CallHandlingEventRow>(
      `SELECT event_id, call_session_id, identity_id, device_id, family_id,
              event_type, reason_code, occurred_at, recorded_at
       FROM call_handling_events
       WHERE family_id = $1 AND call_session_id = $2
       ORDER BY recorded_at ASC, event_id ASC`,
      [familyId, callSessionId]
    );
    return result.rows.map(mapRow);
  }
}

export const callHandlingEventRepository = new CallHandlingEventRepository();
