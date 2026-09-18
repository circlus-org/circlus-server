import type { CallClientDiagnosticsReport, SignedRequest } from '@shared/types';
import { callClientDiagnosticsRepository, callHistoryRepository, callQualityDailyRepository } from '../db/repositories';
import { createNonceStore, validateSignedRequestEnvelope, consumeSignedRequestEnvelope } from '../middleware/auth';
import { verifySignedRequest } from '../utils/crypto';
import { CallLifecycleServiceError } from './callLifecycleService';
import { getRequestLogger } from '../middleware/requestContext';

const nonces = createNonceStore();
export type ExternalCallDiagnosticsPayload = {
  callSessionId: string;
  diagnostics: CallClientDiagnosticsReport;
};

/** A retained call's original guest key authorizes only that guest's diagnostics.
 * This remains usable after WebSocket teardown or call-link expiry/revocation.
 */
export async function recordExternalCallDiagnostics(
  familyId: string,
  request: SignedRequest<ExternalCallDiagnosticsPayload>
): Promise<void> {
  const envelope = validateSignedRequestEnvelope(request, nonces);
  if (!envelope.ok) throw new CallLifecycleServiceError(envelope.status, envelope.code, envelope.message);
  if (request.type !== 'call:external-diagnostics'
    || typeof request.payload?.callSessionId !== 'string'
    || !request.payload.diagnostics || typeof request.payload.diagnostics !== 'object'
    || Array.isArray(request.payload.diagnostics)
    || typeof request.payload.diagnostics.everConnected !== 'boolean') {
    throw new CallLifecycleServiceError(400, 'INVALID_STATE', 'Invalid call diagnostics report');
  }
  const call = await callHistoryRepository.findByCallSessionId(familyId, request.payload.callSessionId);
  const key = call?.external_initiator_public_key;
  if (!call || call.initiator_identity_id !== request.signerId || key?.algorithm !== 'ed25519'
    || !verifySignedRequest(request, key)) {
    throw new CallLifecycleServiceError(403, 'FORBIDDEN', 'Call diagnostics access denied');
  }
  const consumed = await consumeSignedRequestEnvelope(request, nonces);
  if (!consumed.ok) throw new CallLifecycleServiceError(consumed.status, consumed.code, consumed.message);
  const recordedAt = await callClientDiagnosticsRepository.save({
    familyId, callSessionId: call.call_session_id, identityId: call.initiator_identity_id,
    deviceId: `ext:${call.initiator_identity_id}`, report: request.payload.diagnostics
  });
  await callHistoryRepository.recordMediaConnection({
    familyId, callSessionId: call.call_session_id,
    connectedAt: request.payload.diagnostics.everConnected
      ? request.payload.diagnostics.mediaConnectedAtMs : undefined
  });
  void callQualityDailyRepository.refreshDay(familyId, recordedAt).catch(error => {
    getRequestLogger({ subsystem: 'call_diagnostics' }).warn('call_quality_daily_refresh_failed', { familyId, error });
  });
}
