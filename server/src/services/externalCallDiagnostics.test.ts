jest.mock('../db/repositories', () => ({
  callHistoryRepository: { findByCallSessionId: jest.fn(), recordMediaConnection: jest.fn() },
  callClientDiagnosticsRepository: { save: jest.fn(async () => 100) },
  callQualityDailyRepository: { refreshDay: jest.fn(async () => {}) }
}));
jest.mock('./durableNonce', () => ({ claimDurableNonce: jest.fn(async () => true) }));
import nacl from 'tweetnacl';
import { randomUUID } from 'node:crypto';
import { createSignatureMessage } from '../../../shared/signatureMessage';
import { recordExternalCallDiagnostics } from './externalCallDiagnostics';
import { callClientDiagnosticsRepository, callHistoryRepository } from '../db/repositories';
import type { CallClientDiagnosticsReport } from '@shared/types';

const key = nacl.sign.keyPair();
function request(report: CallClientDiagnosticsReport = { everConnected: false, reachedReconnecting: false }) {
  const unsigned = { type: 'call:external-diagnostics', signerId: 'guest', nonce: randomUUID(),
    timestamp: Date.now(), payload: { callSessionId: 'call-1', diagnostics: report } };
  return { ...unsigned, signature: Buffer.from(nacl.sign.detached(
    Buffer.from(createSignatureMessage(unsigned)), key.secretKey)).toString('base64') };
}

describe('guest call diagnostics authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(callHistoryRepository.findByCallSessionId).mockResolvedValue({
      call_session_id: 'call-1', initiator_identity_id: 'guest',
      external_initiator_public_key: { algorithm: 'ed25519', value: Buffer.from(key.publicKey).toString('base64') }
    } as any);
  });
  it('stores a failed guest call without a device or live session and rejects replay', async () => {
    const signed = request();
    await recordExternalCallDiagnostics('circle', signed);
    expect(callHistoryRepository.findByCallSessionId).toHaveBeenCalledWith('circle', 'call-1');
    expect(callClientDiagnosticsRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'circle', callSessionId: 'call-1', identityId: 'guest', deviceId: 'ext:guest',
      report: { everConnected: false, reachedReconnecting: false }
    }));
    await expect(recordExternalCallDiagnostics('circle', signed)).rejects.toMatchObject({ code: 'INVALID_NONCE' });
    expect(callClientDiagnosticsRepository.save).toHaveBeenCalledTimes(1);
  });
  it('records reported media start without granting authority to end the call', async () => {
    await recordExternalCallDiagnostics('circle', request({ everConnected: true, reachedReconnecting: false, mediaConnectedAtMs: 2000 }));
    expect(callHistoryRepository.recordMediaConnection).toHaveBeenCalledWith({ familyId: 'circle', callSessionId: 'call-1', connectedAt: 2000 });
  });
  it.each(['signature', 'signer', 'circle', 'local', 'type'])('rejects invalid %s without saving', async kind => {
    const signed = request();
    if (kind === 'signature') signed.payload.diagnostics.everConnected = true;
    if (kind === 'signer') signed.signerId = 'recipient';
    if (kind === 'circle') jest.mocked(callHistoryRepository.findByCallSessionId).mockResolvedValue(null);
    if (kind === 'local') jest.mocked(callHistoryRepository.findByCallSessionId).mockResolvedValue({ initiator_identity_id: 'guest', external_initiator_public_key: null } as any);
    if (kind === 'type') signed.type = 'call:finalized';
    await expect(recordExternalCallDiagnostics('circle', signed)).rejects.toBeDefined();
    expect(callClientDiagnosticsRepository.save).not.toHaveBeenCalled();
  });
});
