jest.mock('../services/reliableOperation', () => ({ reliableOperation: (handler: unknown) => handler }));
jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {}),
}));

jest.mock('../db', () => ({
  transaction: jest.fn(async (callback: (client: Record<string, never>) => Promise<unknown>) => callback({}))
}));

jest.mock('../services/publicSiteGeneratorService', () => ({
  publicSiteGeneratorService: {
    regenerateSite: jest.fn(),
  },
}));

jest.mock('../services/configService', () => ({
  configService: {
    getResolvedFamilyConfig: jest.fn().mockResolvedValue({
      config: { public_base_url: 'https://circle.example' },
    }),
  },
}));

jest.mock('../services/linkCapabilityService', () => ({
  verifyCapabilityProof: jest.fn(() => true),
}));

jest.mock('../services/circleMembershipProofService', () => ({
  listCircleIdentityAdmissionProofs: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/circleMembershipStateService', () => ({
  listCircleMembershipStates: jest.fn().mockResolvedValue([
    { claim: { payload: { stateId: 'cms_channelstate00', sequence: 1 } }, admission: null },
  ]),
}));

jest.mock('../utils/crypto', () => ({
  verifySignedRequest: jest.fn(() => true),
}));

jest.mock('../utils/push', () => ({
  sendIncomingMessagePush: jest.fn().mockResolvedValue({}),
  sendMessagesReadPush: jest.fn().mockResolvedValue({}),
  sendChannelPublicationRequestPush: jest.fn().mockResolvedValue({}),
}));

jest.mock('../db/repositories', () => ({
  announcementChannelRepository: {
    create: jest.fn(),
    updateMetadata: jest.fn(),
    updateServerAdminDisclosure: jest.fn(),
    updatePublicSite: jest.fn(),
    listVisibleForIdentity: jest.fn(),
    canIdentityAccess: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    updateNotifications: jest.fn(),
    findByLink: jest.fn(),
    findById: jest.fn(),
    findPostById: jest.fn(),
    ensureDefaultForLink: jest.fn(),
    listActiveRecipients: jest.fn(),
    listRemovedRecipients: jest.fn(),
    removeSubscriberByAuthor: jest.fn(),
    restoreSubscriberByAuthor: jest.fn(),
    findSubscriptionForIdentity: jest.fn(),
    findEpochKey: jest.fn(),
    findKeyEnvelope: jest.fn(),
    listMissingKeyRecipients: jest.fn(),
    claimEpochKey: jest.fn(),
    upsertKeyEnvelopes: jest.fn(),
    createPost: jest.fn(),
    listPosts: jest.fn(),
    listPostsBefore: jest.fn(),
    listLatestPosts: jest.fn(),
    listLatestPostActivity: jest.fn(),
    listPostEngagement: jest.fn().mockResolvedValue(new Map()),
    listPostEngagementRecipients: jest.fn(),
    markReceived: jest.fn(),
    markRead: jest.fn(),
    editPost: jest.fn(),
  },
  circleSitePublicationRepository: {
    listPublishedSourceChannelPostLinks: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
  },
  circleSiteSettingsRepository: {
    findByFamilyId: jest.fn().mockResolvedValue({ enabled: true }),
  },
  identityRepository: { findByIdentityId: jest.fn(), findByRole: jest.fn().mockResolvedValue([]) },
  serverAdminRepository: { isActiveServerAdmin: jest.fn() },
  directGuestLinkRepository: {
    findById: jest.fn(),
  },
}));

const router = require('./announcementChannels').default;
const repositories = require('../db/repositories');

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
  const layer = findLayer(router);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function makeResponse(): MockResponse {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

function subscriptionAcceptance(identityId: string, channelId: string, source: {
  linkId?: string;
  capabilityId?: string;
  proof?: unknown;
} = {}) {
  return {
    type: 'announcement-channel:subscription',
    signerId: identityId,
    timestamp: Date.now(),
    nonce: 'subscription-nonce',
    signature: 'subscription-signature',
    payload: {
      version: 1,
      purpose: 'circlus-channel-subscription-v1',
      channelId,
      subscriberIdentityId: identityId,
      sourceLinkId: source.linkId || null,
      sourceLinkCapabilityId: source.capabilityId || null,
      sourceLinkProof: source.proof || null,
    },
  };
}

describe('announcement channel identity subscriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repositories.identityRepository.findByIdentityId.mockResolvedValue({
      public_key_algorithm: 'ed25519',
      public_key_value: 'member-key',
    });
  });

  test('lists a channel for an already registered guest identity', async () => {
    repositories.announcementChannelRepository.listVisibleForIdentity.mockResolvedValue([{
      channel_id: 'ach_1',
      family_id: 'family_1',
      owner_identity_id: 'owner_1',
      title: 'Announcements',
      description: null,
      visibility: 'circle',
      content_mode: 'private_e2ee',
      is_default: true,
      status: 'active',
      subscription_id: null,
      subscription_status: null,
      notifications_enabled: null,
      source_link_id: null,
      link_count: 1,
      subscriber_count: 0,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
      archived_at: null,
      deleted_at: null,
    }]);
    const res = makeResponse();

    await getPostHandler('/mine')({
      familyId: 'family_1',
      identity: { identityId: 'guest_1', role: 'guest' },
    }, res);

    expect(repositories.announcementChannelRepository.listVisibleForIdentity).toHaveBeenCalledWith({
      familyId: 'family_1',
      identityId: 'guest_1',
      role: 'guest',
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: [expect.objectContaining({ channelId: 'ach_1', subscription: null })],
    }));
    const response = res.json.mock.calls[0][0];
    expect(response.result[0]).not.toHaveProperty('linkCount');
    expect(response.result[0]).not.toHaveProperty('subscriberCount');
    expect(response.result[0]).not.toHaveProperty('visibility');
    expect(response.result[0]).not.toHaveProperty('isDefault');
    expect(response.result[0]).not.toHaveProperty('status');
    expect(response.result[0]).not.toHaveProperty('updatedAt');
  });

  test('updates only encrypted channel metadata for the channel author', async () => {
    const channel = {
      channel_id: 'ach_1',
      family_id: 'family_1',
      owner_identity_id: 'owner_1',
      title: null,
      description: null,
      status: 'active',
      public_site_visible: false,
      key_epoch: 2,
      metadata_revision: 3,
    };
    const updated = {
      ...channel,
      metadata_epoch: 2,
      metadata_ciphertext: 'gcm1:ciphertext',
      metadata_revision: 4,
      metadata_author_device_id: 'device_1',
      metadata_author_claim: {},
      is_default: false,
      subscription_id: null,
      subscription_status: null,
      notifications_enabled: null,
      source_link_id: null,
      link_count: 1,
      subscriber_count: 2,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    };
    repositories.announcementChannelRepository.findById.mockResolvedValue(channel);
    repositories.announcementChannelRepository.updateMetadata.mockResolvedValue(updated);
    repositories.announcementChannelRepository.listVisibleForIdentity.mockResolvedValue([updated]);
    const res = makeResponse();

    await getPostHandler('/:channelId/update')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'member' },
      device: { deviceId: 'device_1', publicKey: { algorithm: 'ed25519', value: 'device-key' } },
      signedRequest: {
        payload: {
          epoch: 2,
          expectedRevision: 3,
          ciphertext: 'gcm1:ciphertext',
          authorClaim: {
            type: 'channel:metadata:update',
            signerId: 'device_1',
            payload: { version: 1, channelId: 'ach_1', epoch: 2, expectedRevision: 3, ciphertext: 'gcm1:ciphertext' },
          },
        },
      },
    }, res);

    expect(repositories.announcementChannelRepository.updateMetadata).toHaveBeenCalledWith({
      familyId: 'family_1',
      channelId: 'ach_1',
      ownerIdentityId: 'owner_1',
      epoch: 2,
      expectedRevision: 3,
      ciphertext: 'gcm1:ciphertext',
      authorDeviceId: 'device_1',
      authorClaim: expect.objectContaining({ type: 'channel:metadata:update' }),
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        channelId: 'ach_1',
        title: '',
        description: null,
        metadata: expect.objectContaining({ epoch: 2, revision: 4, ciphertext: 'gcm1:ciphertext' }),
      }),
    }));
  });

  test('rejects channel metadata when its inner device signature is invalid', async () => {
    const cryptoUtils = require('../utils/crypto');
    cryptoUtils.verifySignedRequest.mockReturnValueOnce(false);
    const res = makeResponse();

    await getPostHandler('/:channelId/update')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'member' },
      device: { deviceId: 'device_1', publicKey: { algorithm: 'ed25519', value: 'device-key' } },
      signedRequest: {
        payload: {
          epoch: 2,
          expectedRevision: 3,
          ciphertext: 'gcm1:ciphertext',
          authorClaim: {
            type: 'channel:metadata:update',
            signerId: 'device_1',
            payload: { version: 1, channelId: 'ach_1', epoch: 2, expectedRevision: 3, ciphertext: 'gcm1:ciphertext' },
          },
        },
      },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(repositories.announcementChannelRepository.updateMetadata).not.toHaveBeenCalled();
  });

  test('lets an eligible channel author disclose confirmed server administration', async () => {
    const channel = {
      channel_id: 'ach_1',
      family_id: 'family_1',
      owner_identity_id: 'owner_1',
      title: 'Announcements',
      description: null,
      status: 'active',
      disclose_server_admin_status: false,
    };
    const visibleChannel = {
      ...channel,
      disclose_server_admin_status: true,
      author_is_circle_owner: true,
      author_is_server_admin: true,
      visibility: 'circle',
      content_mode: 'private_e2ee',
      is_default: false,
      subscription_id: null,
      subscription_status: null,
      notifications_enabled: null,
      source_link_id: null,
      link_count: 0,
      subscriber_count: 1,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    };
    repositories.announcementChannelRepository.findById.mockResolvedValue(channel);
    repositories.serverAdminRepository.isActiveServerAdmin.mockResolvedValue(true);
    repositories.announcementChannelRepository.updateServerAdminDisclosure.mockResolvedValue({
      ...channel,
      disclose_server_admin_status: true,
    });
    repositories.announcementChannelRepository.listVisibleForIdentity.mockResolvedValue([visibleChannel]);
    const res = makeResponse();

    await getPostHandler('/:channelId/server-admin-disclosure')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'owner' },
      signedRequest: { payload: { enabled: true } },
    }, res);

    expect(repositories.serverAdminRepository.isActiveServerAdmin).toHaveBeenCalledWith('owner_1');
    expect(repositories.announcementChannelRepository.updateServerAdminDisclosure).toHaveBeenCalledWith({
      familyId: 'family_1',
      channelId: 'ach_1',
      ownerIdentityId: 'owner_1',
      enabled: true,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        authorManagesServer: true,
        serverAdminDisclosureEnabled: true,
        canDiscloseServerAdmin: true,
      }),
    }));
  });

  test('does not disclose server administration for a Circle owner without server admin access', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1',
      family_id: 'family_1',
      owner_identity_id: 'owner_1',
      status: 'active',
    });
    repositories.serverAdminRepository.isActiveServerAdmin.mockResolvedValue(false);
    const res = makeResponse();

    await getPostHandler('/:channelId/server-admin-disclosure')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'owner' },
      signedRequest: { payload: { enabled: true } },
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(repositories.announcementChannelRepository.updateServerAdminDisclosure).not.toHaveBeenCalled();
  });

  test('hides a disclosed server admin badge automatically after admin access is revoked', async () => {
    repositories.announcementChannelRepository.listVisibleForIdentity.mockResolvedValue([{
      channel_id: 'ach_1',
      family_id: 'family_1',
      owner_identity_id: 'owner_1',
      title: 'Announcements',
      description: null,
      visibility: 'circle',
      content_mode: 'private_e2ee',
      is_default: false,
      status: 'active',
      disclose_server_admin_status: true,
      author_is_circle_owner: true,
      author_is_server_admin: false,
      subscription_id: 'sub_1',
      subscription_status: 'active',
      notifications_enabled: true,
      source_link_id: null,
      key_status: 'ready',
      last_received_sequence: null,
      last_read_sequence: null,
      link_count: 0,
      subscriber_count: 1,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    }]);
    const res = makeResponse();

    await getPostHandler('/mine')({
      familyId: 'family_1',
      identity: { identityId: 'subscriber_1', role: 'member' },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: [expect.objectContaining({ authorManagesServer: false })],
    }));
  });

  test('includes channel management metadata only for the channel owner', async () => {
    repositories.announcementChannelRepository.listVisibleForIdentity.mockResolvedValue([{
      channel_id: 'ach_1',
      family_id: 'family_1',
      owner_identity_id: 'owner_1',
      title: 'Announcements',
      description: null,
      visibility: 'circle',
      content_mode: 'private_e2ee',
      is_default: true,
      status: 'active',
      subscription_id: null,
      subscription_status: null,
      notifications_enabled: null,
      source_link_id: null,
      link_count: 2,
      subscriber_count: 3,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
      archived_at: null,
      deleted_at: null,
    }]);
    const res = makeResponse();

    await getPostHandler('/mine')({
      familyId: 'family_1',
      identity: { identityId: 'owner_1', role: 'owner' },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: [expect.objectContaining({
        channelId: 'ach_1',
        isDefault: true,
        status: 'active',
        linkCount: 2,
        subscriberCount: 3,
        updatedAt: '2026-01-02T00:00:00.000Z',
      })],
    }));
  });

  test('subscribes an existing member identity without guest registration', async () => {
    repositories.announcementChannelRepository.canIdentityAccess.mockResolvedValue(true);
    repositories.announcementChannelRepository.subscribe.mockResolvedValue({
      subscription_id: 'acs_1',
      channel_id: 'ach_1',
      subscriber_identity_id: 'member_1',
      source_link_id: null,
      notifications_enabled: true,
      status: 'active',
      subscribed_at: new Date('2026-01-01T00:00:00Z'),
    });
    const res = makeResponse();
    const acceptance = subscriptionAcceptance('member_1', 'ach_1');

    await getPostHandler('/:channelId/subscribe')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'member_1', role: 'member' },
      signedRequest: { payload: {
        notificationsEnabled: true,
        subscriptionAcceptance: acceptance,
      } },
    }, res);

    expect(repositories.announcementChannelRepository.subscribe).toHaveBeenCalledWith({
      familyId: 'family_1',
      channelId: 'ach_1',
      identityId: 'member_1',
      sourceLinkId: null,
      notificationsEnabled: true,
      subscriptionClaim: acceptance,
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ subscriptionId: 'acs_1' }),
    }));
  });

  test('subscribes an existing Circle identity through a valid channel invitation', async () => {
    repositories.announcementChannelRepository.canIdentityAccess.mockResolvedValue(false);
    repositories.announcementChannelRepository.findByLink.mockResolvedValue({
      channel_id: 'ach_1',
    });
    repositories.directGuestLinkRepository.findById.mockResolvedValue({
      link_id: 'link_1',
      status: 'active',
      auto_subscribe_to_channel: true,
      capability_id: 'cap_123456789012345678901234',
      capability_descriptor: { payload: { capabilityId: 'cap_123456789012345678901234' } },
      expires_at: new Date('2099-01-01T00:00:00Z'),
    });
    repositories.announcementChannelRepository.subscribe.mockResolvedValue({
      subscription_id: 'acs_1',
      channel_id: 'ach_1',
      subscriber_identity_id: 'member_1',
      source_link_id: 'link_1',
      notifications_enabled: true,
      status: 'active',
      subscribed_at: new Date('2026-01-01T00:00:00Z'),
    });
    const res = makeResponse();
    const sourceLinkProof = {
      payload: {
        context: { channelId: 'ach_1' },
      },
    };
    const acceptance = subscriptionAcceptance('member_1', 'ach_1', {
      linkId: 'link_1',
      capabilityId: 'cap_123456789012345678901234',
      proof: sourceLinkProof,
    });

    await getPostHandler('/:channelId/subscribe')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'member_1', role: 'member' },
      signedRequest: {
        payload: {
          notificationsEnabled: true,
          sourceLinkId: 'link_1',
          sourceLinkCapabilityId: 'cap_123456789012345678901234',
          sourceLinkProof,
          subscriptionAcceptance: acceptance,
        },
      },
    }, res);

    expect(repositories.announcementChannelRepository.subscribe).toHaveBeenCalledWith({
      familyId: 'family_1',
      channelId: 'ach_1',
      identityId: 'member_1',
      sourceLinkId: 'link_1',
      notificationsEnabled: true,
      subscriptionClaim: acceptance,
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  test('does not allow a subscriber removed by the author to subscribe again', async () => {
    repositories.announcementChannelRepository.findSubscriptionForIdentity.mockResolvedValue({
      status: 'removed_by_author',
    });
    const res = makeResponse();

    await getPostHandler('/:channelId/subscribe')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'guest_1', role: 'guest' },
      signedRequest: { payload: {
        notificationsEnabled: true,
        subscriptionAcceptance: subscriptionAcceptance('guest_1', 'ach_1'),
      } },
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(repositories.announcementChannelRepository.subscribe).not.toHaveBeenCalled();
  });

  test('lets the channel author remove an active subscriber', async () => {
    repositories.announcementChannelRepository.removeSubscriberByAuthor.mockResolvedValue({
      status: 'removed_by_author',
    });
    repositories.announcementChannelRepository.findById.mockResolvedValue({ key_epoch: 3 });
    const res = makeResponse();

    await getPostHandler('/:channelId/recipients/:subscriberIdentityId/remove')({
      familyId: 'family_1',
      params: { channelId: 'ach_1', subscriberIdentityId: 'guest_1' },
      identity: { identityId: 'owner_1', role: 'member' },
      signedRequest: { payload: {} },
    }, res);

    expect(repositories.announcementChannelRepository.removeSubscriberByAuthor).toHaveBeenCalledWith({
      familyId: 'family_1',
      channelId: 'ach_1',
      ownerIdentityId: 'owner_1',
      subscriberIdentityId: 'guest_1',
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ status: 'removed_by_author', keyEpoch: 3 }),
    }));
  });

  test('returns ordinary member recipients without requiring a guest registration', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'owner_1',
      status: 'active',
    });
    repositories.announcementChannelRepository.listActiveRecipients.mockResolvedValue([{
      subscription_id: 'acs_member',
      registration_id: null,
      guest_identity_id: 'member_1',
      guest_device_id: null,
      guest_identity_name: 'Member',
      guest_public_key_algorithm: 'ed25519',
      guest_public_key_value: 'public-key',
      source_link_id: null,
    }]);
    const res = makeResponse();

    await getPostHandler('/:channelId/recipients')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'owner' },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: [expect.objectContaining({
        subscriptionId: 'acs_member',
        registrationId: null,
        guestIdentityId: 'member_1',
      })],
    }));
  });

  test('updates push notifications without changing the active subscription', async () => {
    repositories.announcementChannelRepository.updateNotifications.mockResolvedValue({
      subscription_id: 'acs_1',
      channel_id: 'ach_1',
      subscriber_identity_id: 'guest_1',
      source_link_id: 'link_1',
      notifications_enabled: false,
      status: 'active',
    });
    const res = makeResponse();

    await getPostHandler('/:channelId/notifications')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'guest_1', role: 'guest' },
      signedRequest: { payload: { notificationsEnabled: false } },
    }, res);

    expect(repositories.announcementChannelRepository.updateNotifications).toHaveBeenCalledWith(
      'family_1',
      'ach_1',
      'guest_1',
      false
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        status: 'active',
        notificationsEnabled: false,
      }),
    }));
  });

  test('lets a regular Circle member create a standalone channel', async () => {
    const channel = {
      channel_id: 'ach_new',
      family_id: 'family_1',
      owner_identity_id: 'member_1',
      title: 'Member updates',
      description: null,
      visibility: 'circle',
      content_mode: 'private_e2ee',
      is_default: false,
      public_site_state: 'hidden',
      public_site_visible: false,
      status: 'active',
      subscription_id: null,
      subscription_status: null,
      notifications_enabled: null,
      source_link_id: null,
      link_count: 0,
      subscriber_count: 0,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
      archived_at: null,
      deleted_at: null,
    };
    repositories.announcementChannelRepository.create.mockResolvedValue(channel);
    repositories.announcementChannelRepository.listVisibleForIdentity.mockResolvedValue([channel]);
    const res = makeResponse();

    await getPostHandler('/create')({
      familyId: 'family_1',
      identity: { identityId: 'member_1', role: 'member' },
      signedRequest: { payload: {} },
    }, res);

    expect(repositories.announcementChannelRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ ownerIdentityId: 'member_1' })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ channelId: 'ach_new' }),
    }));
  });

  test('turns a member publication action into a pending owner request', async () => {
    const channel = {
      channel_id: 'ach_1',
      family_id: 'family_1',
      owner_identity_id: 'member_1',
      title: 'Member updates',
      description: null,
      visibility: 'circle',
      content_mode: 'private_e2ee',
      is_default: false,
      public_site_state: 'hidden',
      public_site_visible: false,
      public_site_slug: null,
      public_site_cta_label: null,
      public_site_intro_title: null,
      public_site_intro_text: null,
      public_site_intro_image_url: null,
      public_site_guest_link_id: null,
      public_site_guest_link_url: null,
      public_site_requested_by_identity_id: null,
      public_site_requested_at: null,
      public_site_approved_by_identity_id: null,
      public_site_approved_at: null,
      status: 'active',
      subscription_id: null,
      subscription_status: null,
      notifications_enabled: null,
      source_link_id: null,
      link_count: 0,
      subscriber_count: 0,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
      archived_at: null,
      deleted_at: null,
    };
    const requested = {
      ...channel,
      public_site_state: 'requested',
      public_site_slug: 'channel-ach1',
      public_site_requested_by_identity_id: 'member_1',
      public_site_requested_at: new Date('2026-01-02T00:00:00Z'),
    };
    repositories.announcementChannelRepository.findById.mockResolvedValue(channel);
    repositories.announcementChannelRepository.updatePublicSite.mockResolvedValue(requested);
    repositories.announcementChannelRepository.listVisibleForIdentity.mockResolvedValue([requested]);
    repositories.identityRepository.findByRole.mockResolvedValue([{
      identity_id: 'owner_1',
      status: 'active',
    }]);
    repositories.identityRepository.findByIdentityId.mockResolvedValue({
      identity_id: 'member_1',
      identity_name: 'Member',
    });
    const res = makeResponse();

    await getPostHandler('/:channelId/public-site')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'member_1', role: 'member' },
      headers: { host: 'family.example.com' },
      signedRequest: { payload: { action: 'publish' } },
    }, res);

    expect(repositories.announcementChannelRepository.updatePublicSite).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'requested',
        visible: false,
        requestedByIdentityId: 'member_1',
        approvedByIdentityId: null,
      })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        publicSite: expect.objectContaining({ state: 'requested', visible: false }),
      }),
    }));
    const push = require('../utils/push');
    expect(push.sendChannelPublicationRequestPush).toHaveBeenCalledWith(
      'family_1',
      'owner_1',
      expect.objectContaining({
        channelId: 'ach_1',
        channelTitle: 'Channel',
        requestingIdentityId: 'member_1',
        requestingIdentityName: undefined,
      })
    );
  });

  test('keeps an approved member channel published when its author updates public settings', async () => {
    const approvedAt = new Date('2026-01-02T00:00:00Z');
    const published = {
      channel_id: 'ach_1',
      family_id: 'family_1',
      owner_identity_id: 'member_1',
      title: 'Member updates',
      description: null,
      visibility: 'circle',
      content_mode: 'private_e2ee',
      is_default: false,
      public_site_state: 'published',
      public_site_visible: true,
      public_site_slug: 'member-updates',
      public_site_cta_label: null,
      public_site_intro_title: 'Old title',
      public_site_intro_text: null,
      public_site_intro_image_url: null,
      public_site_guest_link_id: null,
      public_site_guest_link_url: null,
      public_site_requested_by_identity_id: 'member_1',
      public_site_requested_at: new Date('2026-01-01T00:00:00Z'),
      public_site_approved_by_identity_id: 'owner_1',
      public_site_approved_at: approvedAt,
      status: 'active',
      subscription_id: null,
      subscription_status: null,
      notifications_enabled: null,
      source_link_id: null,
      link_count: 0,
      subscriber_count: 0,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: approvedAt,
      archived_at: null,
      deleted_at: null,
    };
    const updated = {
      ...published,
      public_site_intro_title: 'New title',
      updated_at: new Date('2026-01-03T00:00:00Z'),
    };
    repositories.announcementChannelRepository.findById.mockResolvedValue(published);
    repositories.announcementChannelRepository.updatePublicSite.mockResolvedValue(updated);
    repositories.announcementChannelRepository.listVisibleForIdentity.mockResolvedValue([updated]);
    const res = makeResponse();

    await getPostHandler('/:channelId/public-site')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'member_1', role: 'member' },
      headers: { host: 'family.example.com' },
      signedRequest: { payload: { action: 'update', introTitle: 'New title' } },
    }, res);

    expect(repositories.announcementChannelRepository.updatePublicSite).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'published',
        visible: true,
        introTitle: 'New title',
        requestedByIdentityId: 'member_1',
        approvedByIdentityId: 'owner_1',
      })
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        publicSite: expect.objectContaining({ state: 'published', visible: true }),
      }),
    }));
    const push = require('../utils/push');
    expect(push.sendChannelPublicationRequestPush).not.toHaveBeenCalled();
  });

  test('does not let the Circle owner publish somebody else’s channel without a request', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'member_1',
      public_site_state: 'hidden',
      status: 'active',
    });
    const res = makeResponse();

    await getPostHandler('/:channelId/public-site')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'owner' },
      signedRequest: { payload: { action: 'approve' } },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(repositories.announcementChannelRepository.updatePublicSite).not.toHaveBeenCalled();
  });
});

describe('announcement channel epoch initialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'owner_1',
      status: 'active',
      key_epoch: 2,
    });
    repositories.announcementChannelRepository.listMissingKeyRecipients.mockResolvedValue([
      { identity_id: 'owner_1' },
      { identity_id: 'subscriber_1' },
    ]);
    repositories.announcementChannelRepository.claimEpochKey.mockResolvedValue({
      key_commitment: 'a'.repeat(64),
    });
    repositories.announcementChannelRepository.upsertKeyEnvelopes.mockResolvedValue(undefined);
  });

  test('claims the epoch and stores complete envelope coverage together', async () => {
    const res = makeResponse();
    await getPostHandler('/:channelId/keys/claim')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1' },
      device: { deviceId: 'device_1' },
      signedRequest: {
        payload: {
          epoch: 2,
          keyCommitment: 'a'.repeat(64),
          membershipStateId: 'cms_channelstate00',
          envelopes: [
            { identityId: 'owner_1', envelopeCiphertext: 'gk2:owner_1:one' },
            { identityId: 'subscriber_1', envelopeCiphertext: 'gk2:owner_1:two' },
          ],
        },
      },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
    expect(repositories.announcementChannelRepository.claimEpochKey).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'ach_1', epoch: 2 }),
      expect.anything()
    );
    expect(repositories.announcementChannelRepository.upsertKeyEnvelopes).toHaveBeenCalledWith(
      expect.objectContaining({ envelopes: expect.arrayContaining([expect.objectContaining({ identityId: 'subscriber_1' })]) }),
      expect.anything()
    );
  });

  test('does not claim an epoch before every recipient has an envelope', async () => {
    const res = makeResponse();
    await getPostHandler('/:channelId/keys/claim')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1' },
      device: { deviceId: 'device_1' },
      signedRequest: {
        payload: {
          epoch: 2,
          keyCommitment: 'a'.repeat(64),
          membershipStateId: 'cms_channelstate00',
          envelopes: [{ identityId: 'owner_1', envelopeCiphertext: 'gk2:owner_1:one' }],
        },
      },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(repositories.announcementChannelRepository.claimEpochKey).not.toHaveBeenCalled();
  });
});

describe('channel-native encrypted posts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    repositories.circleSitePublicationRepository.listPublishedSourceChannelPostLinks.mockResolvedValue([]);
  });

  test('stores one signed ciphertext without creating direct-message deliveries', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'owner_1',
      status: 'active',
      key_epoch: 1,
      title: 'Updates',
      public_site_visible: false,
    });
    repositories.announcementChannelRepository.findEpochKey.mockResolvedValue({ key_commitment: 'a'.repeat(64) });
    repositories.announcementChannelRepository.findKeyEnvelope.mockResolvedValue({ envelope_ciphertext: 'gk2:owner_1:test' });
    repositories.announcementChannelRepository.createPost.mockResolvedValue({
      deduplicated: false,
      post: {
        post_id: 'acp_1',
        channel_id: 'ach_1',
        post_sequence: 1,
        author_identity_id: 'owner_1',
        author_device_id: 'device_1',
        client_post_id: 'client_1',
        client_created_at: 123,
        epoch: 1,
        ciphertext: 'gcm1:ciphertext',
        notification_preview_ciphertext: 'npv2:preview',
        author_signature: 'signature',
        author_signed_claim: {},
        revision: 1,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        edited_at: null,
        deleted_at: null,
      },
    });
    const claim = {
      type: 'channel:post:create',
      signerId: 'device_1',
      timestamp: 123,
      payload: {
        version: 1,
        channelId: 'ach_1',
        clientPostId: 'client_1',
        clientCreatedAt: 123,
        epoch: 1,
        ciphertext: 'gcm1:ciphertext',
        notificationPreviewCiphertext: 'npv2:preview',
      },
      signature: 'signature',
    };
    const res = makeResponse();

    await getPostHandler('/:channelId/posts/create')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'owner' },
      device: { deviceId: 'device_1', publicKey: { algorithm: 'ed25519', value: 'key' } },
      signedRequest: {
        payload: {
          clientPostId: 'client_1',
          clientCreatedAt: 123,
          epoch: 1,
          ciphertext: 'gcm1:ciphertext',
          notificationPreviewCiphertext: 'npv2:preview',
          authorClaim: claim,
        },
      },
    }, res);

    expect(repositories.announcementChannelRepository.createPost).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ postId: 'acp_1', sequence: 1, ciphertext: 'gcm1:ciphertext' }),
    }));
  });

  test('rejects legacy channel post ciphertext', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'owner_1',
      status: 'active',
      key_epoch: 1,
    });
    const res = makeResponse();

    await getPostHandler('/:channelId/posts/create')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'owner' },
      device: { deviceId: 'device_1', publicKey: { algorithm: 'ed25519', value: 'key' } },
      signedRequest: {
        payload: {
          clientPostId: 'client_legacy',
          clientCreatedAt: 123,
          epoch: 1,
          ciphertext: 'v3:legacy',
        },
      },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(repositories.announcementChannelRepository.createPost).not.toHaveBeenCalled();
  });

  test('rejects a legacy encrypted notification preview', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'owner_1',
      status: 'active',
      key_epoch: 1,
    });
    const res = makeResponse();

    await getPostHandler('/:channelId/posts/create')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'owner' },
      device: { deviceId: 'device_1', publicKey: { algorithm: 'ed25519', value: 'key' } },
      signedRequest: {
        payload: {
          clientPostId: 'client_legacy_preview',
          clientCreatedAt: 123,
          epoch: 1,
          ciphertext: 'gcm1:current',
          notificationPreviewCiphertext: 'v3:legacy',
        },
      },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(repositories.announcementChannelRepository.createPost).not.toHaveBeenCalled();
  });

  test('allows an active subscriber to synchronize the shared channel stream', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1', owner_identity_id: 'owner_1', status: 'active',
    });
    repositories.announcementChannelRepository.findSubscriptionForIdentity.mockResolvedValue({ status: 'active' });
    repositories.announcementChannelRepository.listPosts.mockResolvedValue([]);
    const res = makeResponse();

    await getPostHandler('/:channelId/posts/list')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'subscriber_1', role: 'member' },
      signedRequest: { payload: { afterSequence: 0, limit: 100 } },
    }, res);

    expect(repositories.announcementChannelRepository.listPosts).toHaveBeenCalledWith({
      familyId: 'family_1', channelId: 'ach_1', afterSequence: 0, limit: 101,
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  test('includes the public publication URL for a published channel post', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1',
      owner_identity_id: 'owner_1',
      status: 'active',
      public_site_visible: true,
      public_site_slug: 'updates',
    });
    repositories.announcementChannelRepository.findSubscriptionForIdentity.mockResolvedValue({ status: 'active' });
    repositories.announcementChannelRepository.listPosts.mockResolvedValue([{
      post_id: 'acp_1',
      channel_id: 'ach_1',
      post_sequence: 1,
      author_identity_id: 'owner_1',
      author_device_id: 'device_1',
      client_post_id: 'client_1',
      client_created_at: 123,
      epoch: 1,
      ciphertext: 'gcm1:ciphertext',
      notification_preview_ciphertext: null,
      author_signature: 'signature',
      author_signed_claim: {},
      revision: 1,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
      edited_at: null,
      deleted_at: null,
    }]);
    repositories.circleSitePublicationRepository.listPublishedSourceChannelPostLinks.mockResolvedValue([{
      source_channel_post_id: 'acp_1',
      slug: 'full-story',
      body_format: 'markdown',
      status: 'published',
    }]);
    const res = makeResponse();

    await getPostHandler('/:channelId/posts/list')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'subscriber_1', role: 'member' },
      signedRequest: { payload: { afterSequence: 0, limit: 100 } },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        publicChannelUrl: 'https://circle.example/channels/updates/',
        posts: [expect.objectContaining({
          alreadyPublished: true,
          publicPost: {
            published: true,
            url: 'https://circle.example/channels/updates/posts/full-story/',
            bodyFormat: 'markdown',
          },
        })],
      }),
    }));
  });

  test('loads older posts through a stable sequence cursor', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1', owner_identity_id: 'owner_1', status: 'active',
    });
    repositories.announcementChannelRepository.findSubscriptionForIdentity.mockResolvedValue({ status: 'active' });
    repositories.announcementChannelRepository.listPostsBefore.mockResolvedValue([]);
    const res = makeResponse();

    await getPostHandler('/:channelId/posts/list')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'subscriber_1', role: 'member' },
      signedRequest: { payload: { afterSequence: 0, beforeSequence: 51, limit: 50 } },
    }, res);

    expect(repositories.announcementChannelRepository.listPostsBefore).toHaveBeenCalledWith({
      familyId: 'family_1', channelId: 'ach_1', beforeSequence: 51, limit: 51,
    });
    expect(repositories.announcementChannelRepository.listPosts).not.toHaveBeenCalled();
  });

  test('returns cursor-derived engagement counts only to the channel author', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1', owner_identity_id: 'owner_1', status: 'active',
    });
    repositories.announcementChannelRepository.listLatestPosts.mockResolvedValue([{
      post_id: 'acp_7',
      channel_id: 'ach_1',
      post_sequence: 7,
      author_identity_id: 'owner_1',
      author_device_id: 'device_1',
      client_post_id: 'client_7',
      client_created_at: 700,
      epoch: 1,
      ciphertext: 'gcm1:ciphertext',
      notification_preview_ciphertext: null,
      author_signature: 'signature',
      author_signed_claim: {},
      revision: 1,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
      edited_at: null,
      deleted_at: null,
    }]);
    repositories.announcementChannelRepository.listPostEngagement.mockResolvedValue(new Map([
      [7, { receivedCount: 12, viewedCount: 8 }],
    ]));
    const res = makeResponse();

    await getPostHandler('/:channelId/posts/list')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'owner_1', role: 'member' },
      signedRequest: { payload: { afterSequence: 0, limit: 100, latest: true } },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        posts: [expect.objectContaining({ receivedCount: 12, viewedCount: 8 })],
      }),
    }));
  });

  test('records a subscriber received cursor separately from reading', async () => {
    repositories.announcementChannelRepository.markReceived.mockResolvedValue(9);
    const res = makeResponse();

    await getPostHandler('/:channelId/received')({
      familyId: 'family_1',
      params: { channelId: 'ach_1' },
      identity: { identityId: 'subscriber_1', role: 'member' },
      signedRequest: { payload: { sequence: 9 } },
    }, res);

    expect(repositories.announcementChannelRepository.markReceived).toHaveBeenCalledWith({
      familyId: 'family_1', channelId: 'ach_1', identityId: 'subscriber_1', sequence: 9,
    });
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok', result: { channelId: 'ach_1', receivedThrough: 9 },
    });
  });

  test('lets only the channel author inspect per-subscriber engagement', async () => {
    repositories.announcementChannelRepository.findById.mockResolvedValue({
      channel_id: 'ach_1', owner_identity_id: 'owner_1', status: 'active',
    });
    repositories.announcementChannelRepository.findPostById.mockResolvedValue({
      post_id: 'acp_9', channel_id: 'ach_1', post_sequence: 9,
    });
    repositories.announcementChannelRepository.listPostEngagementRecipients.mockResolvedValue([{
      subscription_id: 'subscription_1',
      subscriber_identity_id: 'subscriber_1',
      subscriber_identity_name: 'Reader',
      source_link_id: null,
      subscription_status: 'active',
      received: true,
      viewed: false,
    }]);
    const res = makeResponse();

    await getPostHandler('/:channelId/posts/:postId/engagement')({
      familyId: 'family_1',
      params: { channelId: 'ach_1', postId: 'acp_9' },
      identity: { identityId: 'owner_1', role: 'member' },
      signedRequest: { payload: {} },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        hasMore: false,
        nextCursor: null,
        recipients: [expect.objectContaining({
          subscriberIdentityId: 'subscriber_1', received: true, viewed: false,
        })],
      }),
    }));
    expect(repositories.announcementChannelRepository.listPostEngagementRecipients).toHaveBeenCalledWith({
      familyId: 'family_1',
      channelId: 'ach_1',
      ownerIdentityId: 'owner_1',
      sequence: 9,
      afterSubscriberIdentityId: null,
      limit: 21,
    });

    const forbiddenRes = makeResponse();
    await getPostHandler('/:channelId/posts/:postId/engagement')({
      familyId: 'family_1',
      params: { channelId: 'ach_1', postId: 'acp_9' },
      identity: { identityId: 'subscriber_1', role: 'member' },
      signedRequest: { payload: {} },
    }, forbiddenRes);
    expect(forbiddenRes.status).toHaveBeenCalledWith(404);
  });

  test('returns latest-post activity for all requested channels in one repository call', async () => {
    repositories.announcementChannelRepository.listLatestPostActivity.mockResolvedValue([{
      post_id: 'acp_7',
      channel_id: 'ach_1',
      post_sequence: 7,
      author_identity_id: 'owner_1',
      author_device_id: 'device_1',
      client_post_id: 'client_7',
      client_created_at: 700,
      epoch: 1,
      ciphertext: 'gcm1:ciphertext',
      notification_preview_ciphertext: null,
      author_signature: 'signature',
      author_signed_claim: {},
      revision: 1,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
      edited_at: null,
      deleted_at: null,
      unread_count: 3,
    }]);
    const res = makeResponse();

    await getPostHandler('/posts/activity')({
      familyId: 'family_1',
      identity: { identityId: 'subscriber_1', role: 'member' },
      signedRequest: { payload: { channelIds: ['ach_1', 'ach_1', 'ach_2'] } },
    }, res);

    expect(repositories.announcementChannelRepository.listLatestPostActivity).toHaveBeenCalledWith({
      familyId: 'family_1',
      identityId: 'subscriber_1',
      channelIds: ['ach_1', 'ach_2'],
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        activity: [expect.objectContaining({
          channelId: 'ach_1',
          unreadCount: 3,
          post: expect.objectContaining({ postId: 'acp_7', sequence: 7 }),
        })],
      }),
    }));
  });
});
