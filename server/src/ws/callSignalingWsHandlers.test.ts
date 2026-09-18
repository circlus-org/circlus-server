jest.mock('../db/repositories', () => ({
  callHistoryRepository: {
    ensureCreated: jest.fn(),
    markAccepted: jest.fn()
  },
  callSessionRepository: {
    create: jest.fn(),
    findByCallSessionId: jest.fn(),
    updateState: jest.fn(),
    updateSdpOffer: jest.fn(),
    updateSdpAnswer: jest.fn(),
    addIceCandidate: jest.fn()
  },
  directGuestRegistrationRepository: { touchLastSeen: jest.fn() },
  identityRepository: { findByIdentityId: jest.fn() }
}));
jest.mock('../services/directGuestAccessService', () => ({
  resolveDirectCommunicationAccess: jest.fn()
}));
jest.mock('../utils/push', () => ({ sendCallStatusPush: jest.fn() }));
jest.mock('../services/linkCapabilityService', () => ({
  verifyCapabilityProof: jest.fn(() => true)
}));
jest.mock('./callIceDiagnostics', () => ({
  ensureCallIceStats: jest.fn(),
  recordCallIceCandidate: jest.fn(() => ({
    entry: { total: 1, relay: 0, srflx: 1, host: 0, prflx: 0 },
    parsed: {
      candidateType: 'srflx',
      protocol: 'udp',
      address: '192.0.2.1',
      port: 1234
    }
  }))
}));

import type { WebSocket } from 'ws';
import {
  callHistoryRepository,
  callSessionRepository,
  identityRepository
} from '../db/repositories';
import { resolveDirectCommunicationAccess } from '../services/directGuestAccessService';
import { sendCallStatusPush } from '../utils/push';
import {
  CallSignalingWsHandlers,
  type CallSignalingWsHandlerDependencies
} from './callSignalingWsHandlers';
import type { ConnectionInfo } from './wsConnectionContext';

const callerWs = {} as WebSocket;
const calleeWs = {} as WebSocket;
const otherDeviceWs = {} as WebSocket;
const callerIdentityId = 'BBBBBBBBBBBBBBBBBBBBBBBBBB';
const calleeIdentityId = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';

const callerInfo: ConnectionInfo = {
  actorType: 'local',
  familyId: 'family-1',
  identityId: callerIdentityId,
  deviceId: 'caller-device',
  runtimeMode: 'default',
  clientRuntime: 'web'
};
const calleeInfo: ConnectionInfo = {
  actorType: 'local',
  familyId: 'family-1',
  identityId: calleeIdentityId,
  deviceId: 'callee-device',
  runtimeMode: 'default',
  clientRuntime: 'web'
};

function pushResult() {
  return {
    status: 'sent',
    summary: {
      devicesTotal: 1,
      totals: {
        subscriptionsTotal: 1,
        sent: 1,
        invalidated: 0,
        skipped: 0,
        failed: 0
      },
      deviceResults: [{ failures: [] }]
    },
    couldNotReachReason: undefined,
    trailingStatusSent: false
  };
}

function harness(overrides: Partial<CallSignalingWsHandlerDependencies> = {}) {
  const logger = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn()
  };
  const connectionInfo = new Map<WebSocket, ConnectionInfo>([
    [callerWs, callerInfo],
    [calleeWs, calleeInfo],
    [otherDeviceWs, { ...calleeInfo, deviceId: 'other-device' }]
  ]);
  const callSessionRouting = {
    get: jest.fn(),
    registerInitiator: jest.fn(),
    bindAcceptedTargetIfAbsent: jest.fn(),
    resolvePeerSocket: jest.fn()
  };
  const callRingingService = {
    scheduleExpiry: jest.fn(),
    deliverInitialPush: jest.fn(async () => pushResult()),
    stop: jest.fn()
  };
  const dependencies: CallSignalingWsHandlerDependencies = {
    getConnectionInfo: (ws) => connectionInfo.get(ws),
    getWebIncomingCallSockets: jest.fn(() => new Set([calleeWs])),
    getGeneralIdentitySockets: jest.fn(() => new Set([calleeWs, otherDeviceWs])),
    getIdentitySockets: jest.fn(() => new Set([calleeWs])),
    sendMessage: jest.fn(),
    sendToConnectionSet: jest.fn(),
    sendError: jest.fn(),
    validateTemporaryCallDelegation: jest.fn(async () => true),
    consumeEarlyEndedCallSession: jest.fn(() => false),
    isTemporaryCallTargetAllowed: jest.fn(async () => true),
    resolvePublishedIdentityName: jest.fn(async () => 'Published name'),
    replayStoredIceCandidates: jest.fn(),
    sendCallDeliveryStatus: jest.fn(),
    supersedeDisconnectedCall: jest.fn(async () => false),
    callRingingService: callRingingService as any,
    callSessionRouting: callSessionRouting as any,
    describeSocket: jest.fn(() => ({ actorType: 'local' })),
    logCallDiag: jest.fn(),
    logger: logger as any,
    now: () => 1_000,
    createCallSessionId: () => 'call-generated',
    ...overrides
  };
  return {
    callRingingService,
    callSessionRouting,
    logger,
    dependencies,
    handlers: new CallSignalingWsHandlers(dependencies)
  };
}

describe('call signaling WebSocket handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      status: 'active',
      public_key_algorithm: 'ed25519',
      public_key_value: 'identity-public-key',
      publish_identity: true,
      identity_name: 'Published name'
    });
    (resolveDirectCommunicationAccess as jest.Mock).mockResolvedValue({
      allowed: true,
      relation: 'contact'
    });
    (sendCallStatusPush as jest.Mock).mockResolvedValue(undefined);
  });

  it('rejects signaling from an unauthenticated socket', async () => {
    const { handlers, dependencies } = harness({ getConnectionInfo: () => undefined });
    await handlers.handleOffer(callerWs, {
      targetIdentityId: calleeIdentityId,
      offer: { type: 'offer' }
    });
    expect(dependencies.sendError).toHaveBeenCalledWith(
      callerWs,
      'UNAUTHORIZED',
      'Not authenticated'
    );
  });

  it('creates, routes and delivers a valid offer', async () => {
    const { handlers, dependencies, callRingingService, callSessionRouting, logger } = harness();
    await handlers.handleOffer(callerWs, {
      targetIdentityId: calleeIdentityId,
      callSessionId: 'call-1',
      offer: { type: 'offer', sdp: 'v=0' }
    });

    expect(callSessionRepository.create).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1',
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'new'
    });
    expect(callHistoryRepository.ensureCreated).toHaveBeenCalled();
    expect(callSessionRouting.registerInitiator).toHaveBeenCalledWith(
      expect.objectContaining({
        callSessionId: 'call-1',
        initiatorWs: callerWs,
        targetIdentityId: calleeIdentityId
      })
    );
    expect(dependencies.sendToConnectionSet).toHaveBeenCalledWith(
      new Set([calleeWs]),
      expect.objectContaining({ type: 'call:incoming' })
    );
    expect(callRingingService.deliverInitialPush).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('call_offer_received', expect.objectContaining({
      familyId: 'family-1',
      fromIdentityId: callerIdentityId,
      targetIdentityId: calleeIdentityId,
      clientCallSessionId: 'call-1'
    }));
    expect(logger.info).toHaveBeenCalledWith(
      'call_incoming_delivered_via_ws',
      expect.objectContaining({ callSessionId: 'call-1', socketCount: 1 })
    );
  });

  it.each([60_000, 1_000, 999])('checks expiry %i again after guest registration before delivering a call', async (expiresAt) => {
    const externalPublicKey = { algorithm: 'ed25519' as const, value: 'external-public-key' };
    const descriptor = {
      payload: { capabilityId: 'cap_123', expiresAt: new Date(expiresAt).toISOString(), scope: { title: 'Support' } }
    } as any;
    const registrationProof = { payload: { capabilityId: 'cap_123' } } as any;
    const callProof = {
      timestamp: 1_000,
      payload: {
        capabilityId: 'cap_123',
        context: { callSessionId: 'call-link-1' },
        subjectPublicKey: externalPublicKey
      }
    } as any;
    const externalInfo: ConnectionInfo = {
      actorType: 'external',
      familyId: 'family-1',
      identityId: callerIdentityId,
      deviceId: `ext:${callerIdentityId}`,
      externalPublicKey,
      callGrant: {
        kind: 'call_link',
        admissionId: 'cl_1',
        targetIdentityId: calleeIdentityId,
        callLinkTitle: 'Support',
        capabilityGrant: { descriptor, proof: registrationProof }
      }
    };
    const { handlers, dependencies } = harness({
      getConnectionInfo: (ws) => ws === callerWs ? externalInfo : calleeInfo
    });

    await handlers.handleOffer(callerWs, {
      targetIdentityId: calleeIdentityId,
      callSessionId: 'call-link-1',
      offer: { type: 'offer', sdp: 'v=0', callCapabilityProof: callProof }
    });

    if (expiresAt <= 1_000) {
      expect(dependencies.sendError).toHaveBeenCalledWith(callerWs, 'FORBIDDEN', 'Call link has expired');
      expect(callSessionRepository.updateSdpOffer).not.toHaveBeenCalled();
      expect(dependencies.sendToConnectionSet).not.toHaveBeenCalled();
      return;
    }
    const storedOffer = JSON.parse(
      (callSessionRepository.updateSdpOffer as jest.Mock).mock.calls[0][2]
    );
    expect(storedOffer.__externalCaller.callLinkTitle).toBe('Support');

    expect(dependencies.sendToConnectionSet).toHaveBeenCalledWith(
      new Set([calleeWs]),
      expect.objectContaining({
        type: 'call:incoming',
        data: expect.objectContaining({
          fromIdentityPublicKey: externalPublicKey,
          isTemporaryLinkCall: true,
          callLinkTitle: 'Support',
          capabilityGrant: { descriptor, proof: callProof }
        })
      })
    );
  });

  it('verifies and supersedes a disconnected call before creating the guest redial', async () => {
    const externalPublicKey = { algorithm: 'ed25519' as const, value: 'external-public-key' };
    const descriptor = {
      payload: { capabilityId: 'cap_123', expiresAt: new Date(60_000).toISOString(), scope: {} }
    } as any;
    const externalInfo: ConnectionInfo = {
      actorType: 'external', familyId: 'family-1', identityId: callerIdentityId,
      deviceId: `ext:${callerIdentityId}`, externalPublicKey,
      callGrant: {
        kind: 'call_link', admissionId: 'cl_1', targetIdentityId: calleeIdentityId,
        capabilityGrant: { descriptor, proof: {} as any }
      }
    };
    const { handlers, dependencies } = harness({
      getConnectionInfo: (ws) => ws === callerWs ? externalInfo : calleeInfo,
      supersedeDisconnectedCall: jest.fn(async () => true)
    });
    const proof = {
      timestamp: 1_000,
      payload: {
        capabilityId: 'cap_123', subjectPublicKey: externalPublicKey,
        context: { callSessionId: 'call-new', supersedesCallSessionId: 'call-old' }
      }
    } as any;

    await handlers.handleOffer(callerWs, {
      targetIdentityId: calleeIdentityId,
      callSessionId: 'call-new',
      supersedesCallSessionId: 'call-old',
      offer: { type: 'offer', sdp: 'v=0', callCapabilityProof: proof }
    });

    expect(dependencies.supersedeDisconnectedCall).toHaveBeenCalledWith({
      ws: callerWs,
      info: externalInfo,
      previousCallSessionId: 'call-old',
      nextCallSessionId: 'call-new',
      targetIdentityId: calleeIdentityId
    });
    expect(dependencies.supersedeDisconnectedCall.mock.invocationCallOrder[0])
      .toBeLessThan((callSessionRepository.create as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('rejects a redial whose signed proof does not bind the superseded call id', async () => {
    const externalPublicKey = { algorithm: 'ed25519' as const, value: 'external-public-key' };
    const externalInfo: ConnectionInfo = {
      actorType: 'external', familyId: 'family-1', identityId: callerIdentityId,
      deviceId: `ext:${callerIdentityId}`, externalPublicKey,
      callGrant: {
        kind: 'call_link', admissionId: 'cl_1', targetIdentityId: calleeIdentityId,
        capabilityGrant: {
          descriptor: { payload: { capabilityId: 'cap_123', expiresAt: new Date(60_000).toISOString() } } as any,
          proof: {} as any
        }
      }
    };
    const { handlers, dependencies } = harness({
      getConnectionInfo: (ws) => ws === callerWs ? externalInfo : calleeInfo
    });

    await handlers.handleOffer(callerWs, {
      targetIdentityId: calleeIdentityId,
      callSessionId: 'call-new',
      supersedesCallSessionId: 'call-old',
      offer: {
        type: 'offer',
        callCapabilityProof: {
          timestamp: 1_000,
          payload: { context: { callSessionId: 'call-new', supersedesCallSessionId: 'different-call' } }
        }
      }
    });

    expect(dependencies.sendError).toHaveBeenCalledWith(callerWs, 'FORBIDDEN', 'Call capability proof is invalid');
    expect(dependencies.supersedeDisconnectedCall).not.toHaveBeenCalled();
    expect(callSessionRepository.create).not.toHaveBeenCalled();
  });

  it('still delivers the offer when call history creation fails', async () => {
    (callHistoryRepository.ensureCreated as jest.Mock).mockRejectedValueOnce(new Error('history unavailable'));
    const { handlers, dependencies, logger } = harness();

    await handlers.handleOffer(callerWs, {
      targetIdentityId: calleeIdentityId,
      callSessionId: 'call-history-fails',
      offer: { type: 'offer', sdp: 'v=0' }
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'call_history_create_failed_non_fatal',
      expect.objectContaining({ callSessionId: 'call-history-fails' })
    );
    expect(dependencies.sendError).not.toHaveBeenCalledWith(
      callerWs,
      'INTERNAL_ERROR',
      'Failed to initiate call'
    );
    expect(dependencies.sendToConnectionSet).toHaveBeenCalledWith(
      new Set([calleeWs]),
      expect.objectContaining({ type: 'call:incoming' })
    );
  });

  it('does not create a call when direct communication is forbidden', async () => {
    (resolveDirectCommunicationAccess as jest.Mock).mockResolvedValue({
      allowed: false,
      reason: 'not_contacts'
    });
    const { handlers, dependencies } = harness();
    await handlers.handleOffer(callerWs, {
      targetIdentityId: calleeIdentityId,
      offer: { type: 'offer' }
    });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(callerWs, expect.objectContaining({
      type: 'error', data: expect.objectContaining({ code: 'CALL_ACCESS_DENIED', reason: 'not_contacts' })
    }));
    expect(callSessionRepository.create).not.toHaveBeenCalled();
  });

  it('rejects an answer from a non-participant', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, 'CCCCCCCCCCCCCCCCCCCCCCCCCC'],
      initiator: callerIdentityId,
      state: 'ringing'
    });
    const { handlers, dependencies } = harness();
    await handlers.handleAnswer(calleeWs, {
      callSessionId: 'call-1',
      answer: { type: 'answer' }
    });
    expect(dependencies.sendError).toHaveBeenCalledWith(
      calleeWs,
      'FORBIDDEN',
      'Not a participant in this call'
    );
  });

  it('accepts the first answer and forwards it to the initiating socket', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'ringing',
      created_at: new Date(500),
      ice_candidates: []
    });
    const { handlers, dependencies, callSessionRouting } = harness();
    callSessionRouting.get.mockReturnValue({ initiatorWs: callerWs });
    callSessionRouting.bindAcceptedTargetIfAbsent.mockReturnValue({
      status: 'bound',
      route: { initiatorWs: callerWs }
    });

    await handlers.handleAnswer(calleeWs, {
      callSessionId: 'call-1',
      answer: { type: 'answer', sdp: 'v=0' }
    });

    expect(callSessionRepository.updateState).toHaveBeenCalledWith(
      'family-1',
      'call-1',
      'accepted'
    );
    expect(dependencies.sendMessage).toHaveBeenCalledWith(
      callerWs,
      expect.objectContaining({ type: 'call:answered' })
    );
    expect(dependencies.sendMessage).toHaveBeenCalledWith(
      otherDeviceWs,
      expect.objectContaining({
        type: 'call:ended',
        data: expect.objectContaining({ reason: 'answered_elsewhere' })
      })
    );
  });

  it('forwards the answer while the stop-ringing push is still pending', async () => {
    let releasePush!: () => void;
    (sendCallStatusPush as jest.Mock).mockReturnValue(new Promise<void>(resolve => { releasePush = resolve; }));
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId], initiator: callerIdentityId,
      state: 'ringing', created_at: new Date(500), ice_candidates: []
    });
    const { handlers, dependencies, callSessionRouting } = harness();
    callSessionRouting.get.mockReturnValue({ initiatorWs: callerWs });
    callSessionRouting.bindAcceptedTargetIfAbsent.mockReturnValue({ status: 'bound', route: { initiatorWs: callerWs } });
    const answer = handlers.handleAnswer(calleeWs, { callSessionId: 'call-1', answer: { type: 'answer', sdp: 'v=0' } });
    // Let the asynchronous database/identity lookups finish without resolving push.
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(sendCallStatusPush).toHaveBeenCalled();
      expect(dependencies.sendMessage).toHaveBeenCalledWith(callerWs, expect.objectContaining({ type: 'call:answered' }));
    } finally {
      releasePush();
      await answer;
    }
  });

  it('routes renegotiation to the concrete peer socket', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'active'
    });
    const { handlers, dependencies, callSessionRouting } = harness();
    callSessionRouting.get.mockReturnValue({ targetIdentityId: calleeIdentityId });
    callSessionRouting.resolvePeerSocket.mockReturnValue(calleeWs);

    await handlers.handleRenegotiateOffer(callerWs, {
      callSessionId: 'call-1',
      offer: { type: 'offer', iceRestart: true }
    });

    expect(dependencies.sendMessage).toHaveBeenCalledWith(
      calleeWs,
      expect.objectContaining({ type: 'call:renegotiate-offer' })
    );
    expect(dependencies.sendToConnectionSet).not.toHaveBeenCalled();
  });

  it('persists and routes ICE to the accepted peer socket', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'active'
    });
    const { handlers, dependencies, callSessionRouting } = harness();
    callSessionRouting.get.mockReturnValue({ acceptedTargetWs: calleeWs });
    callSessionRouting.resolvePeerSocket.mockReturnValue(calleeWs);
    const candidate = { candidate: 'candidate:1 1 UDP 1 192.0.2.1 1234 typ srflx' };

    await handlers.handleIceCandidate(callerWs, {
      callSessionId: 'call-1',
      candidate
    });

    expect(callSessionRepository.addIceCandidate).toHaveBeenCalledWith(
      'family-1',
      'call-1',
      { from: callerIdentityId, candidate }
    );
    expect(dependencies.sendMessage).toHaveBeenCalledWith(calleeWs, {
      type: 'call:ice-candidate',
      data: { callSessionId: 'call-1', candidate },
      timestamp: 1_000
    });
  });

  it('does not persist or forward ICE for a terminal call', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'ended'
    });
    const { handlers, dependencies } = harness();

    await handlers.handleIceCandidate(callerWs, {
      callSessionId: 'call-1',
      candidate: { candidate: 'candidate:terminal' }
    });

    expect(callSessionRepository.addIceCandidate).not.toHaveBeenCalled();
    expect(dependencies.sendMessage).not.toHaveBeenCalled();
    expect(dependencies.sendToConnectionSet).not.toHaveBeenCalled();
  });

  it('tells a participant returning after timeout that the call has ended', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId], initiator: callerIdentityId, state: 'ended'
    });
    const { handlers, dependencies } = harness();
    await handlers.handleVideoState(callerWs, { callSessionId: 'call-1', enabled: false, requestReply: true });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(callerWs, expect.objectContaining({
      type: 'call:ended', data: { callSessionId: 'call-1', reason: 'ended' }
    }));
    expect(dependencies.sendToConnectionSet).not.toHaveBeenCalled();
  });

  it('routes video state through the concrete call route', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId],
      initiator: callerIdentityId,
      state: 'active'
    });
    const { handlers, dependencies, callSessionRouting } = harness();
    callSessionRouting.resolvePeerSocket.mockReturnValue(calleeWs);

    await handlers.handleVideoState(callerWs, {
      callSessionId: 'call-1',
      enabled: false
    });

    expect(dependencies.sendMessage).toHaveBeenCalledWith(calleeWs, {
      type: 'call:video-state',
      data: { callSessionId: 'call-1', enabled: false },
      timestamp: 1_000
    });
  });
  it.each(['camera', 'screen'] as const)('forwards %s with enabled video and a snapshot request', async (source) => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      participants: [callerIdentityId, calleeIdentityId], initiator: callerIdentityId, state: 'active'
    });
    const { handlers, dependencies, callSessionRouting } = harness();
    callSessionRouting.resolvePeerSocket.mockReturnValue(calleeWs);
    await handlers.handleVideoState(callerWs, {
      callSessionId: 'call-1', enabled: true, source, requestReply: true
    });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(calleeWs, {
      type: 'call:video-state',
      data: { callSessionId: 'call-1', enabled: true, source, requestReply: true },
      timestamp: 1_000
    });
  });

});
