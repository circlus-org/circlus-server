jest.mock('../services/reliableOperation', () => ({ reliableOperation: (handler: unknown) => handler }));
import { callLinkRepository, identityRepository } from '../db/repositories';
import { configService } from '../services/configService';

jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireFullCircleIdentity: jest.fn((_req, _res, next) => next()),
  getRequestAuthorization: jest.fn((req) => ({
    createGuestInvites: req.identity?.role === 'owner' || req.identity?.canCreateGuestInvites === true
  })),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {})
}));

jest.mock('../db/repositories', () => ({
  callLinkRepository: {
    createWithOptionalInvite: jest.fn(),
    findOwned: jest.fn(),
    revokeOwned: jest.fn(),
    findById: jest.fn(),
    setCapabilityRevocation: jest.fn()
  },
  identityRepository: {
    findByIdentityId: jest.fn().mockResolvedValue({
      public_key_algorithm: 'ed25519',
      public_key_value: 'issuer_key'
    })
  }
}));

jest.mock('../config/serverRuntimeConfig', () => ({
  ...jest.requireActual('../config/serverRuntimeConfig'),
  getFeaturePolicyRuntimeConfig: jest.fn(() => ({ callLinks: { ttlHours: 72 } }))
}));

jest.mock('../services/configService', () => ({
  configService: { getFamilyConfig: jest.fn() }
}));

jest.mock('../services/callAdmissionService', () => ({ verifyCallLinkGrant: jest.fn() }));
jest.mock('../services/linkCapabilityService', () => ({
  verifyCapabilityDescriptor: jest.fn().mockResolvedValue(true),
  verifyCapabilityProof: jest.fn().mockReturnValue(true),
  verifyCapabilityRevocation: jest.fn().mockReturnValue(true)
}));

const callLinksRouter = require('./callLinks').default;

type MockResponse = { status: jest.Mock; json: jest.Mock };

function getPostHandler(path: string) {
  const layer = (callLinksRouter as any).stack.find((item: any) => item.route?.path === path);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function response(): MockResponse {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function authRequest(payload: Record<string, unknown> = {}) {
  return {
    familyId: 'family_1',
    identity: { role: 'member', canCreateGuestInvites: true },
    device: { identityId: 'identity_1' },
    signedRequest: { payload },
    params: {}
  };
}

describe('call link management', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creates a named link with a caller-selected TTL and aligned invite expiry', async () => {
    (callLinkRepository.createWithOptionalInvite as jest.Mock).mockResolvedValue({
      ok: true,
      suggestJoinAfterCall: true,
      showCircleName: true,
      joinInviteId: 'invite_1'
    });
    const res = response();
    const startedAt = Date.now();
    const expiresAt = new Date(startedAt + 24 * 60 * 60 * 1000).toISOString();

    await getPostHandler('/create')(authRequest({
      privateMetadataCiphertext: { cipher: 'aes-256-gcm', data: 'private-metadata', nonce: 'private-nonce', version: 1 },
      ttlHours: 24,
      expiresAt,
      suggestJoinAfterCall: true,
      showCircleName: true,
      mode: 'unlimited',
      encryptedSecret: { cipher: 'aes-256-gcm', data: 'data', nonce: 'nonce', version: 1 },
      capabilityDescriptor: {
        type: 'link-capability:descriptor',
        signerId: 'identity_1',
        timestamp: startedAt,
        nonce: 'nonce',
        signature: 'signature',
        payload: {
          version: 2,
          purpose: 'circlus-link-capability-v2',
          capabilityId: 'cap_test',
          kind: 'call-link',
          mode: 'unlimited',
          issuerIdentityId: 'identity_1',
          targetIdentityId: 'identity_1',
          capabilityPublicKey: { algorithm: 'ed25519', value: 'capability_key' },
          issuedAt: new Date(startedAt).toISOString(),
          expiresAt,
          scope: {
            privateMetadataCiphertext: { cipher: 'aes-256-gcm', data: 'private-metadata', nonce: 'private-nonce', version: 1 },
            suggestJoinAfterCall: true,
            joinMode: 'single-use',
            showCircleName: true
          }
        }
      }
    }), res);

    const params = (callLinkRepository.createWithOptionalInvite as jest.Mock).mock.calls[0][0];
    expect(params.title).toBeNull();
    expect(params.expiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + 24 * 60 * 60 * 1000);
    expect(params.joinInviteExpiresAt).toBe(params.expiresAt);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({ title: null, joinInviteId: 'invite_1' })
    }));
  });

  test('creates a linked single-use direct guest invitation with the call link', async () => {
    (callLinkRepository.createWithOptionalInvite as jest.Mock).mockResolvedValue({
      ok: true,
      suggestJoinAfterCall: false,
      joinInviteId: null,
      directGuestLinkId: 'dgl_linked'
    });
    const startedAt = Date.now();
    const expiresAt = new Date(startedAt + 24 * 60 * 60 * 1000).toISOString();
    const capabilityPayload = {
      version: 2,
      purpose: 'circlus-link-capability-v2',
      capabilityId: 'cap_test',
      issuerIdentityId: 'identity_1',
      targetIdentityId: 'identity_1',
      capabilityPublicKey: { algorithm: 'ed25519', value: 'capability_key' },
      issuedAt: new Date(startedAt).toISOString(),
      expiresAt
    };
    const permissions = {
      canMessage: true, canCall: true, canDirectFileTransfer: false, canServerAttachments: false,
      hostCanMessageGuest: true, guestCanMessageHost: true,
      hostCanCallGuest: true, guestCanCallHost: true,
      hostCanDirectFileTransferGuest: false, guestCanDirectFileTransferHost: false,
      hostCanServerAttachmentsGuest: false, guestCanServerAttachmentsHost: false,
      autoSubscribeToChannel: false
    };
    const callDescriptor = {
      type: 'link-capability:descriptor', signerId: 'identity_1', timestamp: startedAt,
      nonce: 'call', signature: 'signature',
      payload: {
        ...capabilityPayload,
        kind: 'call-link', mode: 'unlimited',
        scope: {
          privateMetadataCiphertext: { cipher: 'aes-256-gcm', data: 'private-metadata', nonce: 'private-nonce', version: 1 }, suggestJoinAfterCall: false, joinMode: null,
          showCircleName: true, attachedInvitationKind: 'direct_guest'
        }
      }
    };
    const guestDescriptor = {
      type: 'link-capability:descriptor', signerId: 'identity_1', timestamp: startedAt,
      nonce: 'guest', signature: 'signature',
      payload: {
        ...capabilityPayload,
        kind: 'direct-guest', mode: 'single-use',
        scope: {
          privateMetadataCiphertext: { cipher: 'aes-256-gcm', data: 'private-metadata', nonce: 'private-nonce', version: 1 }, permissions, channelId: null,
          hostIdentityNameCiphertext: { cipher: 'aes-256-gcm', data: 'host-name-data', nonce: 'host-name-nonce', version: 1 }
        }
      }
    };
    const res = response();

    await getPostHandler('/create')(authRequest({
      privateMetadataCiphertext: { cipher: 'aes-256-gcm', data: 'private-metadata', nonce: 'private-nonce', version: 1 }, ttlHours: 24, expiresAt,
      suggestJoinAfterCall: false, showCircleName: true, mode: 'unlimited',
      attachedInvitationKind: 'direct_guest',
      capabilityDescriptor: callDescriptor,
      directGuestCapabilityDescriptor: guestDescriptor,
      directGuestHostNameCiphertext: { cipher: 'aes-256-gcm', data: 'host-name-data', nonce: 'host-name-nonce', version: 1 },
      encryptedSecret: { cipher: 'aes-256-gcm', data: 'data', nonce: 'nonce', version: 1 }
    }), res);

    expect(callLinkRepository.createWithOptionalInvite).toHaveBeenCalledWith(expect.objectContaining({
      suggestJoinAfterCall: false,
      directGuestInvitation: expect.objectContaining({ capabilityDescriptor: guestDescriptor })
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok', result: expect.objectContaining({ directGuestLinkId: 'dgl_linked' })
    }));
  });

  test('rejects an empty title and an out-of-range TTL', async () => {
    const emptyTitle = response();
    await getPostHandler('/create')(authRequest({ title: ' ', ttlHours: 24 }), emptyTitle);
    expect(emptyTitle.status).toHaveBeenCalledWith(400);

    const invalidTtl = response();
    await getPostHandler('/create')(authRequest({ title: 'Link', ttlHours: 0 }), invalidTtl);
    expect(invalidTtl.status).toHaveBeenCalledWith(400);
    expect(callLinkRepository.createWithOptionalInvite).not.toHaveBeenCalled();
  });

  test('lists links created by the authenticated identity', async () => {
    (callLinkRepository.findOwned as jest.Mock).mockResolvedValue([]);
    const res = response();

    await getPostHandler('/mine')(authRequest(), res);

    expect(callLinkRepository.findOwned).toHaveBeenCalledWith('family_1', 'identity_1');
    expect(res.json).toHaveBeenCalledWith({ status: 'ok', result: { links: [] } });
  });

  test.each([-1, 0])('rejects a still-active link that expired %i ms ago when resolving', async (offset) => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      (callLinkRepository.findById as jest.Mock).mockResolvedValue({
        status: 'active', expires_at: new Date(10_000 + offset)
      });
      const res = response();
      await getPostHandler('/resolve')({
        familyId: 'family_1', body: { linkId: 'cl_1', capabilityId: 'cap_1', proof: {} }
      }, res);
      expect(res.status).toHaveBeenCalledWith(404);
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('does not disclose the circle name when the link descriptor hides it', async () => {
    const descriptor = {
      payload: {
        scope: { title: 'Private call', showCircleName: false }
      }
    };
    (callLinkRepository.findById as jest.Mock).mockResolvedValue({
      status: 'active',
      expires_at: new Date(Date.now() + 60_000),
      capability_id: 'cap_private',
      capability_descriptor: descriptor,
      title: 'Private call',
      target_identity_id: 'identity_1',
      suggest_join_after_call: false,
      join_invite_token: null
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce({
      status: 'active',
      identity_id: 'identity_1',
      public_key_algorithm: 'ed25519',
      public_key_value: 'issuer_key'
    });
    (configService.getFamilyConfig as jest.Mock).mockResolvedValue({ server_name: 'Secret Circle' });
    const res = response();

    await getPostHandler('/resolve')({
      familyId: 'family_1',
      body: { linkId: 'cl_private', capabilityId: 'cap_private', proof: { signature: 'proof' } }
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({ title: null, serverName: null })
    }));
  });

  test('resolves an active linked guest invitation for the call screen', async () => {
    const callDescriptor = { payload: { scope: { title: 'Guest call' } } };
    const guestDescriptor = { payload: { kind: 'direct-guest', capabilityId: 'cap_guest' } };
    (callLinkRepository.findById as jest.Mock).mockResolvedValue({
      status: 'active',
      expires_at: new Date(Date.now() + 60_000),
      capability_id: 'cap_guest',
      capability_descriptor: callDescriptor,
      title: 'Guest call',
      target_identity_id: 'identity_1',
      suggest_join_after_call: false,
      join_invite_token: null,
      direct_guest_link_id: 'dgl_guest',
      direct_guest_link_status: 'active',
      direct_guest_capability_descriptor: guestDescriptor
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce({
      status: 'active', identity_id: 'identity_1',
      public_key_algorithm: 'ed25519', public_key_value: 'issuer_key'
    });
    (configService.getFamilyConfig as jest.Mock).mockResolvedValue({ server_name: 'Circle' });
    const res = response();

    await getPostHandler('/resolve')({
      familyId: 'family_1',
      body: { linkId: 'cl_guest', capabilityId: 'cap_guest', proof: { signature: 'proof' } }
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        attachedInvitation: {
          kind: 'direct_guest',
          linkId: 'dgl_guest',
          capabilityDescriptor: guestDescriptor
        }
      })
    }));
  });

  test('revokes an owned link and returns restored invite quota', async () => {
    const now = new Date();
    (callLinkRepository.revokeOwned as jest.Mock).mockResolvedValue({
      ok: true,
      remaining: 3,
      row: {
        call_link_id: 'cl_1', title: 'Link', status: 'revoked', created_at: now,
        expires_at: now, last_used_at: null, revoked_at: now,
        suggest_join_after_call: true, join_invite_id: 'invite_1',
        join_invite_title: 'Link', join_invite_status: 'revoked', join_invite_expires_at: now
      }
    });
    const req = authRequest();
    req.params = { callLinkId: 'cl_1' };
    req.signedRequest.payload = { revocation: { type: 'link-capability:revoke' } };
    (callLinkRepository.findById as jest.Mock).mockResolvedValue({
      call_link_id: 'cl_1',
      capability_id: 'cap_123456789012345678901234'
    });
    const res = response();

    await getPostHandler('/:callLinkId/revoke')(req, res);

    expect(callLinkRepository.revokeOwned).toHaveBeenCalledWith({
      familyId: 'family_1', identityId: 'identity_1', callLinkId: 'cl_1', unlimitedInvites: false
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok', result: expect.objectContaining({ remaining: 3 })
    }));
  });
});
