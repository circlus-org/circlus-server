jest.mock('../services/configService', () => ({ configService: { getFamilyConfig: jest.fn(async () => ({ public_base_url: 'https://circle.test' })) } }));
jest.mock('../utils/crypto', () => ({ verifySignedRequest: jest.fn(() => true) }));
jest.mock('../ws/wsGateway', () => ({ sendToIdentityWs: jest.fn() }));
jest.mock('../services/reliableOperation', () => ({ reliableOperation: (handler: unknown) => handler }));
import { directGuestLinkRepository } from '../db/repositories';

jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireAdmin: jest.fn((_req, _res, next) => next()),
  getRequestAuthorization: jest.fn((req) => ({
    manageOwnGuestLinks: ['owner', 'member', 'guest'].includes(req.identity?.role),
    createGuestInvites: req.identity?.role === 'owner' || req.identity?.canCreateGuestInvites === true
  })),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {})
}));

jest.mock('../db', () => ({
  pool: { query: jest.fn() },
  inTransactionContext: jest.fn(async (_client: unknown, callback: () => unknown) => callback()),
  transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback({ query: jest.fn() })),
}));

jest.mock('../services/publicSiteGeneratorService', () => ({
  publicSiteGeneratorService: {
    regenerateSite: jest.fn(),
    generateUniqueSlug: jest.fn(),
  }
}));

jest.mock('../services/attachmentStorageService', () => ({
  attachmentStorageService: {
    buildStorageKey: jest.fn(),
    writeUploadBuffer: jest.fn(),
    readBlob: jest.fn()
  }
}));

jest.mock('../services/linkCapabilityService', () => ({
  verifyCapabilityDescriptor: jest.fn().mockResolvedValue(true),
  verifyCapabilityRevocation: jest.fn().mockReturnValue(true),
}));

jest.mock('../services/directGuestAccessService', () => ({
  mapDirectGuestPermissionsFromDb: jest.fn((row) => ({
    canMessage: !!row.can_message,
    canCall: !!row.can_call,
    canDirectFileTransfer: !!row.can_direct_file_transfer,
    hostCanMessageGuest: !!row.host_can_message_guest,
    guestCanMessageHost: !!row.guest_can_message_host,
    hostCanCallGuest: !!row.host_can_call_guest,
    guestCanCallHost: !!row.guest_can_call_host,
    hostCanDirectFileTransferGuest: !!row.host_can_direct_file_transfer_guest,
    guestCanDirectFileTransferHost: !!row.guest_can_direct_file_transfer_host,
    autoSubscribeToChannel: 'auto_subscribe_to_channel' in row
      ? !!row.auto_subscribe_to_channel
      : false
  })),
  normalizeDirectGuestPermissions: jest.fn().mockReturnValue({
    canMessage: true,
    canCall: true,
    canDirectFileTransfer: false,
    hostCanMessageGuest: true,
    guestCanMessageHost: true,
    hostCanCallGuest: true,
    guestCanCallHost: true,
    hostCanDirectFileTransferGuest: true,
    guestCanDirectFileTransferHost: false,
    autoSubscribeToChannel: false
  })
}));

jest.mock('../db/repositories', () => ({
  systemEventRepository: { createEventId: jest.fn(() => 'event'), insertEvent: jest.fn() },
  attachmentRepository: {
    findBlobById: jest.fn(),
    createAvatarBlob: jest.fn()
  },
  circleFileAccessRepository: {
    grantAccess: jest.fn()
  },
  directGuestLinkRepository: {
    create: jest.fn(),
    findById: jest.fn(),
    listByHostIdentity: jest.fn(),
    getDefaults: jest.fn(),
    setDefaults: jest.fn(),
    deleteRevokedEmpty: jest.fn(),
    revoke: jest.fn(),
    setCapabilityRevocation: jest.fn()
  },
  identityRepository: {
    findByIdentityId: jest.fn().mockResolvedValue({
      identity_id: 'owner_identity',
      public_key_algorithm: 'ed25519',
      public_key_value: 'issuer_key',
    })
  },
  announcementChannelRepository: {
    create: jest.fn(),
    attachLink: jest.fn(),
    findById: jest.fn(),
    findByLink: jest.fn(),
    clearPublicGuestLink: jest.fn(),
    ensureDefaultForLink: jest.fn(),
    ensureHostLinkChannelMappings: jest.fn().mockResolvedValue([]),
    updatePublicSite: jest.fn(),
    listActiveRegistrationsForChannel: jest.fn(),
    listOwnedActiveSubscriptionsForGuest: jest.fn(),
    removeSubscriberByAuthor: jest.fn()
  },
  directGuestRegistrationRepository: {
    revokeAllByLink: jest.fn(),
    listByLink: jest.fn(),
    listByHost: jest.fn(),
    findActiveByHost: jest.fn(),
    findLatestByPair: jest.fn(),
    findActiveByHostForUpdate: jest.fn(),
    revokeByHost: jest.fn(),
    updatePermissionsByHost: jest.fn(),
    selfDelete: jest.fn()
  },
  messageRepository: {
    findMessageById: jest.fn()
  },
  circleSitePublicationRepository: {
    findBySourceBroadcast: jest.fn(),
    findBySourceBroadcastForUpdate: jest.fn(),
    listPublishedSourceBroadcastIds: jest.fn().mockResolvedValue(new Set()),
    create: jest.fn(),
    update: jest.fn(),
    setStatus: jest.fn()
  },
  circleSiteSettingsRepository: {
    findByFamilyId: jest.fn()
  },
  circleSitePublicationAssetRepository: {
    replaceForPublication: jest.fn()
  }
}));

const directGuestLinksRouter = require('./directGuestLinks').default;

type MockResponse = {
  status: jest.Mock;
  json: jest.Mock;
};

function getPostHandler(path: string) {
  const findLayer = (candidate: any): any => {
    for (const item of candidate.stack || []) {
      if (item.route?.path === path) return item;
      const nested = item.handle?.stack ? findLayer(item.handle) : null;
      if (nested) return nested;
    }
    return null;
  };
  const layer = findLayer(directGuestLinksRouter);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function makeResponse(): MockResponse {
  const res = {
    status: jest.fn(),
    json: jest.fn()
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('direct guest link host restrictions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not allow guests to create guest links', async () => {
    const res = makeResponse();

    await getPostHandler('/create')({
      familyId: 'family_1',
      identity: { role: 'guest' },
      device: { identityId: 'guest_identity' },
      signedRequest: {
        payload: {
          canMessage: true,
          canCall: true,
          title: 'Support'
        }
      }
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(directGuestLinkRepository.create).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({
        code: 'FORBIDDEN',
        message: 'Guest invitation permission required'
      })
    }));
  });

  test('loads all registrations owned by the host in one request', async () => {
    const repositories = require('../db/repositories');
    repositories.directGuestRegistrationRepository.listByHost.mockResolvedValue([{
      registration_id: 'reg_1',
      link_id: 'link_1',
      guest_identity_id: 'guest_identity',
      guest_device_id: 'guest_device',
      guest_identity_name: 'Guest',
      guest_public_key_algorithm: 'ed25519',
      guest_public_key_value: 'guest_public_key',
      can_message: true,
      can_call: false,
      can_direct_file_transfer: false,
      status: 'active',
      created_at: new Date('2026-01-01T00:00:00Z'),
      last_seen_at: null,
      revoked_at: null,
    }]);
    const res = makeResponse();

    await getPostHandler('/registrations/mine')({
      familyId: 'family_1',
      identity: { role: 'owner' },
      device: { identityId: 'host_identity' },
    }, res);

    expect(repositories.directGuestRegistrationRepository.listByHost)
      .toHaveBeenCalledWith('family_1', 'host_identity', null);
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      result: [expect.objectContaining({
        registrationId: 'reg_1',
        linkId: 'link_1',
        guestIdentityId: 'guest_identity',
        guestIdentityPublicKey: {
          algorithm: 'ed25519',
          value: 'guest_public_key',
        },
      })],
    });
  });

  test('resolves channel mappings for all guest links in one repository call', async () => {
    const repositories = require('../db/repositories');
    const link = (linkId: string, autoSubscribeToChannel: boolean) => ({
      link_id: linkId,
      auto_subscribe_to_channel: autoSubscribeToChannel,
      encrypted_secret: null,
      status: 'active',
      title: null,
      presentation_title: null,
      presentation_description: null,
      presentation_image_url: null,
      public_site_visible: false,
      public_site_channel_slug: null,
      public_site_cta_label: null,
      public_site_intro_title: null,
      public_site_intro_text: null,
      public_site_intro_image_url: null,
      public_site_guest_link_url: null,
      max_uses: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      revoked_at: null,
      registration_count: '0',
      active_registration_count: '0',
    });
    repositories.directGuestLinkRepository.listByHostIdentity.mockResolvedValue([
      link('link_1', true),
      link('link_2', false),
    ]);
    repositories.announcementChannelRepository.ensureHostLinkChannelMappings.mockResolvedValue([
      { link_id: 'link_1', channel_id: 'channel_1' },
    ]);
    const res = makeResponse();

    await getPostHandler('/mine')({
      familyId: 'family_1',
      identity: { role: 'owner' },
      device: { identityId: 'host_identity' },
    }, res);

    expect(repositories.announcementChannelRepository.ensureHostLinkChannelMappings)
      .toHaveBeenCalledTimes(1);
    expect(repositories.announcementChannelRepository.ensureHostLinkChannelMappings)
      .toHaveBeenCalledWith(expect.objectContaining({
        linkIds: ['link_1', 'link_2'],
        autoSubscribeLinkIds: ['link_1'],
      }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: [
        expect.objectContaining({ linkId: 'link_1', channelId: 'channel_1' }),
        expect.objectContaining({ linkId: 'link_2', channelId: null }),
      ],
    }));
  });

  test.each([undefined, null, 'Anton'])('allows an owner to create a guest link with inviter name %s and no private label', async (hostIdentityName) => {
    const repositories = require('../db/repositories');
    repositories.directGuestLinkRepository.create.mockResolvedValue({
      link_id: 'link_1',
      title: null,
      presentation_title: null,
      presentation_description: null,
      presentation_image_url: null,
      public_site_visible: false,
      public_site_channel_slug: null,
      public_site_cta_label: null,
      public_site_intro_title: null,
      public_site_intro_text: null,
      public_site_intro_image_url: null,
      public_site_guest_link_url: null,
      max_uses: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    });
    const res = makeResponse();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const permissions = {
      canMessage: true,
      canCall: true,
      canDirectFileTransfer: false,
      hostCanMessageGuest: true,
      guestCanMessageHost: true,
      hostCanCallGuest: true,
      guestCanCallHost: true,
      hostCanDirectFileTransferGuest: true,
      guestCanDirectFileTransferHost: false,
      autoSubscribeToChannel: false
    };

    await getPostHandler('/create')({
      familyId: 'family_1',
      identity: { role: 'owner' },
      device: { identityId: 'owner_identity' },
      headers: { host: 'circle.example' },
      get: (name: string) => name === 'host' ? 'circle.example' : undefined,
      signedRequest: {
        payload: {
          ...(hostIdentityName !== undefined ? { hostIdentityName } : {}),
          canMessage: true,
          canCall: true,
          mode: 'unlimited',
          expiresAt,
          encryptedSecret: { cipher: 'aes-256-gcm', data: 'data', nonce: 'nonce', version: 1 },
          capabilityDescriptor: {
            type: 'link-capability:descriptor',
            signerId: 'owner_identity',
            timestamp: Date.now(),
            nonce: 'nonce',
            signature: 'signature',
            payload: {
              version: 2,
              purpose: 'circlus-link-capability-v2',
              capabilityId: 'cap_test',
              kind: 'direct-guest',
              mode: 'unlimited',
              issuerIdentityId: 'owner_identity',
              targetIdentityId: 'owner_identity',
              capabilityPublicKey: { algorithm: 'ed25519', value: 'capability_key' },
              issuedAt: new Date().toISOString(),
              expiresAt,
              scope: { title: null, permissions, channelId: null, ...(hostIdentityName !== undefined ? { hostIdentityName } : {}) }
            }
          }
        }
      }
    }, res);

    expect(repositories.directGuestLinkRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: null }),
      expect.anything()
    );
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        linkId: 'link_1',
        title: null,
      })
    }));
  });

  test('allows host to delete a revoked guest link only when it has no guests', async () => {
    const repositories = require('../db/repositories');
    repositories.directGuestLinkRepository.deleteRevokedEmpty.mockResolvedValue({
      link_id: 'link_1',
      status: 'revoked',
    });
    const res = makeResponse();

    await getPostHandler('/:linkId/delete')({
      familyId: 'family_1',
      params: { linkId: 'link_1' },
      identity: { role: 'owner' },
      device: { identityId: 'host_identity' },
      signedRequest: { payload: {} },
    }, res);

    expect(repositories.directGuestLinkRepository.deleteRevokedEmpty)
      .toHaveBeenCalledWith('family_1', 'link_1', 'host_identity');
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      result: {
        linkId: 'link_1',
        status: 'deleted',
      },
    });
  });

  test('keeps guest-link history when a revoked link still has guests', async () => {
    const repositories = require('../db/repositories');
    repositories.directGuestLinkRepository.deleteRevokedEmpty.mockResolvedValue(null);
    const res = makeResponse();

    await getPostHandler('/:linkId/delete')({
      familyId: 'family_1',
      params: { linkId: 'link_1' },
      identity: { role: 'owner' },
      device: { identityId: 'host_identity' },
      signedRequest: { payload: {} },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({
        code: 'INVALID_STATE',
      }),
    }));
  });

  test('allows host to update an active guest registration permissions', async () => {
    const repositories = require('../db/repositories');
    repositories.directGuestRegistrationRepository.findActiveByHost.mockResolvedValue({
      registration_id: 'reg_1',
      link_id: 'link_1'
    });
    repositories.directGuestLinkRepository.findById.mockResolvedValue({
      link_id: 'link_1',
      host_identity_id: 'host_identity',
      status: 'active',
      auto_subscribe_to_channel: false
    });
    repositories.directGuestRegistrationRepository.updatePermissionsByHost.mockResolvedValue({
      registration_id: 'reg_1',
      guest_identity_id: 'guest_identity',
      guest_device_id: 'guest_device',
      status: 'active',
      can_message: true,
      can_call: true,
      can_direct_file_transfer: false,
      host_can_message_guest: true,
      guest_can_message_host: true,
	      host_can_call_guest: true,
	      guest_can_call_host: true,
	      host_can_direct_file_transfer_guest: true,
	      guest_can_direct_file_transfer_host: false,
	      created_at: new Date('2026-01-01T00:00:00Z'),
      last_seen_at: null,
      revoked_at: null
    });
    const res = makeResponse();

    await getPostHandler('/registrations/:registrationId/permissions/update')({
      familyId: 'family_1',
      params: { registrationId: 'reg_1' },
      identity: { role: 'owner' },
      device: { identityId: 'host_identity', deviceId: 'device_1' },
      signedRequest: {
        payload: {
          canMessage: true,
          canCall: true,
          canDirectFileTransfer: false
        }
      }
    }, res);

    expect(repositories.directGuestRegistrationRepository.updatePermissionsByHost).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family_1',
      registrationId: 'reg_1',
      hostIdentityId: 'host_identity',
      canMessage: true,
      canCall: true,
      canDirectFileTransfer: false
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        registrationId: 'reg_1',
        permissions: expect.objectContaining({
          canMessage: true,
          canCall: true,
          canDirectFileTransfer: false
        })
      })
    }));
  });

  test('rejects guest file permissions when messages are disabled', async () => {
    const repositories = require('../db/repositories');
    repositories.directGuestRegistrationRepository.findActiveByHost.mockResolvedValue({
      registration_id: 'reg_1',
      link_id: 'link_1'
    });
    const res = makeResponse();

    await getPostHandler('/registrations/:registrationId/permissions/update')({
      familyId: 'family_1',
      params: { registrationId: 'reg_1' },
      identity: { role: 'owner' },
      device: { identityId: 'host_identity', deviceId: 'device_1' },
      signedRequest: {
        payload: {
          canMessage: false,
          canCall: true,
          canDirectFileTransfer: true,
          canServerAttachments: false
        }
      }
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(repositories.directGuestRegistrationRepository.updatePermissionsByHost).not.toHaveBeenCalled();
  });

  test('warns the host about active subscriptions in channels they own', async () => {
    const repositories = require('../db/repositories');
    repositories.directGuestRegistrationRepository.findActiveByHost.mockResolvedValue({
      registration_id: 'reg_1',
      guest_identity_id: 'guest_identity', link_id: 'link_1'
    });
    repositories.announcementChannelRepository.listOwnedActiveSubscriptionsForGuest.mockResolvedValue([{
      channel_id: 'channel_1',
      title: 'Updates',
      key_epoch: 3,
      subscription_id: 'subscription_1'
    }]);
    const res = makeResponse();

    await getPostHandler('/registrations/:registrationId/revoke-impact')({
      familyId: 'family_1',
      params: { registrationId: 'reg_1' },
      identity: { role: 'owner' },
      device: { identityId: 'host_identity' },
      signedRequest: { payload: {} }
    }, res);

    expect(repositories.announcementChannelRepository.listOwnedActiveSubscriptionsForGuest).toHaveBeenCalledWith({
      familyId: 'family_1',
      ownerIdentityId: 'host_identity',
      guestIdentityId: 'guest_identity'
    });
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      result: [{ channelId: 'channel_1', title: 'Updates', keyEpoch: 3 }]
    });
  });

  test('can revoke guest access and remove selected owned-channel subscriptions together', async () => {
    const repositories = require('../db/repositories');
    repositories.directGuestRegistrationRepository.findActiveByHostForUpdate.mockResolvedValue({
      registration_id: 'reg_1',
      guest_identity_id: 'guest_identity', link_id: 'link_1'
    });
    repositories.announcementChannelRepository.listOwnedActiveSubscriptionsForGuest.mockResolvedValue([{
      channel_id: 'channel_1',
      title: 'Updates',
      key_epoch: 3,
      subscription_id: 'subscription_1'
    }]);
    repositories.directGuestRegistrationRepository.revokeByHost.mockResolvedValue({
      registration_id: 'reg_1',
      status: 'revoked',
      revoked_at: new Date('2026-01-01T00:00:00Z')
    });
    repositories.announcementChannelRepository.removeSubscriberByAuthor.mockResolvedValue({
      status: 'removed_by_author'
    });
    const res = makeResponse();

    await getPostHandler('/registrations/:registrationId/revoke')({
      familyId: 'family_1',
      params: { registrationId: 'reg_1' },
      identity: { role: 'owner' },
      device: { identityId: 'host_identity' },
      signedRequest: { payload: { removeFromChannelIds: ['channel_1'], revocation: { type: 'direct-guest:revocation', signerId: 'host_identity', timestamp: Date.now(), payload: { version: 1, purpose: 'circlus-direct-guest-revocation-v1', circleOrigin: 'https://circle.test', registrationId: 'reg_1', linkId: 'link_1', hostIdentityId: 'host_identity', guestIdentityId: 'guest_identity' } } } }
    }, res);

    expect(require('../ws/wsGateway').sendToIdentityWs).toHaveBeenCalledWith('family_1', 'guest_identity', expect.objectContaining({ type: 'system:event', data: expect.objectContaining({ type: 'direct-guest:revoked' }) }));
    expect(repositories.announcementChannelRepository.removeSubscriberByAuthor).toHaveBeenCalledWith(
      {
        familyId: 'family_1',
        channelId: 'channel_1',
        ownerIdentityId: 'host_identity',
        subscriberIdentityId: 'guest_identity'
      },
      expect.anything()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        registrationId: 'reg_1',
        removedChannels: [{ channelId: 'channel_1', title: 'Updates', keyEpoch: 3 }]
      })
    }));
  });

  test('does not revoke guest access when a requested channel removal is stale', async () => {
    const repositories = require('../db/repositories');
    repositories.directGuestRegistrationRepository.findActiveByHostForUpdate.mockResolvedValue({
      registration_id: 'reg_1',
      guest_identity_id: 'guest_identity', link_id: 'link_1'
    });
    repositories.announcementChannelRepository.listOwnedActiveSubscriptionsForGuest.mockResolvedValue([]);
    const res = makeResponse();

    await getPostHandler('/registrations/:registrationId/revoke')({
      familyId: 'family_1',
      params: { registrationId: 'reg_1' },
      identity: { role: 'owner' },
      device: { identityId: 'host_identity' },
      signedRequest: { payload: { removeFromChannelIds: ['stale_channel'] } }
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(repositories.directGuestRegistrationRepository.revokeByHost).not.toHaveBeenCalled();
    expect(repositories.announcementChannelRepository.removeSubscriberByAuthor).not.toHaveBeenCalled();
  });

  test('rejects an oversized channel-removal selection before revoking guest access', async () => {
    const repositories = require('../db/repositories');
    const { transaction } = require('../db');
    const res = makeResponse();

    await getPostHandler('/registrations/:registrationId/revoke')({
      familyId: 'family_1',
      params: { registrationId: 'reg_1' },
      identity: { role: 'owner' },
      device: { identityId: 'host_identity' },
      signedRequest: {
        payload: { removeFromChannelIds: Array.from({ length: 101 }, (_, index) => `channel_${index}`) }
      }
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(transaction).not.toHaveBeenCalled();
    expect(repositories.directGuestRegistrationRepository.revokeByHost).not.toHaveBeenCalled();
  });
});

describe('direct guest link revocation: public-site regeneration', () => {
  test('regenerates the site when a visible guest link is revoked', async () => {
    const repositories = require('../db/repositories');
    const { publicSiteGeneratorService } = require('../services/publicSiteGeneratorService');
    repositories.directGuestLinkRepository.revoke.mockResolvedValue({
      link_id: 'link_1',
      status: 'revoked',
      revoked_at: new Date('2026-01-01T00:00:00Z'),
      public_site_visible: true,
    });
    repositories.directGuestLinkRepository.findById.mockResolvedValue({
      link_id: 'link_1',
      capability_id: 'cap_123456789012345678901234',
    });
    repositories.directGuestRegistrationRepository.revokeAllByLink.mockResolvedValue(undefined);
    const res = makeResponse();

    await getPostHandler('/:linkId/revoke')({
      familyId: 'family_1',
      params: { linkId: 'link_1' },
      identity: { role: 'owner' },
      device: { identityId: 'owner_identity' },
      signedRequest: { payload: { revocation: { type: 'link-capability:revoke' } } },
    }, res);

    expect(publicSiteGeneratorService.regenerateSite).toHaveBeenCalledWith('family_1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });
});


describe('current guest relationship permissions', () => {
  test('scopes reads to authenticated actor and circle, ignoring supplied actor ids', async () => {
    const repository = require('../db/repositories').directGuestRegistrationRepository;
    repository.findLatestByPair.mockResolvedValue({registration_id: 'reg', status: 'active', guest_can_direct_file_transfer_host: true});
    const res = makeResponse();
    await getPostHandler('/registrations/permissions')({familyId: 'circle', device: {identityId: 'guest'},
      signedRequest: {payload: {peerIdentityId: 'host', identityId: 'another-guest'}}}, res);
    expect(repository.findLatestByPair).toHaveBeenCalledWith('circle', 'guest', 'host');
    expect(res.json).toHaveBeenCalledWith({status: 'ok', result: {registrationId: 'reg',
      permissions: expect.objectContaining({guestCanDirectFileTransferHost: true}), status: 'active', departure: null,
        revocation: null, hostIdentityPublicKey: null, guestIdentityPublicKey: null}});
  });
  test('returns a departed registration proof while clearing every communication permission', async () => {
    const repository = require('../db/repositories').directGuestRegistrationRepository;
    const departure = { type: 'direct-guest:departure', signature: 'guest-signature' };
    repository.findLatestByPair.mockResolvedValue({ registration_id: 'reg', status: 'deleted_by_guest', departure_proof: departure,
      can_call: true, host_can_call_guest: true, guest_can_call_host: true, can_message: true });
    const res = makeResponse();
    await getPostHandler('/registrations/permissions')({ familyId: 'circle', device: { identityId: 'host' },
      signedRequest: { payload: { peerIdentityId: 'guest' } } }, res);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok', result: expect.objectContaining({ registrationId: 'reg',
      status: 'deleted_by_guest', departure, permissions: expect.objectContaining({ canCall: false, canMessage: false, hostCanCallGuest: false, guestCanCallHost: false }) }) });
  });

  test('returns no permissions for an absent or revoked relationship', async () => {
    const repository = require('../db/repositories').directGuestRegistrationRepository;
    repository.findLatestByPair.mockResolvedValue(null);
    const res = makeResponse();
    await getPostHandler('/registrations/permissions')({familyId: 'circle', device: {identityId: 'guest'},
      signedRequest: {payload: {peerIdentityId: 'stranger'}}}, res);
    expect(res.json).toHaveBeenCalledWith({status: 'ok', result: null});
  });
  test('rejects an invalid peer before querying storage', async () => {
    const repository = require('../db/repositories').directGuestRegistrationRepository;
    repository.findLatestByPair.mockClear();
    const res = makeResponse();
    await getPostHandler('/registrations/permissions')({familyId: 'circle', device: {identityId: 'guest'},
      signedRequest: {payload: {peerIdentityId: {identityId: 'host'}}}}, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(repository.findLatestByPair).not.toHaveBeenCalled();
  });
});
