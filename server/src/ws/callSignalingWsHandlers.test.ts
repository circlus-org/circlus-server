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
    prepareOffer: jest.fn(async (_scope, create) => { await create(); return true; }),
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
    replayStoredIceCandidates: jest.fn(),
    sendCallDeliveryStatus: jest.fn(),
    supersedeDisconnectedCall: jest.fn(async () => false),
    callRingingService: callRingingService as any,
    callSessionRouting: callSessionRouting as any,
    describeSocket: jest.fn(() => ({ actorType: 'local' })),
    logCallDiag: jest.fn(),
    logger: logger as any,
    now: () => 1_000,
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

  it('rejects a durable pre-offer cancellation before history, routing, ringing or push', async () => {
    const { handlers, dependencies, callRingingService, callSessionRouting } = harness({ prepareOffer: jest.fn(async () => false) });
    await handlers.handleOffer(callerWs, { targetIdentityId: calleeIdentityId, callSessionId: 'call-cancelled', offer: { type: 'offer', sdp: 'v=0' } });
    expect(callSessionRepository.create).not.toHaveBeenCalled();
    expect(callHistoryRepository.ensureCreated).not.toHaveBeenCalled();
    expect(callSessionRouting.registerInitiator).not.toHaveBeenCalled();
    expect(callRingingService.scheduleExpiry).not.toHaveBeenCalled();
    expect(callRingingService.deliverInitialPush).not.toHaveBeenCalled();
    expect(dependencies.sendToConnectionSet).not.toHaveBeenCalled();
    expect(dependencies.sendMessage).toHaveBeenCalledWith(callerWs, expect.objectContaining({ type: 'call:ended', data: { callSessionId: 'call-cancelled', reason: 'cancelled' } }));
  });
  it('rejects an absent call ID without assigning a replacement', async () => {
    const { handlers, dependencies } = harness();
    await handlers.handleOffer(callerWs, { targetIdentityId: calleeIdentityId, offer: { type: 'offer' } });
    expect(dependencies.prepareOffer).not.toHaveBeenCalled(); expect(callSessionRepository.create).not.toHaveBeenCalled();
    expect(dependencies.logCallDiag).toHaveBeenCalledWith('call_offer_route_rejected', expect.objectContaining({ reason: 'CALL_ROUTE_INCOMPLETE', missingFields: ['callSessionId'] }));
  });
  it.each(['call', 'peer', 'role'])('rejects a native offer with mismatched registered %s', async field => {
    const { handlers, dependencies } = harness({ getConnectionInfo: () => ({ ...callerInfo, actorType: 'local', runtimeMode: 'video-native',
      scopedCallSessionId: field === 'call' ? 'other-call' : 'call-1', scopedRemoteIdentityId: field === 'peer' ? callerIdentityId : calleeIdentityId,
      callRuntimeRole: field === 'role' ? 'callee' : 'caller' }) });
    await handlers.handleOffer(callerWs, { callSessionId: 'call-1', targetIdentityId: calleeIdentityId, offer: { type: 'offer' } });
    expect(dependencies.prepareOffer).not.toHaveBeenCalled(); expect(callSessionRepository.create).not.toHaveBeenCalled();
    expect(dependencies.logCallDiag).toHaveBeenCalledWith('call_offer_route_rejected', expect.objectContaining({ reason: 'CALL_RUNTIME_ROUTE_MISMATCH' }));
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

  it('does not forward a racing answer after another device won the route binding', async () => {
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({ participants: [callerIdentityId, calleeIdentityId], initiator: callerIdentityId, state: 'ringing', created_at: new Date(500), ice_candidates: [] });
    const { handlers, dependencies, callSessionRouting } = harness();
    callSessionRouting.get.mockReturnValue({ initiatorWs: callerWs });
    callSessionRouting.bindAcceptedTargetIfAbsent.mockReturnValue({ status: 'already_bound', route: { initiatorWs: callerWs, acceptedTargetWs: otherDeviceWs, acceptedTargetDeviceId: 'other-device' } });
    await handlers.handleAnswer(calleeWs, { callSessionId: 'call-1', answer: { type: 'answer', sdp: 'v=0' } });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(calleeWs, expect.objectContaining({ type: 'call:ended', data: { callSessionId: 'call-1', reason: 'answered_elsewhere' } }));
    expect(dependencies.sendMessage).not.toHaveBeenCalledWith(callerWs, expect.objectContaining({ type: 'call:answered' }));
    expect(sendCallStatusPush).not.toHaveBeenCalled();
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

  describe('delegated native media endpoint authority', () => {
    const nativeCaller: ConnectionInfo = { ...callerInfo, runtimeMode: 'video-native',
      scopedCallSessionId: 'call-1', scopedRemoteIdentityId: calleeIdentityId, callRuntimeRole: 'caller' };
    const route = { familyId: 'family-1', initiatorIdentityId: callerIdentityId, initiatorDeviceId: 'caller-device',
      initiatorWs: callerWs, targetIdentityId: calleeIdentityId, acceptedTargetDeviceId: 'callee-device', acceptedTargetWs: calleeWs };
    const call = { participants: [callerIdentityId, calleeIdentityId], initiator: callerIdentityId, state: 'active' };
    const operations = [
      ['handleRenegotiateOffer', { offer: { type: 'offer', sdp: 'private-sdp' } }],
      ['handleRenegotiateAnswer', { answer: { type: 'answer', sdp: 'private-sdp' } }],
      ['handleIceCandidate', { candidate: { candidate: 'private-candidate' } }],
      ['handleVideoState', { enabled: true }]
    ] as const;
    const invalid = [
      ['missing peer', { scopedRemoteIdentityId: undefined }, {}, 'call-1', 'CALL_MEDIA_SCOPE_REQUIRED'],
      ['missing call', { scopedCallSessionId: undefined }, {}, 'call-1', 'CALL_MEDIA_SCOPE_REQUIRED'],
      ['missing role', { callRuntimeRole: undefined }, {}, 'call-1', 'CALL_MEDIA_SCOPE_REQUIRED'],
      ['wrong call', {}, {}, 'call-2', 'CALL_MEDIA_SCOPE_MISMATCH'],
      ['other Circle on same origin', {}, { familyId: 'family-2' }, 'call-1', 'CALL_MEDIA_ROUTE_MISMATCH'],
      ['wrong peer', { scopedRemoteIdentityId: 'third-identity' }, {}, 'call-1', 'CALL_MEDIA_ROUTE_MISMATCH'],
      ['wrong role', { callRuntimeRole: 'callee' }, {}, 'call-1', 'CALL_MEDIA_PEER_MISMATCH'],
      ['sibling device', { deviceId: 'sibling-device' }, {}, 'call-1', 'CALL_MEDIA_ENDPOINT_MISMATCH'],
      ['replaced socket on same device', {}, { initiatorWs: otherDeviceWs }, 'call-1', 'CALL_MEDIA_ENDPOINT_MISMATCH'],
      ['unknown selected device', {}, { initiatorDeviceId: undefined }, 'call-1', 'CALL_MEDIA_DEVICE_REQUIRED']
    ] as const;
    for (const [method, fields] of operations) {
      it.each(invalid)(`${method} rejects %s before persistence or forwarding`, async (_label, infoChange, routeChange, id, reason) => {
        const info = { ...nativeCaller, ...infoChange } as ConnectionInfo;
        const { handlers, dependencies, callSessionRouting } = harness({ getConnectionInfo: () => info });
        callSessionRouting.get.mockReturnValue({ ...route, ...routeChange });
        callSessionRouting.resolvePeerSocket.mockReturnValue(calleeWs);
        (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(call);
        await (handlers[method] as any)(callerWs, { callSessionId: id, ...fields });
        expect(dependencies.sendError).toHaveBeenCalledWith(callerWs, 'FORBIDDEN', reason);
        expect(callSessionRepository.updateSdpOffer).not.toHaveBeenCalled();
        expect(callSessionRepository.updateSdpAnswer).not.toHaveBeenCalled();
        expect(callSessionRepository.addIceCandidate).not.toHaveBeenCalled();
        expect(dependencies.sendMessage).not.toHaveBeenCalled();
        expect(dependencies.sendToConnectionSet).not.toHaveBeenCalled();
        expect(JSON.stringify((dependencies.logCallDiag as jest.Mock).mock.calls)).not.toMatch(/private-sdp|private-candidate/);
      });
      it(`${method} accepts only the selected native endpoint`, async () => {
        const { handlers, dependencies, callSessionRouting } = harness({ getConnectionInfo: () => nativeCaller });
        callSessionRouting.get.mockReturnValue(route); callSessionRouting.resolvePeerSocket.mockReturnValue(calleeWs);
        (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(call);
        await (handlers[method] as any)(callerWs, { callSessionId: 'call-1', ...fields });
        expect(dependencies.sendError).not.toHaveBeenCalled();
        expect(dependencies.sendMessage).toHaveBeenCalledWith(calleeWs, expect.anything());
        expect(dependencies.sendToConnectionSet).not.toHaveBeenCalled();
      });
      it(`${method} accepts the selected callee and rejects its sibling device`, async () => {
        const nativeCallee: ConnectionInfo = { ...calleeInfo, runtimeMode: 'video-native', scopedCallSessionId: 'call-1',
          scopedRemoteIdentityId: callerIdentityId, callRuntimeRole: 'callee' };
        const { handlers, dependencies, callSessionRouting } = harness({ getConnectionInfo: () => nativeCallee });
        callSessionRouting.get.mockReturnValue(route); callSessionRouting.resolvePeerSocket.mockReturnValue(callerWs);
        (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(call);
        await (handlers[method] as any)(calleeWs, { callSessionId: 'call-1', ...fields });
        expect(dependencies.sendError).not.toHaveBeenCalled();
        expect(dependencies.sendMessage).toHaveBeenCalledWith(callerWs, expect.anything());
        jest.clearAllMocks();
        callSessionRouting.get.mockReturnValue({ ...route, acceptedTargetDeviceId: 'other-device' });
        await (handlers[method] as any)(calleeWs, { callSessionId: 'call-1', ...fields });
        expect(dependencies.sendError).toHaveBeenCalledWith(calleeWs, 'FORBIDDEN', 'CALL_MEDIA_ENDPOINT_MISMATCH');
        expect(dependencies.sendMessage).not.toHaveBeenCalled();
        expect(callSessionRepository.updateSdpOffer).not.toHaveBeenCalled();
        expect(callSessionRepository.updateSdpAnswer).not.toHaveBeenCalled();
        expect(callSessionRepository.addIceCandidate).not.toHaveBeenCalled();
      });
      it(`${method} rejects an absent or ambiguous route`, async () => {
        const { handlers, dependencies, callSessionRouting } = harness({ getConnectionInfo: () => nativeCaller });
        (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(call);
        await (handlers[method] as any)(callerWs, { callSessionId: 'call-1', ...fields });
        expect(dependencies.sendError).toHaveBeenCalledWith(callerWs, 'FORBIDDEN', 'CALL_MEDIA_ROUTE_REQUIRED');
        jest.clearAllMocks(); callSessionRouting.get.mockReturnValue(route);
        (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({ ...call, participants: [...call.participants, 'third-identity'] });
        await (handlers[method] as any)(callerWs, { callSessionId: 'call-1', ...fields });
        expect(dependencies.sendError).toHaveBeenCalledWith(callerWs, 'FORBIDDEN', 'CALL_MEDIA_ROUTE_MISMATCH');
        expect(dependencies.sendMessage).not.toHaveBeenCalled();
        expect(callSessionRepository.updateSdpOffer).not.toHaveBeenCalled();
        expect(callSessionRepository.updateSdpAnswer).not.toHaveBeenCalled();
        expect(callSessionRepository.addIceCandidate).not.toHaveBeenCalled();
      });
      it(`${method} rejects authentication replacement during the call lookup`, async () => {
        let info: ConnectionInfo = nativeCaller;
        const { handlers, dependencies, callSessionRouting } = harness({ getConnectionInfo: () => info });
        callSessionRouting.get.mockReturnValue(route); callSessionRouting.resolvePeerSocket.mockReturnValue(calleeWs);
        (callSessionRepository.findByCallSessionId as jest.Mock).mockImplementation(async () => { info = { ...nativeCaller }; return call; });
        await (handlers[method] as any)(callerWs, { callSessionId: 'call-1', ...fields });
        expect(dependencies.sendError).toHaveBeenCalledWith(callerWs, 'FORBIDDEN', 'CALL_MEDIA_AUTHORITY_CHANGED');
        expect(dependencies.sendMessage).not.toHaveBeenCalled();
        expect(callSessionRepository.updateSdpOffer).not.toHaveBeenCalled();
        expect(callSessionRepository.updateSdpAnswer).not.toHaveBeenCalled();
        expect(callSessionRepository.addIceCandidate).not.toHaveBeenCalled();
      });
    }
    it('stores initial caller ICE without broadcasting to unselected devices', async () => {
      const { handlers, dependencies, callSessionRouting } = harness({ getConnectionInfo: () => nativeCaller });
      callSessionRouting.get.mockReturnValue({ ...route, acceptedTargetWs: undefined, acceptedTargetDeviceId: undefined });
      (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({ ...call, state: 'ringing' });
      await handlers.handleIceCandidate(callerWs, { callSessionId: 'call-1', candidate: { candidate: 'candidate:initial' } });
      expect(callSessionRepository.addIceCandidate).toHaveBeenCalled();
      expect(dependencies.sendToConnectionSet).not.toHaveBeenCalled();
      expect(dependencies.sendError).not.toHaveBeenCalled();
    });
    it('does not persist a native renegotiation without a selected peer', async () => {
      const { handlers, dependencies, callSessionRouting } = harness({ getConnectionInfo: () => nativeCaller });
      callSessionRouting.get.mockReturnValue(route);
      (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue(call);
      await handlers.handleRenegotiateOffer(callerWs, { callSessionId: 'call-1', offer: {} });
      expect(dependencies.sendError).toHaveBeenCalledWith(callerWs, 'FORBIDDEN', 'CALL_MEDIA_PEER_REQUIRED');
      expect(callSessionRepository.updateSdpOffer).not.toHaveBeenCalled();
    });
  });

});
