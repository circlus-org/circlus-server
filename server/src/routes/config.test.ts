jest.mock('../services/durableNonce', () => { const used = new Set<string>(); return { claimDurableNonce: jest.fn(async (signer: string, nonce: string) => {const key = signer+':'+nonce;if (used.has(key)) return false;used.add(key);return true;}) }; });
jest.mock('../db/repositories', () => ({
  deviceRepository: { findByDeviceId: jest.fn() },
  familyDomainRepository: { findActiveByHost: jest.fn() },
  identityRepository: {
    findByRole: jest.fn(),
    findByIdentityId: jest.fn(),
  },
  circleSiteSettingsRepository: { findByFamilyId: jest.fn() },
}));

jest.mock('../services/configService', () => ({
  configService: {
    getResolvedFamilyConfig: jest.fn().mockResolvedValue({
      config: { public_base_url: 'https://family.example.com', circle_id: 'circle_test_1234567890' },
      serverName: 'Internal Circle',
      noNamesOnServer: false,
      attachmentsEnabled: true,
      messageTtlHours: 720,
      maxAttachmentFileSizeBytes: null,
      attachmentStorageQuotaBytes: null,
      attachmentRetentionSeconds: null,
      membersCanUseGuestServerAttachments: true,
    }),
  },
}));

jest.mock('../services/iceServersService', () => ({
  iceServersService: {
    getIceServers: jest.fn(),
    getTurnServerConfig: jest.fn(),
  },
}));

jest.mock('../services/circleMediaRoutingService', () => ({
  circleMediaRoutingService: {
    getRequestedTurnClusterId: jest.fn(),
  },
}));

jest.mock('../services/callAdmissionService', () => ({
  verifyCallLinkActionGrant: jest.fn(),
}));

import { deviceRepository, familyDomainRepository, identityRepository, circleSiteSettingsRepository } from '../db/repositories';
import { iceServersService } from '../services/iceServersService';
import { circleMediaRoutingService } from '../services/circleMediaRoutingService';
import { verifyCallLinkActionGrant } from '../services/callAdmissionService';
import nacl from 'tweetnacl';
import { createSignatureMessage } from '../../../shared/signatureMessage';

const configRouter = require('./config').default;
const originalVpsId = process.env.VPS_ID;

beforeAll(() => {
  process.env.VPS_ID = 'test-vps';
});

afterAll(() => {
  if (originalVpsId === undefined) delete process.env.VPS_ID;
  else process.env.VPS_ID = originalVpsId;
});

function getHandler(path: string) {
  const layer = (configRouter as any).stack.find((item: any) => item.route?.path === path);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any) => Promise<void>;
}

function makeResponse() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('GET /capabilities: public circle site eligibility', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reports eligible=true and enabled state for a normal domain', async () => {
    (familyDomainRepository.findActiveByHost as jest.Mock).mockResolvedValue({ role: 'primary', status: 'active' });
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });

    const res = makeResponse();
    await getHandler('/capabilities')({ familyId: 'family-1', headers: { host: 'family.example.com' } }, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          apiLevel: 2,
          enabled: { platformRecoveryV1: false },
          canonical: expect.objectContaining({ publicSiteEligible: true, publicSiteEnabled: true }),
        }),
      })
    );
  });

  test('reports eligible=false for a Circlus-managed subdomain, regardless of settings', async () => {
    (familyDomainRepository.findActiveByHost as jest.Mock).mockResolvedValue({ role: 'primary', status: 'active' });
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });

    const res = makeResponse();
    await getHandler('/capabilities')({ familyId: 'family-1', headers: { host: 'family.space.circlus.org' } }, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          canonical: expect.objectContaining({ publicSiteEligible: false }),
        }),
      })
    );
  });

  test('defaults publicSiteEnabled to false when no settings row exists', async () => {
    (familyDomainRepository.findActiveByHost as jest.Mock).mockResolvedValue(null);
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue(null);

    const res = makeResponse();
    await getHandler('/capabilities')({ familyId: 'family-1', headers: { host: 'family.example.com' } }, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          canonical: expect.objectContaining({ publicSiteEligible: true, publicSiteEnabled: false }),
        }),
      })
    );
  });
});

describe('POST /server-name: role-scoped Circle metadata', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does not disclose internal Circle metadata to a guest', async () => {
    const res = makeResponse();
    await getHandler('/server-name')({
      familyId: 'family-1',
      identity: { identityId: 'guest-1', role: 'guest' },
    }, res);

    expect(identityRepository.findByRole).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        serverName: null,
        noNamesOnServer: null,
        ownerIdentityId: null,
        ownerIdentityName: null,
        circleId: 'circle_test_1234567890',
      }),
    }));
  });

  test('keeps Circle metadata available to a member', async () => {
    (identityRepository.findByRole as jest.Mock).mockResolvedValueOnce([{
      identity_id: 'owner-1',
      identity_name: 'Owner',
    }]);
    const res = makeResponse();
    await getHandler('/server-name')({
      familyId: 'family-1',
      identity: { identityId: 'member-1', role: 'member' },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        serverName: 'Internal Circle',
        noNamesOnServer: false,
        ownerIdentityId: 'owner-1',
        ownerIdentityName: null,
        circleId: 'circle_test_1234567890',
      }),
    }));
  });
});

describe('GET /ice-servers: Circle media routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (circleMediaRoutingService.getRequestedTurnClusterId as jest.Mock).mockResolvedValue('external-eu');
    (iceServersService.getIceServers as jest.Mock).mockResolvedValue([
      { urls: 'turn:eu.example.test:3478' },
    ]);
  });

  test('passes a fixed Circle cluster to the ICE bootstrap request', async () => {
    const res = makeResponse();
    await getHandler('/ice-servers')({ familyId: 'family-1' }, res);

    expect(iceServersService.getIceServers).toHaveBeenCalledWith({
      familyId: 'family-1',
      requestedTurnClusterId: 'external-eu',
    });
  });
});

describe('POST /turn-credentials: call-scoped TURN identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (circleMediaRoutingService.getRequestedTurnClusterId as jest.Mock).mockResolvedValue(undefined);
  });

  test('requires a valid signed callSessionId', async () => {
    const res = makeResponse();
    await getHandler('/turn-credentials')({
      familyId: 'family-1',
      signedRequest: { payload: { callSessionId: 'invalid call id' } },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(iceServersService.getTurnServerConfig).not.toHaveBeenCalled();
  });

  test('passes the callSessionId to ICE and returns accounting metadata', async () => {
    (iceServersService.getTurnServerConfig as jest.Mock).mockResolvedValue({
      urls: ['turn:local.example.test:3478'],
      username: 'temporary-user',
      credential: 'temporary-password',
      mediaSessionId: 'ms1_abcdefghijklmnopqrstuv',
      turnClusterId: 'local',
    });
    const res = makeResponse();
    await getHandler('/turn-credentials')({
      familyId: 'family-1',
      signedRequest: { payload: { callSessionId: 'call_temp_123' } },
    }, res);

    expect(iceServersService.getTurnServerConfig).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call_temp_123',
      requestedTurnClusterId: undefined,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        mediaSessionId: 'ms1_abcdefghijklmnopqrstuv',
        turnClusterId: 'local',
      }),
    }));
  });

  test('passes the fixed Circle TURN cluster to ICE', async () => {
    (circleMediaRoutingService.getRequestedTurnClusterId as jest.Mock).mockResolvedValue('external-eu');
    (iceServersService.getTurnServerConfig as jest.Mock).mockResolvedValue(null);
    const res = makeResponse();
    await getHandler('/turn-credentials')({
      familyId: 'family-1',
      signedRequest: { payload: { callSessionId: 'call_temp_456' } },
    }, res);

    expect(iceServersService.getTurnServerConfig).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call_temp_456',
      requestedTurnClusterId: 'external-eu',
    });
  });
});

describe('POST /direct-file-turn-credentials: delegated transfer identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (circleMediaRoutingService.getRequestedTurnClusterId as jest.Mock).mockResolvedValue(undefined);
  });

  test('verifies the identity delegation and fresh transfer-key request', async () => {
    const identityKeys = nacl.sign.keyPair();
    const transferKeys = nacl.sign.keyPair();
    const identityPublicKey = Buffer.from(identityKeys.publicKey).toString('base64');
    const transferPublicKey = Buffer.from(transferKeys.publicKey).toString('base64');
    const claims = JSON.stringify({
      type: 'circlus.file-transfer-key.delegation.v1',
      identityId: 'identity-1',
      identityPublicKey,
      deviceId: 'device-1',
      transferSigningPublicKey: transferPublicKey,
      capabilities: ['file-transfer.send', 'file-transfer.receive'],
      notBefore: Math.floor(Date.now() / 1000) - 60,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const delegationSignature = Buffer.from(
      nacl.sign.detached(Buffer.from(claims), identityKeys.secretKey)
    ).toString('base64');
    const unsigned = {
      type: 'file-transfer:turn-credentials',
      timestamp: Date.now(),
      nonce: Buffer.from(nacl.randomBytes(32)).toString('base64'),
      signerId: transferPublicKey,
      payload: {
        sessionId: 'dft_test_1',
        identityId: 'identity-1',
        deviceId: 'device-1',
        remoteIdentityId: 'identity-2',
        role: 'sender',
        fileTransferKeyDelegation: { payload: claims, signature: delegationSignature },
      },
    };
    const signedRequest = {
      ...unsigned,
      signature: Buffer.from(nacl.sign.detached(
        Buffer.from(createSignatureMessage(unsigned as any)),
        transferKeys.secretKey
      )).toString('base64'),
    };
    (deviceRepository.findByDeviceId as jest.Mock).mockResolvedValue({
      device_id: 'device-1', identity_id: 'identity-1', status: 'active'
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      identity_id: 'identity-1', status: 'active', public_key_value: identityPublicKey
    });
    (iceServersService.getTurnServerConfig as jest.Mock).mockResolvedValue({
      urls: ['turn:relay.example.test:3478'], username: 'user', credential: 'secret'
    });

    const res = makeResponse();
    await getHandler('/direct-file-turn-credentials')({
      familyId: 'family-1', body: signedRequest
    }, res);

    expect(iceServersService.getTurnServerConfig).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'dft_test_1',
      requestedTurnClusterId: undefined,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok', result: expect.objectContaining({ username: 'user' })
    }));
  });
});

describe('POST /turn-credentials/call-link: capability-scoped TURN identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (circleMediaRoutingService.getRequestedTurnClusterId as jest.Mock).mockResolvedValue(undefined);
  });

  const validPayload = {
    callSessionId: 'call_temp_789',
    callLinkId: 'link-1',
    targetIdentityId: 'target-1',
    subjectIdentityId: 'guest-1',
    subjectPublicKey: { algorithm: 'ed25519', value: 'guest-public-key' },
    capabilityId: 'cap_1',
    capabilityProof: {
      type: 'link-capability:proof',
      signerId: 'cap_1',
      payload: {
        version: 2,
        purpose: 'circlus-link-capability-proof-v2',
        capabilityId: 'cap_1',
        action: 'call-link:call',
        targetIdentityId: 'target-1',
        subjectIdentityId: 'guest-1',
        subjectPublicKey: { algorithm: 'ed25519', value: 'guest-public-key' },
        context: { callSessionId: 'call_temp_789' },
      },
      timestamp: Date.now(),
      signature: 'sig',
    },
  };

  test('denies TURN credentials when the call-link proof is not accepted', async () => {
    (verifyCallLinkActionGrant as jest.Mock).mockResolvedValue({ ok: false, reason: 'invalid_secret' });
    const res = makeResponse();

    await getHandler('/turn-credentials/call-link')({
      familyId: 'family-1',
      body: validPayload,
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(iceServersService.getTurnServerConfig).not.toHaveBeenCalled();
  });

  test('returns TURN credentials for a fresh proof bound to the requested call', async () => {
    (verifyCallLinkActionGrant as jest.Mock).mockResolvedValue({ ok: true });
    (iceServersService.getTurnServerConfig as jest.Mock).mockResolvedValue({
      urls: ['turn:link.example.test:3478'],
      username: 'link-user',
      credential: 'link-password',
    });
    const res = makeResponse();

    await getHandler('/turn-credentials/call-link')({
      familyId: 'family-1',
      body: validPayload,
    }, res);

    expect(verifyCallLinkActionGrant).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family-1',
      callLinkId: 'link-1',
      capabilityId: 'cap_1',
      externalIdentityId: 'guest-1',
      targetIdentityId: 'target-1',
      expectedAction: 'call-link:call',
      touchUsage: false,
    }));
    expect(iceServersService.getTurnServerConfig).toHaveBeenCalledWith({
      familyId: 'family-1',
      callSessionId: 'call_temp_789',
      requestedTurnClusterId: undefined,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        username: 'link-user',
      }),
    }));
  });
});
