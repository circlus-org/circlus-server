jest.mock('../db/repositories', () => ({
  callHistoryRepository: {
    recordMediaConnection: jest.fn(),
    findByCallSessionId: jest.fn(),
    markRejected: jest.fn(),
    markConnected: jest.fn(),
    markHeartbeat: jest.fn(),
    markFinalized: jest.fn()
  },
  callHandlingEventRepository: {
    save: jest.fn()
  },
  callSessionRepository: {
    findByCallSessionId: jest.fn(),
    end: jest.fn()
  },
  callClientDiagnosticsRepository: {
    save: jest.fn().mockResolvedValue(100)
  },
  callQualityDailyRepository: {
    refreshDay: jest.fn().mockResolvedValue(undefined)
  }
}));

import {
  callClientDiagnosticsRepository,
  callHandlingEventRepository,
  callHistoryRepository,
  callQualityDailyRepository,
  callSessionRepository
} from '../db/repositories';
import {
  CallLifecycleServiceError,
  finalizeCallForActor,
  markCallConnectedForActor,
  markCallHeartbeatForActor,
  recordCallHandlingEventForActor
} from './callLifecycleService';
import type { AuthenticatedActor } from './authenticatedActor';

const actor: AuthenticatedActor = {
  familyId: 'family-1',
  identityId: 'alice',
  deviceId: 'device-1'
};

describe('callLifecycleService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes decline only while the call is still ringing', async () => {
    (callHistoryRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      initiator_identity_id: 'bob', target_identity_id: 'alice'
    });
    const report = { callSessionId: 'call-1', eventType: 'declined', occurredAt: 123 };
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['alice', 'bob'], state: 'ringing'
    });
    await expect(recordCallHandlingEventForActor(actor, report)).resolves.toMatchObject({
      callSessionId: 'call-1', status: 'declined'
    });
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['alice', 'bob'], state: 'accepted'
    });
    await expect(recordCallHandlingEventForActor(actor, report)).resolves.toBeNull();
    expect(callHandlingEventRepository.save).toHaveBeenCalledTimes(2);
  });

  it('keeps the blocking call ID separate from the busy reason', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['alice', 'bob'], state: 'ringing'
    });
    (callHistoryRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      initiator_identity_id: 'bob', target_identity_id: 'alice'
    });

    await expect(recordCallHandlingEventForActor(actor, {
      callSessionId: 'call-new',
      eventType: 'busy',
      reasonCode: 'active_native_call',
      blockingCallSessionId: 'call-previous',
      occurredAt: 123
    })).resolves.toMatchObject({
      status: 'busy', reason: 'active_native_call', shouldEndCall: true
    });
    expect(callHandlingEventRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      report: expect.objectContaining({
        reasonCode: 'active_native_call', blockingCallSessionId: 'call-previous'
      })
    }));
  });

  it('rejects heartbeat from a non-participant', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['bob']
    });

    await expect(markCallHeartbeatForActor(actor, {
      callSessionId: 'call-1',
      connectedAt: 10,
      sentAt: 20
    })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN'
    } satisfies Partial<CallLifecycleServiceError>);

    expect(callHistoryRepository.markHeartbeat).not.toHaveBeenCalled();
  });

  it('ignores connected reports before the server call is accepted', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['alice', 'bob'],
      state: 'ringing'
    });

    await markCallConnectedForActor(actor, {
      callSessionId: 'call-1',
      connectedAt: 10
    });

    expect(callHistoryRepository.markConnected).not.toHaveBeenCalled();
  });

  it('ignores heartbeats after the server call is terminal', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['alice', 'bob'],
      state: 'ended'
    });

    await markCallHeartbeatForActor(actor, {
      callSessionId: 'call-1',
      connectedAt: 10,
      sentAt: 20
    });

    expect(callHistoryRepository.markHeartbeat).not.toHaveBeenCalled();
  });

  it('does not terminate or finalize a live participant call from a lifecycle report', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['alice', 'bob'],
      state: 'accepted'
    });

    await finalizeCallForActor(actor, {
      callSessionId: 'call-1',
      endedAt: 100,
      finalStatus: 'answered',
      durationSeconds: 60,
      reason: 'local_end'
    });

    expect(callSessionRepository.end).not.toHaveBeenCalled();
    expect(callHistoryRepository.markFinalized).not.toHaveBeenCalled();
  });

  it('records finalization details after the call is already terminal', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['alice', 'bob'],
      state: 'ended'
    });

    await finalizeCallForActor(actor, {
      callSessionId: 'call-1',
      endedAt: 100,
      finalStatus: 'answered',
      durationSeconds: 60,
      reason: 'local_end'
    });

    expect(callSessionRepository.end).not.toHaveBeenCalled();
    expect(callHistoryRepository.markFinalized).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1',
      endedAt: 100,
      finalStatus: 'answered',
      durationSeconds: 60,
      reason: 'local_end'
    });
  });

  it('persists versioned media quality diagnostics best-effort', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['alice', 'bob'],
      state: 'ended'
    });
    const diagnostics = {
      diagnosticsVersion: 2,
      everConnected: true,
      reachedReconnecting: false,
      mediaQuality: {
        schemaVersion: 1 as const,
        sampleCount: 3,
        startedAtMs: 10,
        endedAtMs: 100,
        mediaSessionId: 'ms1_safe',
        turnClusterId: 'external-eu',
        usedRelay: true,
        reconnectCount: 0,
        rttMs: { average: 35, maximum: 50 },
        audio: {
          packetsDiscarded: 2,
          concealedSamples: 480,
          concealmentPercent: { average: 1, maximum: 10 },
          jitterBufferDelayMs: { average: 40, maximum: 120 }
        }
      }
    };

    await finalizeCallForActor(actor, {
      callSessionId: 'call-1',
      endedAt: 100,
      finalStatus: 'answered',
      diagnostics
    });

    expect(callClientDiagnosticsRepository.save).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1',
      identityId: 'alice',
      deviceId: 'device-1',
      report: diagnostics
    });
    expect(callQualityDailyRepository.refreshDay).toHaveBeenCalledWith('family-1', 100);
  });
});
