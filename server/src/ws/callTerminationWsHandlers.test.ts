jest.mock('../db/repositories', () => ({
  callHistoryRepository: { markRejected: jest.fn(), markFinalized: jest.fn() },
  callSessionRepository: {
    findByCallSessionId: jest.fn(),
    findActive: jest.fn(),
    end: jest.fn()
  },
  identityRepository: { findByIdentityId: jest.fn() }
}));
jest.mock('../services/callTerminationPolicy', () => ({
  resolveCallTermination: jest.fn()
}));
jest.mock('../services/callTerminationService', () => ({
  persistCallTermination: jest.fn()
}));
jest.mock('../utils/push', () => ({ sendCallStatusPush: jest.fn() }));
jest.mock('./callIceDiagnostics', () => ({
  persistAndClearCallIceStats: jest.fn(),
  summarizeCallIceStats: jest.fn(() => 'ice-summary')
}));

import type { WebSocket } from 'ws';
import {
  callHistoryRepository,
  callSessionRepository,
  identityRepository
} from '../db/repositories';
import { resolveCallTermination } from '../services/callTerminationPolicy';
import { persistCallTermination } from '../services/callTerminationService';
import { sendCallStatusPush } from '../utils/push';
import { persistAndClearCallIceStats } from './callIceDiagnostics';
import {
  CallTerminationWsHandlers,
  type CallTerminationWsHandlerDependencies
} from './callTerminationWsHandlers';
import type { ConnectionInfo } from './wsConnectionContext';

const currentWs = {} as WebSocket;
const peerWs = {} as WebSocket;
const siblingWs = {} as WebSocket;
const callerIdentityId = 'identity-caller';
const calleeIdentityId = 'identity-callee';
const info: ConnectionInfo = {
  actorType: 'local',
  familyId: 'family-1',
  identityId: callerIdentityId,
  deviceId: 'device-caller',
  runtimeMode: 'video-native',
  clientRuntime: 'android_webview',
  scopedCallSessionId: 'call-1'
};

function harness(overrides: Partial<CallTerminationWsHandlerDependencies> = {}) {
  const logger = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn()
  };
  const callSessionRouting = {
    get: jest.fn(),
    remove: jest.fn()
  };
  const callRingingService = { stop: jest.fn() };
  const dependencies: CallTerminationWsHandlerDependencies = {
    getConnectionInfo: jest.fn(() => info),
    getIdentitySockets: jest.fn(() => new Set([peerWs])),
    getGeneralIdentitySockets: jest.fn(() => new Set([currentWs, siblingWs])),
    rememberEarlyEndedCallSession: jest.fn(),
    sendMessage: jest.fn(),
    sendToConnectionSet: jest.fn(),
    sendError: jest.fn(),
    resolvePublishedIdentityName: jest.fn(async () => 'Caller'),
    callRingingService: callRingingService as any,
    callSessionRouting: callSessionRouting as any,
    describeSocket: jest.fn(() => ({ actorType: 'local' })),
    logCallDiag: jest.fn(),
    logger: logger as any,
    cancellationDeliveredGraceMs: 3_000,
    cancellationNoDeliveryFallbackMs: 10_000,
    iceDiagnostics: true,
    now: () => 1_000,
    ...overrides
  };
  return {
    callRingingService,
    callSessionRouting,
    logger,
    dependencies,
    handlers: new CallTerminationWsHandlers(dependencies)
  };
}

describe('call termination WebSocket handlers', () => {
  it('releases the accepted browser before timeout persistence completes', async () => {
    let releaseEnd!: () => void;
    (callSessionRepository.end as jest.Mock).mockReturnValueOnce(new Promise<void>(resolve => { releaseEnd = resolve; }));
    const { handlers, dependencies, callRingingService } = harness();
    const done = handlers.terminateForSignalingTimeout('call-1', {
      familyId: 'family-1', initiatorIdentityId: callerIdentityId, initiatorWs: currentWs,
      targetIdentityId: calleeIdentityId, acceptedTargetWs: peerWs
    });
    expect(callRingingService.stop).toHaveBeenCalledWith('call-1');
    expect(dependencies.sendMessage).toHaveBeenCalledWith(peerWs, expect.objectContaining({
      type: 'call:ended', data: { callSessionId: 'call-1', reason: 'signaling_disconnected' }
    }));
    releaseEnd();
    await done;
    expect(callHistoryRepository.markFinalized).toHaveBeenCalledWith(expect.objectContaining({
      callSessionId: 'call-1', finalStatus: 'failed', reason: 'signaling_disconnected'
    }));
    expect(sendCallStatusPush).toHaveBeenCalledWith('family-1', calleeIdentityId, expect.objectContaining({
      callStatus: 'ended', callEndReason: 'signaling_disconnected'
    }));
    expect(persistAndClearCallIceStats).toHaveBeenCalledWith({ familyId: 'family-1', callSessionId: 'call-1' });
  });

  it('marks an authenticated replacement attempt with a distinct terminal reason', async () => {
    const { handlers, dependencies } = harness();
    await handlers.terminateForSupersededRedial('call-old', {
      familyId: 'family-1', initiatorIdentityId: callerIdentityId, initiatorWs: currentWs,
      targetIdentityId: calleeIdentityId, acceptedTargetWs: peerWs
    });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(peerWs, expect.objectContaining({
      type: 'call:ended', data: { callSessionId: 'call-old', reason: 'superseded_by_redial' }
    }));
    expect(callHistoryRepository.markFinalized).toHaveBeenCalledWith(expect.objectContaining({
      callSessionId: 'call-old', finalStatus: 'failed', reason: 'superseded_by_redial'
    }));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      public_key_algorithm: 'ed25519',
      public_key_value: 'public-key'
    });
    (sendCallStatusPush as jest.Mock).mockResolvedValue(undefined);
    (callSessionRepository.findActive as jest.Mock).mockResolvedValue([]);
    (persistCallTermination as jest.Mock).mockImplementation(async (params) => {
      params.afterSessionEnded();
    });
  });

  it('ends active calls and notifies every peer when an identity is suspended', async () => {
    (callSessionRepository.findActive as jest.Mock).mockResolvedValue([
      {
        call_session_id: 'call-1',
        participants: [callerIdentityId, calleeIdentityId],
        initiator: callerIdentityId,
        state: 'active'
      },
      {
        call_session_id: 'call-other',
        participants: ['identity-a', 'identity-b'],
        initiator: 'identity-a',
        state: 'ringing'
      }
    ]);
    const { handlers, dependencies, callRingingService, callSessionRouting } = harness();
    callSessionRouting.get.mockReturnValue({ initiatorWs: currentWs, acceptedTargetWs: peerWs });

    await expect(handlers.terminateForIdentitySuspension('family-1', callerIdentityId))
      .resolves.toBe(1);

    expect(callSessionRepository.end).toHaveBeenCalledWith('family-1', 'call-1');
    expect(callHistoryRepository.markFinalized).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family-1',
      callSessionId: 'call-1',
      finalStatus: 'ended',
      reason: 'identity_blocked'
    }));
    expect(callRingingService.stop).toHaveBeenCalledWith('call-1');
    expect(dependencies.sendToConnectionSet).toHaveBeenCalledTimes(2);
    expect(sendCallStatusPush).toHaveBeenCalledWith('family-1', calleeIdentityId, expect.objectContaining({
      callSessionId: 'call-1',
      callStatus: 'ended',
      fromIdentityId: callerIdentityId
    }));
    expect(callSessionRouting.remove).toHaveBeenCalledWith('call-1');
    expect(persistAndClearCallIceStats).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1'
    });
  });

  it('ends every active call when a Circle is suspended', async () => {
    (callSessionRepository.findActive as jest.Mock).mockResolvedValue([
      {
        call_session_id: 'call-1',
        participants: [callerIdentityId, calleeIdentityId],
        initiator: callerIdentityId,
        state: 'active'
      },
      {
        call_session_id: 'call-2',
        participants: ['identity-a', 'identity-b'],
        initiator: 'identity-a',
        state: 'ringing'
      }
    ]);
    const { handlers, dependencies, callSessionRouting } = harness();

    await expect(handlers.terminateForCircleSuspension('family-1')).resolves.toBe(2);

    expect(callSessionRepository.end).toHaveBeenCalledTimes(2);
    expect(callHistoryRepository.markFinalized).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family-1',
      callSessionId: 'call-1',
      reason: 'circle_suspended'
    }));
    expect(dependencies.sendToConnectionSet).toHaveBeenCalledTimes(4);
    expect(sendCallStatusPush).toHaveBeenCalledTimes(4);
    expect(callSessionRouting.remove).toHaveBeenCalledWith('call-1');
    expect(callSessionRouting.remove).toHaveBeenCalledWith('call-2');
    expect(persistAndClearCallIceStats).toHaveBeenCalledTimes(2);
  });

  it('rejects termination from an unauthenticated socket', async () => {
    const { handlers, dependencies } = harness({ getConnectionInfo: () => undefined });
    await handlers.handle(currentWs, { callSessionId: 'call-1' }, 'hangup');
    expect(dependencies.sendError).toHaveBeenCalledWith(
      currentWs,
      'UNAUTHORIZED',
      'Not authenticated'
    );
  });

  it('remembers cancel received before the offer is persisted', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(null);
    const { handlers, dependencies } = harness();
    await handlers.handle(currentWs, { callSessionId: 'call-early' }, 'cancel');
    expect(dependencies.rememberEarlyEndedCallSession).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-early',
      endedByIdentityId: callerIdentityId
    });
    expect(persistCallTermination).not.toHaveBeenCalled();
  });

  it('ignores a missing non-cancel termination without creating early state', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(null);
    const { handlers, dependencies } = harness();
    await handlers.handle(currentWs, { callSessionId: 'call-missing' }, 'decline');
    expect(dependencies.rememberEarlyEndedCallSession).not.toHaveBeenCalled();
    expect(dependencies.logCallDiag).toHaveBeenCalledWith(
      'call_decline_missing_ignored',
      expect.objectContaining({ callSessionId: 'call-missing' })
    );
  });

  it('rejects termination by a non-participant', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: ['identity-other', calleeIdentityId],
      initiator: 'identity-other',
      state: 'active'
    });
    const { handlers, dependencies } = harness();
    await handlers.handle(currentWs, { callSessionId: 'call-1' }, 'hangup');
    expect(dependencies.sendError).toHaveBeenCalledWith(
      currentWs,
      'FORBIDDEN',
      'Not a participant in this call'
    );
    expect(resolveCallTermination).not.toHaveBeenCalled();
  });

  it('does not persist an action rejected by termination policy', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'active'
    });
    (resolveCallTermination as jest.Mock).mockReturnValue({
      accepted: false,
      reason: 'socket_mismatch'
    });
    const { handlers, callSessionRouting } = harness();
    callSessionRouting.get.mockReturnValue({ initiatorWs: peerWs });

    await handlers.handle(currentWs, { callSessionId: 'call-1' }, 'hangup');

    expect(persistCallTermination).not.toHaveBeenCalled();
    expect(callSessionRouting.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['cancel', 'ended'],
    ['decline', 'ended'],
    ['hangup', 'ended'],
    ['cancel', 'expired'],
    ['decline', 'expired'],
    ['hangup', 'expired']
  ] as const)('ignores a repeated %s for a terminal %s call', async (kind, state) => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state
    });
    const { handlers, dependencies, logger } = harness();

    await handlers.handle(currentWs, { callSessionId: 'call-1' }, kind);

    expect(resolveCallTermination).not.toHaveBeenCalled();
    expect(persistCallTermination).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'call_termination_duplicate_ignored',
      expect.objectContaining({ callSessionId: 'call-1', kind, state })
    );
    expect(dependencies.logCallDiag).toHaveBeenCalledWith(
      `call_${kind}_duplicate_terminal_ignored`,
      expect.objectContaining({ callSessionId: 'call-1', state })
    );
  });

  it('persists, notifies and cleans up an accepted termination', async () => {
    const callSession = {
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'active'
    };
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(callSession);
    (resolveCallTermination as jest.Mock).mockReturnValue({
      accepted: true,
      context: {
        endReason: 'ended',
        pushEndReason: 'normal',
        peerPushStatus: 'ended',
        peerPushEndReason: 'normal',
        otherParticipantIdentityId: calleeIdentityId
      }
    });
    const { handlers, dependencies, callRingingService, callSessionRouting, logger } = harness();
    callSessionRouting.get.mockReturnValue({
      initiatorWs: currentWs,
      initiatorDeviceId: 'device-caller',
      acceptedTargetWs: peerWs,
      acceptedTargetDeviceId: 'device-callee'
    });

    await handlers.handle(
      currentWs,
      { callSessionId: 'call-1', reason: 'normal' },
      'hangup'
    );

    expect(persistCallTermination).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family-1',
      callSessionId: 'call-1',
      callSession,
      terminationAt: 1_000,
      cancellationDeliveredGraceMs: 3_000,
      cancellationNoDeliveryFallbackMs: 10_000
    }));
    expect(callRingingService.stop).toHaveBeenCalledWith('call-1');
    expect(dependencies.sendMessage).toHaveBeenCalledWith(currentWs, {
      type: 'call:ended',
      data: { callSessionId: 'call-1', reason: 'ended' },
      timestamp: 1_000
    });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(peerWs, {
      type: 'call:ended',
      data: { callSessionId: 'call-1', reason: 'ended' },
      timestamp: 1_000
    });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(siblingWs, {
      type: 'call:ended',
      data: { callSessionId: 'call-1', reason: 'ended' },
      timestamp: 1_000
    });
    expect(sendCallStatusPush).toHaveBeenCalledTimes(2);
    expect(callSessionRouting.remove).toHaveBeenCalledWith('call-1');
    expect(persistAndClearCallIceStats).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1'
    });
    expect(logger.info).toHaveBeenCalledWith(
      'call_termination_accepted',
      expect.objectContaining({
        familyId: 'family-1',
        callSessionId: 'call-1',
        kind: 'hangup',
        identityId: callerIdentityId
      })
    );
  });

  it('keeps call-link presentation in status pushes when the recipient ends the call', async () => {
    const calleeInfo: ConnectionInfo = {
      ...info,
      identityId: calleeIdentityId,
      deviceId: 'device-callee'
    };
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'ringing',
      sdp_offer: JSON.stringify({
        __externalCaller: {
          admissionKind: 'call_link',
          capabilityGrant: {
            descriptor: { payload: { scope: { title: 'Support call' } } }
          }
        }
      })
    });
    (resolveCallTermination as jest.Mock).mockReturnValue({
      accepted: true,
      context: {
        endReason: 'incoming_missing_public_key',
        pushEndReason: 'normal',
        peerPushStatus: 'ended',
        peerPushEndReason: 'normal',
        otherParticipantIdentityId: callerIdentityId
      }
    });
    const { handlers, callSessionRouting } = harness({
      getConnectionInfo: () => calleeInfo
    });
    callSessionRouting.get.mockReturnValue({
      initiatorWs: peerWs,
      acceptedTargetWs: currentWs,
      acceptedTargetDeviceId: 'device-callee'
    });

    await handlers.handle(
      currentWs,
      { callSessionId: 'call-1', reason: 'incoming_missing_public_key' },
      'decline'
    );

    expect(sendCallStatusPush).toHaveBeenCalledWith(
      'family-1',
      calleeIdentityId,
      expect.objectContaining({
        callSessionId: 'call-1',
        isTemporaryLinkCall: true,
        excludeDeviceIds: ['device-callee']
      })
    );
  });

  it('reports a missing call for mobile decline without side effects', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(null);
    const { handlers, callRingingService } = harness();

    await expect(handlers.declineViaMobileAction({
      familyId: 'family-1',
      callSessionId: 'call-missing',
      targetIdentityId: calleeIdentityId
    })).resolves.toEqual({ status: 'not_found' });
    expect(callSessionRepository.end).not.toHaveBeenCalled();
    expect(callRingingService.stop).not.toHaveBeenCalled();
  });

  it('forbids mobile decline by a non-participant', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, 'identity-other'],
      initiator: callerIdentityId,
      state: 'ringing'
    });
    const { handlers } = harness();

    await expect(handlers.declineViaMobileAction({
      familyId: 'family-1',
      callSessionId: 'call-1',
      targetIdentityId: calleeIdentityId
    })).resolves.toEqual({ status: 'forbidden' });
    expect(callSessionRepository.end).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'active', 'ended', 'expired'])(
    'treats mobile decline in %s state as a no-op',
    async (state) => {
      (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
        participants: [callerIdentityId, calleeIdentityId],
        initiator: callerIdentityId,
        state
      });
      const { handlers } = harness();

      await expect(handlers.declineViaMobileAction({
        familyId: 'family-1',
        callSessionId: 'call-1',
        targetIdentityId: calleeIdentityId
      })).resolves.toEqual({ status: 'noop' });
      expect(callSessionRepository.end).not.toHaveBeenCalled();
    }
  );

  it('persists, notifies and cleans up a mobile decline', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'ringing'
    });
    const {
      handlers,
      dependencies,
      callRingingService,
      callSessionRouting
    } = harness();
    callSessionRouting.get.mockReturnValue({ initiatorWs: peerWs });

    await expect(handlers.declineViaMobileAction({
      familyId: 'family-1',
      callSessionId: 'call-1',
      targetIdentityId: calleeIdentityId
    })).resolves.toEqual({ status: 'declined' });

    expect(callSessionRepository.end).toHaveBeenCalledWith('family-1', 'call-1');
    expect(callHistoryRepository.markRejected).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1',
      reason: 'mobile_declined'
    });
    expect(callRingingService.stop).toHaveBeenCalledWith('call-1');
    expect(dependencies.sendMessage).toHaveBeenCalledWith(peerWs, {
      type: 'call:ended',
      data: { callSessionId: 'call-1', reason: 'declined' },
      timestamp: 1_000
    });
    expect(dependencies.sendToConnectionSet).toHaveBeenCalledTimes(2);
    expect(sendCallStatusPush).toHaveBeenCalledTimes(2);
    expect(callSessionRouting.remove).toHaveBeenCalledWith('call-1');
    expect(persistAndClearCallIceStats).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1'
    });
  });
});
