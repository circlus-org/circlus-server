import type { CallSessionId, IdentityId } from '@shared/types';
import { pool, query } from '../index';

export type CallIceDiagnosticsEntry = {
  identityId: IdentityId;
  total: number;
  relay: number;
  srflx: number;
  host: number;
  prflx: number;
  udp: number;
  tcp: number;
};

export type CallIceDiagnosticsRow = {
  call_session_id: string;
  identity_id: string;
  family_id: string;
  total_candidates: number;
  relay_candidates: number;
  srflx_candidates: number;
  host_candidates: number;
  prflx_candidates: number;
  udp_candidates: number;
  tcp_candidates: number;
  recorded_at: number;
};

function mapRow(row: CallIceDiagnosticsRow): CallIceDiagnosticsRow {
  return {
    ...row,
    total_candidates: Number(row.total_candidates),
    relay_candidates: Number(row.relay_candidates),
    srflx_candidates: Number(row.srflx_candidates),
    host_candidates: Number(row.host_candidates),
    prflx_candidates: Number(row.prflx_candidates),
    udp_candidates: Number(row.udp_candidates),
    tcp_candidates: Number(row.tcp_candidates),
    recorded_at: Number(row.recorded_at)
  };
}

export class CallIceDiagnosticsRepository {
  /**
   * Persist a per-identity ICE candidate summary for a finished call.
   * Call sessions are only flushed once (the in-memory stats are taken and
   * cleared together by the caller), but ON CONFLICT guards against any
   * accidental double-flush across the several call-end code paths.
   */
  async save(params: {
    familyId: string;
    callSessionId: CallSessionId;
    entries: CallIceDiagnosticsEntry[];
  }): Promise<void> {
    if (params.entries.length === 0) return;
    const recordedAt = Date.now();
    for (const entry of params.entries) {
      await pool.query(
        `INSERT INTO call_ice_diagnostics (
           call_session_id, identity_id, family_id,
           total_candidates, relay_candidates, srflx_candidates,
           host_candidates, prflx_candidates, udp_candidates, tcp_candidates,
           recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (call_session_id, identity_id) DO NOTHING`,
        [
          params.callSessionId,
          entry.identityId,
          params.familyId,
          entry.total,
          entry.relay,
          entry.srflx,
          entry.host,
          entry.prflx,
          entry.udp,
          entry.tcp,
          recordedAt
        ]
      );
    }
  }

  async findByCallSessionId(familyId: string, callSessionId: CallSessionId): Promise<CallIceDiagnosticsRow[]> {
    const result = await query<CallIceDiagnosticsRow>(
      `SELECT * FROM call_ice_diagnostics WHERE family_id = $1 AND call_session_id = $2`,
      [familyId, callSessionId]
    );
    return result.rows.map(mapRow);
  }
}

export const callIceDiagnosticsRepository = new CallIceDiagnosticsRepository();
