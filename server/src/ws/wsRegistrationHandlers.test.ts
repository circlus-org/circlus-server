jest.mock('./wsResourceGuard', () => ({ markWebSocketRegistered: jest.fn() }));
import { markWebSocketRegistered } from './wsResourceGuard';
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../db/repositories', () => ({
  callSessionRepository: {
    findByCallSessionId: jest.fn(),
    updateState: jest.fn()
  },
  identityRepository: { findByIdentityId: jest.fn() },
  temporaryDeviceRepository: {
    findByDeviceIdAnyFamily: jest.fn(),
    terminateAccessAndRotateEpochs: jest.fn()
  }
}));
jest.mock('../middleware/auth', () => ({
  createNonceStore: () => new Map<string, number>(),
  validateSignedRequestEnvelope: jest.fn((request, store) => {
    if (!request?.signature) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Missing signature' };
    }
    if (!request.nonce || store.has(request.nonce)) {
      return { ok: false, code: 'INVALID_NONCE', message: 'Invalid nonce' };
    }
    return { ok: true };
  }),
  consumeSignedRequestEnvelope: jest.fn(async (request, store, now) => {
    if (store.has(request.nonce)) return {ok:false,code:'INVALID_NONCE',message:'Nonce already used'};
    store.set(request.nonce, now);
    return {ok:true};
  })
}));
jest.mock('../services/callAdmissionService', () => ({
  verifyExternalAdmission: jest.fn()
}));
jest.mock('../utils/crypto', () => ({
  verifySignature: jest.fn(),
  verifySignedRequest: jest.fn()
}));
jest.mock('../../../shared/identityId', () => ({
  deriveIdentityIdFromPublicKey: jest.fn()
}));

import type { WebSocket } from 'ws';
import { query } from '../db';
import { callSessionRepository, identityRepository } from '../db/repositories';
import { verifyExternalAdmission } from '../services/callAdmissionService';
import { verifySignature, verifySignedRequest } from '../utils/crypto';
import { deriveIdentityIdFromPublicKey } from '../../../shared/identityId';
import {
  WsRegistrationHandlers,
  type WsRegistrationHandlerDependencies
} from './wsRegistrationHandlers';

const ws = {} as WebSocket;

function harness(overrides: Partial<WsRegistrationHandlerDependencies> = {}) {
  const logger = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn()
  };
  const callSessionRouting = {
    get: jest.fn(),
    bindInitiatorRuntime: jest.fn(),
    bindTargetRuntime: jest.fn()
  };
  const dependencies: WsRegistrationHandlerDependencies = {
    getSocketFamilyId: jest.fn(() => 'family-1'),
    getSocketCircleId: jest.fn(() => 'circle-1'),
    registerConnection: jest.fn(),
    sendMessage: jest.fn(),
    sendError: jest.fn(),
    touchConnectionLastSeen: jest.fn(async () => undefined),
    isTemporaryCallTargetAllowed: jest.fn(async () => true),
    resolvePublishedIdentityName: jest.fn(async () => undefined),
    replayStoredIceCandidates: jest.fn(),
    callSessionRouting,
    describeSocket: jest.fn(() => ({ actorType: 'local' })),
    logCallDiag: jest.fn(),
    validateDirectFileRuntimeRegistration: jest.fn(() => true),
    logger: logger as any,
    now: () => 1_000,
    ...overrides
  };
  return {
    callSessionRouting,
    dependencies,
    logger,
    handlers: new WsRegistrationHandlers(dependencies)
  };
}

const localSignedRequest = {
  type: 'ws:register',
  signerId: 'device-1',
  vpsId: 'vps-test',
  circleId: 'circle-1',
  signature: 'signature',
  timestamp: 1_000,
  nonce: 'nonce-local',
  payload: { clientRuntime: 'web' }
} as any;

describe('WebSocket registration handlers', () => {
  beforeEach(() => {
    process.env.VPS_ID = 'vps-test';
    jest.clearAllMocks();
  });

  it('rejects signed operations intended for HTTP or another WebSocket mode before looking up actors', async () => {
    const { handlers, dependencies } = harness();
    const wrong = { ...localSignedRequest, type: 'devices:list' };
    await handlers.handleLocal(ws, wrong);
    await handlers.handleExternal(ws, wrong);
    await handlers.handleCallRuntime(ws, { signedRequest: wrong } as any);
    await handlers.handleDirectFileRuntime(ws, { signedRequest: wrong } as any);
    expect(dependencies.sendError).toHaveBeenCalledTimes(4);
    expect(markWebSocketRegistered).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(verifySignedRequest).not.toHaveBeenCalled();
    expect(dependencies.registerConnection).not.toHaveBeenCalled();
  });

  it('preserves the local registration state and response envelope', async () => {
    (query as jest.Mock)
      .mockResolvedValueOnce({
        rows: [{
          device_id: 'device-1',
          identity_id: 'identity-1',
          family_id: 'family-1',
          status: 'active',
          public_key_algorithm: 'ed25519',
          public_key_value: 'device-public-key'
        }]
      })
      .mockResolvedValueOnce({ rows: [] });
    (verifySignedRequest as jest.Mock).mockReturnValue(true);
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ status: 'active' });
    const { handlers, dependencies, logger } = harness();

    await handlers.handleLocal(ws, localSignedRequest);

    expect(markWebSocketRegistered).toHaveBeenCalledWith(ws);
    expect(dependencies.registerConnection).toHaveBeenCalledWith(
      ws,
      {
        actorType: 'local',
        identityId: 'identity-1',
        deviceId: 'device-1',
        familyId: 'family-1',
        isTemporaryDevice: false,
        runtimeMode: 'default',
        clientRuntime: 'web'
      },
      { trackDevice: true }
    );
    expect(dependencies.touchConnectionLastSeen).toHaveBeenCalledWith(ws, true);
    expect(dependencies.sendMessage).toHaveBeenCalledWith(ws, {
      type: 'registered',
      data: { identityId: 'identity-1', deviceId: 'device-1' },
      timestamp: 1_000
    });
    expect(logger.info).toHaveBeenCalledWith(
      'ws_registration_completed',
      expect.objectContaining({
        familyId: 'family-1',
        identityId: 'identity-1',
        deviceId: 'device-1'
      })
    );
  });

  it('rejects a tenant mismatch before registering the connection', async () => {
    (query as jest.Mock).mockResolvedValue({
      rows: [{
        device_id: 'device-1',
        identity_id: 'identity-1',
        family_id: 'family-1',
        status: 'active',
        public_key_algorithm: 'ed25519',
        public_key_value: 'device-public-key'
      }]
    });
    (verifySignedRequest as jest.Mock).mockReturnValue(true);
    const { handlers, dependencies } = harness({
      getSocketFamilyId: () => 'family-2'
    });

    await handlers.handleLocal(ws, { ...localSignedRequest, nonce: 'nonce-tenant' });

    expect(dependencies.sendError).toHaveBeenCalledWith(ws, 'FORBIDDEN', 'Tenant mismatch');
    expect(dependencies.registerConnection).not.toHaveBeenCalled();
  });

  it('binds an authenticated native caller runtime to the existing route', async () => {
    (query as jest.Mock).mockResolvedValue({
      rows: [{
        device_id: 'device-1',
        identity_id: 'identity-1',
        family_id: 'family-1',
        status: 'active',
        public_key_algorithm: 'ed25519',
        public_key_value: 'device-public-key'
      }]
    });
    (verifySignedRequest as jest.Mock).mockReturnValue(true);
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ status: 'active' });
    (callSessionRepository.findByCallSessionId as jest.Mock).mockResolvedValue({
      initiator: 'identity-1',
      participants: ['identity-1', 'identity-2']
    });
    const { handlers, dependencies, callSessionRouting } = harness();
    callSessionRouting.get.mockReturnValue({ targetIdentityId: 'identity-2' });

    await handlers.handleCallRuntime(ws, {
      signedRequest: {
        type: 'call:runtime-register',
        signerId: 'device-1',
        vpsId: 'vps-test',
        circleId: 'circle-1',
        signature: 'signature',
        timestamp: 1_000,
        nonce: 'nonce-runtime',
        payload: {
          callSessionId: 'call-1',
          remoteIdentityId: 'identity-2',
          role: 'caller',
          mode: 'video-native'
        }
      }
    } as any);

    expect(markWebSocketRegistered).toHaveBeenCalledWith(ws);
    expect(callSessionRouting.bindInitiatorRuntime).toHaveBeenCalledWith({
      callSessionId: 'call-1',
      identityId: 'identity-1',
      ws,
      deviceId: 'device-1'
    });
    expect(dependencies.sendMessage).toHaveBeenCalledWith(ws, {
      type: 'registered',
      data: {
        identityId: 'identity-1',
        deviceId: 'device-1',
        callSessionId: 'call-1',
        runtimeMode: 'video-native'
      },
      timestamp: 1_000
    });
  });

  it('registers an admitted external identity without device routing', async () => {
    (deriveIdentityIdFromPublicKey as jest.Mock).mockResolvedValue('EXTERNAL-ID');
    (verifySignedRequest as jest.Mock).mockReturnValue(true);
    (verifyExternalAdmission as jest.Mock).mockResolvedValue({ ok: true });
    const { handlers, dependencies } = harness({ getSocketFamilyId: () => 'family-1' });

    await handlers.handleExternal(ws, {
      type: 'ws:register-external',
      signerId: 'EXTERNAL-ID',
      vpsId: 'vps-test',
      circleId: 'circle-1',
      signature: 'signature',
      timestamp: 1_000,
      nonce: 'nonce-external',
      payload: {
        externalIdentityId: 'EXTERNAL-ID',
        externalPublicKey: { algorithm: 'ed25519', value: 'external-public-key' },
        displayName: ' Guest ',
        admission: {
          kind: 'whitelist_key',
          targetIdentityId: 'identity-1'
        }
      }
    });

    expect(markWebSocketRegistered).toHaveBeenCalledWith(ws);
    expect(dependencies.registerConnection).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({
        actorType: 'external',
        identityId: 'EXTERNAL-ID',
        deviceId: 'ext:EXTERNAL-ID',
        familyId: 'family-1',
        externalDisplayName: 'Guest'
      })
    );
    expect(dependencies.sendMessage).toHaveBeenCalledWith(ws, {
      type: 'registered',
      data: {
        identityId: 'EXTERNAL-ID',
        deviceId: 'ext:EXTERNAL-ID',
        actorType: 'external'
      },
      timestamp: 1_000
    });
  });

  it('registers a delegated native direct-file runtime with a session scope', async () => {
    (query as jest.Mock).mockResolvedValue({
      rows: [{
        device_id: 'device-1',
        identity_id: 'identity-1',
        family_id: 'family-1',
        status: 'active',
        public_key_algorithm: 'ed25519',
        public_key_value: 'device-public-key'
      }]
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      status: 'active',
      public_key_algorithm: 'ed25519',
      public_key_value: 'identity-public-key'
    });
    (verifySignature as jest.Mock).mockReturnValue(true);
    (verifySignedRequest as jest.Mock).mockReturnValue(true);
    const { handlers, dependencies } = harness();
    const delegationPayload = JSON.stringify({
      type: 'circlus.file-transfer-key.delegation.v1',
      identityId: 'identity-1',
      identityPublicKey: 'identity-public-key',
      deviceId: 'device-1',
      transferSigningPublicKey: 'transfer-public-key',
      capabilities: ['file-transfer.send', 'file-transfer.receive'],
      notBefore: 0,
      expiresAt: 2,
      createdAt: 0,
      keyId: 'transfer-key-1'
    });

    await handlers.handleDirectFileRuntime(ws, {
      signedRequest: {
        type: 'file-transfer:runtime-register',
        signerId: 'transfer-public-key',
        vpsId: 'vps-test',
        circleId: 'circle-1',
        signature: 'runtime-signature',
        timestamp: 1_000,
        nonce: 'nonce-file-runtime',
        payload: {
          sessionId: 'transfer-1',
          identityId: 'identity-1',
          remoteIdentityId: 'identity-2',
          deviceId: 'device-1',
          role: 'sender',
          mode: 'direct-file-native',
          fileTransferKeyDelegation: {
            payload: delegationPayload,
            signature: 'delegation-signature'
          }
        }
      }
    } as any);

    expect(dependencies.validateDirectFileRuntimeRegistration).toHaveBeenCalledWith({
      familyId: 'family-1',
      identityId: 'identity-1',
      deviceId: 'device-1',
      sessionId: 'transfer-1',
      remoteIdentityId: 'identity-2',
      role: 'sender'
    });
    expect(markWebSocketRegistered).toHaveBeenCalledWith(ws);
    expect(dependencies.registerConnection).toHaveBeenCalledWith(
      ws,
      {
        actorType: 'local',
        identityId: 'identity-1',
        deviceId: 'device-1',
        familyId: 'family-1',
        runtimeMode: 'direct-file-native',
        scopedDirectFileTransferSessionId: 'transfer-1',
        scopedRemoteIdentityId: 'identity-2',
        directFileTransferRole: 'sender'
      },
      { trackDevice: true }
    );
    expect(dependencies.sendMessage).toHaveBeenCalledWith(ws, {
      type: 'registered',
      data: {
        identityId: 'identity-1',
        deviceId: 'device-1',
        directFileTransferSessionId: 'transfer-1',
        runtimeMode: 'direct-file-native',
        role: 'sender'
      },
      timestamp: 1_000
    });
  });
});
