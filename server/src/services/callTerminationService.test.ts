jest.mock('../db/repositories', () => ({
  callHandlingEventRepository: { listByCallSession: jest.fn() },
  callHistoryRepository: {
    markMissed: jest.fn(),
    markRejected: jest.fn(),
    markFinalized: jest.fn()
  },
  callSessionRepository: { end: jest.fn() },
  systemEventRepository: { insertEvent: jest.fn() }
}));

jest.mock('./configService', () => ({
  configService: {
    requireFamilyConfig: jest.fn().mockResolvedValue({ public_base_url: 'https://circle.example', circle_id: 'circle.example' })
  }
}));

jest.mock('../utils/serverIdentity', () => ({
  resolveServerIdForClients: jest.fn().mockReturnValue('circle.example')
}));

import {
  callHandlingEventRepository,
  callHistoryRepository,
  callSessionRepository,
  systemEventRepository
} from '../db/repositories';
import type { FindByCallSessionIdResult } from '../db/repositories/callSessionRepository.queries';
import { persistCallTermination } from './callTerminationService';
import type { CallTerminationContext } from './callTerminationPolicy';

const callSession = {
  call_session_id: 'call-1',
  family_id: 'family-1',
  initiator: 'caller',
  participants: ['caller', 'recipient'],
  state: 'ringing',
  created_at: new Date(1_000),
  sdp_offer: JSON.stringify({
    __externalCaller: {
      admissionKind: 'call_link',
      capabilityGrant: {
        descriptor: { payload: { scope: { title: 'Support call' } } }
      }
    }
  })
} as FindByCallSessionIdResult;

const cancellationContext: CallTerminationContext = {
  kind: 'cancel',
  endedByInitiator: true,
  ringingCallState: true,
  connectedCallState: false,
  endReason: 'cancelled',
  pushEndReason: 'cancelled',
  cancelledRecipientIdentityId: 'recipient',
  otherParticipantIdentityId: 'recipient',
  peerPushStatus: 'missed',
  peerPushEndReason: 'cancelled'
};

describe('persistCallTermination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (callHandlingEventRepository.listByCallSession as jest.Mock).mockResolvedValue([]);
  });

  it('ends the session before stopping runtime timers', async () => {
    const afterSessionEnded = jest.fn();

    await persistCallTermination({
      familyId: 'family-1',
      callSessionId: 'call-1',
      callSession,
      context: cancellationContext,
      terminationAt: 6_000,
      cancellationDeliveredGraceMs: 3_000,
      cancellationNoDeliveryFallbackMs: 10_000,
      afterSessionEnded
    });

    expect(callSessionRepository.end).toHaveBeenCalledTimes(1);
    expect(afterSessionEnded).toHaveBeenCalledTimes(1);
    expect((callSessionRepository.end as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      afterSessionEnded.mock.invocationCallOrder[0]
    );
  });

  it('does not stop runtime timers when ending the persisted session fails', async () => {
    const afterSessionEnded = jest.fn();
    (callSessionRepository.end as jest.Mock).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(persistCallTermination({
      familyId: 'family-1',
      callSessionId: 'call-1',
      callSession,
      context: cancellationContext,
      terminationAt: 6_000,
      cancellationDeliveredGraceMs: 3_000,
      cancellationNoDeliveryFallbackMs: 10_000,
      afterSessionEnded
    })).rejects.toThrow('database unavailable');

    expect(afterSessionEnded).not.toHaveBeenCalled();
    expect(callHistoryRepository.markMissed).not.toHaveBeenCalled();
  });

  it('records a fast caller cancellation as a missed cancelled event', async () => {
    const result = await persistCallTermination({
      familyId: 'family-1',
      callSessionId: 'call-1',
      callSession,
      context: cancellationContext,
      terminationAt: 6_000,
      cancellationDeliveredGraceMs: 3_000,
      cancellationNoDeliveryFallbackMs: 10_000,
      afterSessionEnded: jest.fn()
    });

    expect(result.historyEndReason).toBe('cancelled');
    expect(callHistoryRepository.markMissed).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1',
      reason: 'cancelled'
    });
    expect(systemEventRepository.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      recipientIdentityId: 'recipient',
      circleId: 'circle.example',
      type: 'call:missed',
      payload: expect.objectContaining({
        remoteIdentityId: 'caller',
        isTemporaryLinkCall: true
      })
    }));
  });

  it('uses recipient delivery evidence to record no answer', async () => {
    (callHandlingEventRepository.listByCallSession as jest.Mock).mockResolvedValue([{
      identity_id: 'recipient',
      event_type: 'ringing_started',
      recorded_at: 2_000
    }]);

    const result = await persistCallTermination({
      familyId: 'family-1',
      callSessionId: 'call-1',
      callSession,
      context: cancellationContext,
      terminationAt: 6_000,
      cancellationDeliveredGraceMs: 3_000,
      cancellationNoDeliveryFallbackMs: 10_000,
      afterSessionEnded: jest.fn()
    });

    expect(result.historyEndReason).toBe('no_answer');
    expect(callHistoryRepository.markMissed).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'no_answer'
    }));
  });

  it('records a recipient decline without creating a missed event', async () => {
    await persistCallTermination({
      familyId: 'family-1',
      callSessionId: 'call-1',
      callSession,
      context: {
        ...cancellationContext,
        kind: 'decline',
        endedByInitiator: false,
        endReason: 'tab_rejected',
        pushEndReason: 'normal',
        cancelledRecipientIdentityId: undefined,
        otherParticipantIdentityId: 'caller',
        peerPushStatus: 'ended',
        peerPushEndReason: 'normal'
      },
      terminationAt: 6_000,
      cancellationDeliveredGraceMs: 3_000,
      cancellationNoDeliveryFallbackMs: 10_000,
      afterSessionEnded: jest.fn()
    });

    expect(callHistoryRepository.markRejected).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1',
      reason: 'tab_rejected'
    });
    expect(callHistoryRepository.markMissed).not.toHaveBeenCalled();
    expect(systemEventRepository.insertEvent).not.toHaveBeenCalled();
  });

  it('finalizes a connected hangup as ended', async () => {
    await persistCallTermination({
      familyId: 'family-1',
      callSessionId: 'call-1',
      callSession: { ...callSession, state: 'active' },
      context: {
        ...cancellationContext,
        kind: 'hangup',
        ringingCallState: false,
        connectedCallState: true,
        endReason: 'normal',
        pushEndReason: 'normal',
        cancelledRecipientIdentityId: undefined,
        peerPushStatus: 'ended',
        peerPushEndReason: 'normal'
      },
      terminationAt: 6_000,
      cancellationDeliveredGraceMs: 3_000,
      cancellationNoDeliveryFallbackMs: 10_000,
      afterSessionEnded: jest.fn()
    });

    expect(callHistoryRepository.markFinalized).toHaveBeenCalledWith(expect.objectContaining({
      finalStatus: 'ended',
      reason: 'normal'
    }));
  });
});
