jest.mock('../db/repositories', () => ({
  callHistoryRepository: { markMissed: jest.fn() },
  callSessionRepository: { updateState: jest.fn() },
  identityRepository: { findByIdentityId: jest.fn() },
  systemEventRepository: { insertEvent: jest.fn() }
}));
jest.mock('../utils/push', () => ({ sendCallStatusPush: jest.fn() }));
jest.mock('./configService', () => ({
  configService: { requireFamilyConfig: jest.fn() }
}));
jest.mock('./callTerminationService', () => ({
  stableMissedCallEventId: jest.fn(() => 'event-1')
}));
jest.mock('../utils/serverIdentity', () => ({
  resolveServerIdForClients: jest.fn(() => 'server-1')
}));
jest.mock('../ws/callIceDiagnostics', () => ({
  persistAndClearCallIceStats: jest.fn()
}));

import type { WebSocket } from 'ws';
import {
  callHistoryRepository,
  callSessionRepository,
  identityRepository,
  systemEventRepository
} from '../db/repositories';
import { sendCallStatusPush } from '../utils/push';
import { configService } from './configService';
import { persistAndClearCallIceStats } from '../ws/callIceDiagnostics';
import { CallExpirationService, type CallExpirationDependencies } from './callExpirationService';

const initiatorWs = {} as WebSocket;
const targetWs = {} as WebSocket;

function harness(overrides: Partial<CallExpirationDependencies> = {}) {
  const logger = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn()
  };
  const dependencies: CallExpirationDependencies = {
    getInitiatorSocket: jest.fn(() => initiatorWs),
    getTargetSockets: jest.fn(() => new Set([targetWs])),
    sendMessage: jest.fn(),
    sendToConnectionSet: jest.fn(),
    resolvePublishedIdentityName: jest.fn(async () => 'Caller'),
    removeRoute: jest.fn(),
    logger: logger as any,
    now: () => 2_000,
    ...overrides
  };
  return {
    dependencies,
    logger,
    service: new CallExpirationService(dependencies)
  };
}

const expiration = {
  familyId: 'family-1',
  callSessionId: 'call-1',
  initiatorIdentityId: 'identity-caller',
  targetIdentityId: 'identity-callee',
  isTemporaryLinkCall: true,
  callSession: {
    state: 'ringing',
    created_at: new Date(1_000)
  }
};

describe('call expiration service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      identity_id: 'identity-caller'
    });
    (configService.requireFamilyConfig as jest.Mock).mockResolvedValue({
      public_base_url: 'https://circle.example',
      circle_id: 'server-1'
    });
    (sendCallStatusPush as jest.Mock).mockResolvedValue(undefined);
  });

  it('expires, notifies, records the missed call, and cleans up', async () => {
    const { service, dependencies } = harness();

    await service.expire(expiration);

    expect(callSessionRepository.updateState).toHaveBeenCalledWith(
      'family-1',
      'call-1',
      'expired'
    );
    expect(sendCallStatusPush).toHaveBeenCalledWith(
      'family-1',
      'identity-callee',
      expect.objectContaining({ callStatus: 'missed', callEndReason: 'timeout' })
    );
    const endedMessage = {
      type: 'call:ended',
      data: { callSessionId: 'call-1', reason: 'timeout' },
      timestamp: 2_000
    };
    expect(dependencies.sendMessage).toHaveBeenCalledWith(initiatorWs, endedMessage);
    expect(dependencies.sendToConnectionSet).toHaveBeenCalledWith(
      new Set([targetWs]),
      endedMessage
    );
    expect(systemEventRepository.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        circleId: 'server-1',
        type: 'call:missed',
        createdAt: 2_000,
        payload: expect.objectContaining({
          isTemporaryLinkCall: true,
          callCreatedAt: 1_000
        })
      })
    );
    expect(callHistoryRepository.markMissed).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1',
      reason: 'timeout'
    });
    expect(dependencies.removeRoute).toHaveBeenCalledWith('call-1');
    expect(persistAndClearCallIceStats).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call-1'
    });
  });

  it('continues durable expiration when the best-effort push fails', async () => {
    (sendCallStatusPush as jest.Mock).mockRejectedValue(new Error('push unavailable'));
    const { service, logger } = harness();

    await service.expire(expiration);

    expect(systemEventRepository.insertEvent).toHaveBeenCalled();
    expect(callHistoryRepository.markMissed).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'call_expiration_status_push_failed',
      expect.objectContaining({
        familyId: 'family-1',
        callSessionId: 'call-1',
        error: expect.any(Error)
      })
    );
  });
});
