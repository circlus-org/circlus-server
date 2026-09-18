import type { CallClientDiagnosticsReport, CallSessionId, DeviceId, IdentityId } from '@shared/types';
import { pool } from '../index';

export class CallClientDiagnosticsRepository {
  async save(params: {
    familyId: string;
    callSessionId: CallSessionId;
    identityId: IdentityId;
    deviceId: DeviceId;
    report: CallClientDiagnosticsReport;
  }): Promise<number> {
    const recordedAt = Date.now();
    await pool.query(
      `INSERT INTO call_client_diagnostics (
         call_session_id, identity_id, device_id, family_id,
         final_connection_state, final_ice_connection_state,
         ever_connected, reached_reconnecting, security_verified,
         selected_candidate_pair, phase_history, end_reason, runtime_metadata,
         diagnostics_version, media_quality_summary, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (call_session_id, identity_id, device_id) DO UPDATE SET
         final_connection_state = EXCLUDED.final_connection_state,
         final_ice_connection_state = EXCLUDED.final_ice_connection_state,
         ever_connected = EXCLUDED.ever_connected,
         reached_reconnecting = EXCLUDED.reached_reconnecting,
         security_verified = EXCLUDED.security_verified,
         selected_candidate_pair = EXCLUDED.selected_candidate_pair,
         phase_history = EXCLUDED.phase_history,
         end_reason = EXCLUDED.end_reason,
         runtime_metadata = EXCLUDED.runtime_metadata,
         diagnostics_version = COALESCE(EXCLUDED.diagnostics_version, call_client_diagnostics.diagnostics_version),
         media_quality_summary = COALESCE(EXCLUDED.media_quality_summary, call_client_diagnostics.media_quality_summary),
         recorded_at = EXCLUDED.recorded_at`,
      [
        params.callSessionId,
        params.identityId,
        params.deviceId,
        params.familyId,
        params.report.finalConnectionState ?? null,
        params.report.finalIceConnectionState ?? null,
        params.report.everConnected,
        params.report.reachedReconnecting,
        params.report.securityVerified ?? null,
        params.report.selectedCandidatePair ? JSON.stringify(params.report.selectedCandidatePair) : null,
        params.report.phaseHistory ? JSON.stringify(params.report.phaseHistory) : null,
        params.report.endReason ?? null,
        params.report.runtime ? JSON.stringify(params.report.runtime) : null,
        params.report.diagnosticsVersion ?? null,
        params.report.mediaQuality ? JSON.stringify(params.report.mediaQuality) : null,
        recordedAt
      ]
    );
    return recordedAt;
  }
}

export const callClientDiagnosticsRepository = new CallClientDiagnosticsRepository();
