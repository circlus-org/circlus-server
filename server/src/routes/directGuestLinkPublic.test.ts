import { configService } from '../services/configService';
import {
  announcementChannelRepository,
  directGuestLinkRepository,
  directGuestPublicRepository,
  identityRepository
} from '../db/repositories';

jest.mock('../../../shared/identityId', () => ({
  deriveIdentityIdFromPublicKey: jest.fn().mockResolvedValue('guest_identity')
}));

jest.mock('../services/configService', () => ({
  configService: {
    getResolvedFamilyConfig: jest.fn(),
    getFamilyConfig: jest.fn()
  }
}));

jest.mock('../services/directGuestAccessService', () => ({
  mapDirectGuestPermissionsFromDb: jest.fn().mockReturnValue({
    canMessage: true,
    canCall: false,
    canDirectFileTransfer: false
  })
}));

jest.mock('../services/linkCapabilityService', () => ({
  verifyCapabilityProof: jest.fn(() => true)
}));

jest.mock('../utils/crypto', () => ({
  verifySignedRequest: jest.fn(() => true)
}));

jest.mock('../services/publicSiteGeneratorService', () => ({
  publicSiteGeneratorService: {
    regenerateSite: jest.fn()
  }
}));

const capabilityId = 'cap_123456789012345678901234';
const capabilityDescriptor = {
  payload: {
    kind: 'direct-guest-link',
    capabilityId,
    issuerIdentityId: 'host_identity',
    targetIdentityId: 'host_identity',
    scope: {}
  }
};

jest.mock('../db/repositories', () => ({
  announcementChannelRepository: {
    findByLink: jest.fn()
  },
  deviceRepository: {
    findByPublicKey: jest.fn(),
    findByDeviceId: jest.fn()
  },
  directGuestLinkRepository: {
    findById: jest.fn(),
    revokeIfExhausted: jest.fn(),
    getDefaults: jest.fn()
  },
  directGuestPublicRepository: {
    findExistingGuestIdentityDeviceAndRegistration: jest.fn(),
    createGuestIdentityDeviceAndRegistration: jest.fn()
  },
  identityRepository: {
    findByIdentityId: jest.fn(),
    findByPublicKey: jest.fn()
  }
}));

const directGuestLinkPublicRouter = require('./directGuestLinkPublic').default;

type MockResponse = {
  status: jest.Mock;
  json: jest.Mock;
};

function getHandler(path: string) {
  const layer = (directGuestLinkPublicRouter as any).stack.find((item: any) => item.route?.path === path);
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

const capabilityProof = { payload: { claimId: 'claim_1' } };
const guestAcceptance = {
  type: 'direct-guest:acceptance',
  signerId: 'guest_identity',
  payload: {
    version: 2,
    purpose: 'circlus-direct-guest-acceptance-v2',
    capabilityId,
    claimId: 'claim_1',
    identityPublicKey: { algorithm: 'ed25519', value: 'guest_public_key' },
    capabilityProof,
  },
};

function capableLink(fields: Record<string, unknown>) {
  return { capability_id: capabilityId, capability_descriptor: capabilityDescriptor, ...fields };
}

function acceptBody(fields: Record<string, unknown>) {
  const identityPublicKey = (fields.identityPublicKey || { algorithm: 'ed25519', value: 'guest_public_key' }) as any;
  const deviceId = String(fields.deviceId || 'device-existing123');
  const devicePublicKey = (fields.devicePublicKey || { algorithm: 'ed25519', value: 'device_public_key' }) as any;
  const deviceEncryptionPublicKey = (fields.deviceEncryptionPublicKey || { algorithm: 'x25519', value: 'device_encryption_key' }) as any;
  const deviceKeyBinding = fields.deviceKeyBinding || {
    type: 'device:key-binding',
    signerId: deviceId,
    payload: {
      version: 1,
      purpose: 'device-key-binding-v1',
      identityId: 'guest_identity',
      devicePublicKey,
      deviceEncryptionPublicKey,
    },
    signature: 'device-binding-signature',
  };
  const deviceRegistration = fields.deviceRegistration || {
    type: 'auth:register-device',
    signerId: 'guest_identity',
    vpsId: 'vps-test',
    circleId: 'circle-1',
    payload: {
      deviceId,
      devicePublicKey,
      deviceEncryptionPublicKey,
      deviceKeyBinding,
      encryptedPhysicalDeviceId: null,
    },
    signature: 'device-registration-signature',
  };
  return {
    linkId: 'link_1',
    identityPublicKey,
    deviceId,
    devicePublicKey,
    deviceEncryptionPublicKey,
    ...fields,
    capabilityId,
    capabilityProof,
    guestAcceptance,
    deviceKeyBinding,
    deviceRegistration,
    encryptedPhysicalDeviceId: null
  };
}

function resolveBody() {
  return { linkId: 'link_1', capabilityId, proof: capabilityProof };
}

function resetDirectGuestLinkPublicMocks() {
  jest.resetAllMocks();
  require('../../../shared/identityId').deriveIdentityIdFromPublicKey.mockResolvedValue('guest_identity');
  require('../services/linkCapabilityService').verifyCapabilityProof.mockReturnValue(true);
  require('../utils/crypto').verifySignedRequest.mockReturnValue(true);
  require('../services/directGuestAccessService').mapDirectGuestPermissionsFromDb.mockReturnValue({
    canMessage: true,
    canCall: false,
    canDirectFileTransfer: false
  });
}

describe('direct guest public accept', () => {
  beforeEach(() => {
    process.env.VPS_ID = 'vps-test';
    resetDirectGuestLinkPublicMocks();
  });

  test('rejects member-hosted links when the host lacks guest-invite permission', async () => {
    (directGuestLinkRepository.findById as jest.Mock).mockResolvedValueOnce(capableLink({
      link_id: 'link_1',
      host_identity_id: 'host_identity',
      secret_hash: 'secret_hash',
      status: 'active',
      max_uses: null
    }));
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce({
      role: 'member',
      status: 'active',
      can_create_guest_invites: false
    });

    const res = makeResponse();
    await getHandler('/accept')({
      familyId: 'family_1',
      circleId: 'circle-1',
      body: acceptBody({
        linkId: 'link_1',
        identityPublicKey: { algorithm: 'ed25519', value: 'guest_public_key' },
        deviceId: 'device-existing123',
        devicePublicKey: { algorithm: 'ed25519', value: 'device_public_key' }
      })
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(directGuestPublicRepository.createGuestIdentityDeviceAndRegistration).not.toHaveBeenCalled();
  });

  test('rejects links hosted by a suspended identity', async () => {
    (directGuestLinkRepository.findById as jest.Mock).mockResolvedValueOnce(capableLink({
      link_id: 'link_1',
      host_identity_id: 'host_identity',
      secret_hash: 'secret_hash',
      status: 'active',
      max_uses: null
    }));
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce({
      role: 'member',
      status: 'disabled'
    });

    const res = makeResponse();
    await getHandler('/accept')({
      familyId: 'family_1',
      circleId: 'circle-1',
      body: acceptBody({
        linkId: 'link_1',
        identityPublicKey: { algorithm: 'ed25519', value: 'guest_public_key' },
        deviceId: 'device-existing123',
        devicePublicKey: { algorithm: 'ed25519', value: 'device_public_key' }
      })
    }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(directGuestPublicRepository.createGuestIdentityDeviceAndRegistration).not.toHaveBeenCalled();
  });

  test('returns an existing active registration when a consumed link is retried with the same keys', async () => {
    const createdAt = new Date();
    (directGuestLinkRepository.findById as jest.Mock).mockResolvedValueOnce(capableLink({
      link_id: 'link_1',
      host_identity_id: 'host_identity',
      secret_hash: 'secret_hash',
      status: 'revoked',
      max_uses: 1
    }));
    (directGuestPublicRepository.findExistingGuestIdentityDeviceAndRegistration as jest.Mock).mockResolvedValueOnce({
      identity: {
        identity_id: 'guest_identity',
        public_key_algorithm: 'ed25519',
        public_key_value: 'guest_public_key',
        encrypted_private_key: null,
        created_at: createdAt,
        status: 'active',
        role: 'guest'
      },
      device: {
        device_id: 'device-existing123',
        identity_id: 'guest_identity',
        public_key_algorithm: 'ed25519',
        public_key_value: 'device_public_key',
        encryption_public_key_algorithm: 'x25519',
        encryption_public_key_value: 'device_encryption_key',
        created_at: createdAt,
        status: 'active'
      },
      registration: {
        registration_id: 'registration_1'
      }
    });
    (configService.getResolvedFamilyConfig as jest.Mock).mockResolvedValueOnce({
      serverName: 'My Circle',
      noNamesOnServer: false,
      config: { public_base_url: 'https://circle.example' }
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce({
      identity_name: 'Host',
      status: 'active',
      public_key_algorithm: 'ed25519',
      public_key_value: 'host_public_key'
    });

    const res = makeResponse();
    await getHandler('/accept')({
      familyId: 'family_1',
      circleId: 'circle-1',
      body: acceptBody({
        linkId: 'link_1',
        identityPublicKey: { algorithm: 'ed25519', value: 'guest_public_key' },
        deviceId: 'device-existing123',
        devicePublicKey: { algorithm: 'ed25519', value: 'device_public_key' },
        deviceEncryptionPublicKey: { algorithm: 'x25519', value: 'device_encryption_key' }
      })
    }, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(directGuestPublicRepository.createGuestIdentityDeviceAndRegistration).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        registrationId: 'registration_1',
        hostIdentityName: null,
        identity: expect.objectContaining({ identityId: 'guest_identity' }),
        device: expect.objectContaining({ deviceId: 'device-existing123' })
      })
    }));
    const response = res.json.mock.calls[0][0];
    expect(response.result).not.toHaveProperty('serverName');
    expect(response.result).not.toHaveProperty('circleId');
    expect(response.result).not.toHaveProperty('membershipState');
    expect(response.result).not.toHaveProperty('membershipStates');
    expect(response.result).not.toHaveProperty('membershipProofs');
  });
});

describe('direct guest public resolve', () => {
  beforeEach(() => {
    resetDirectGuestLinkPublicMocks();
  });

  test('never exposes the private link label and uses only public presentation data', async () => {
    (directGuestLinkRepository.findById as jest.Mock).mockResolvedValueOnce(capableLink({
      link_id: 'link_1',
      host_identity_id: 'host_identity',
      secret_hash: 'secret_hash',
      status: 'active',
      title: 'Private campaign label',
      presentation_title: null,
      presentation_description: null,
      presentation_image_url: null,
    }));
    (directGuestLinkRepository.getDefaults as jest.Mock).mockResolvedValueOnce({
      presentation_title: 'Public invitation title',
      presentation_description: 'Public description',
      presentation_image_url: null,
    });
    (configService.getResolvedFamilyConfig as jest.Mock).mockResolvedValueOnce({
      serverName: 'Private Circle',
      noNamesOnServer: false,
      membersCanUseGuestServerAttachments: true,
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce({
      role: 'owner',
      status: 'active',
      publish_identity: false,
      identity_name: 'Private Host Name',
      public_key_algorithm: 'ed25519',
      public_key_value: 'host_public_key',
    });

    const res = makeResponse();
    await getHandler('/resolve')({
      familyId: 'family_1',
      body: resolveBody(),
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        hostIdentityName: null,
        hostIdentityId: 'host_identity',
        presentation: expect.objectContaining({
          title: 'Public invitation title',
          description: 'Public description',
        }),
      }),
    }));
    const response = res.json.mock.calls[0][0];
    expect(response.result).not.toHaveProperty('title');
    expect(response.result).not.toHaveProperty('serverName');
    expect(response.result).not.toHaveProperty('membershipStates');
    expect(response.result).not.toHaveProperty('membershipProofs');
    expect(JSON.stringify(response.result)).not.toContain('Private campaign label');
  });

  test('hides links hosted by a suspended identity', async () => {
    (directGuestLinkRepository.findById as jest.Mock).mockResolvedValueOnce(capableLink({
      link_id: 'link_1',
      host_identity_id: 'host_identity',
      secret_hash: 'secret_hash',
      status: 'active'
    }));
    (configService.getResolvedFamilyConfig as jest.Mock).mockResolvedValueOnce({
      membersCanUseGuestServerAttachments: true
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce({
      role: 'member',
      status: 'disabled'
    });

    const res = makeResponse();
    await getHandler('/resolve')({
      familyId: 'family_1',
      body: resolveBody()
    }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(directGuestLinkRepository.getDefaults).not.toHaveBeenCalled();
  });

  test('returns the host name when the identity is explicitly published', async () => {
    (directGuestLinkRepository.findById as jest.Mock).mockResolvedValueOnce(capableLink({
      link_id: 'link_1',
      host_identity_id: 'host_identity',
      secret_hash: 'secret_hash',
      status: 'active',
      title: 'Public guest link title',
    }));
    (directGuestLinkRepository.getDefaults as jest.Mock).mockResolvedValueOnce(null);
    (configService.getResolvedFamilyConfig as jest.Mock).mockResolvedValueOnce({
      serverName: 'Private Circle',
      noNamesOnServer: false,
      membersCanUseGuestServerAttachments: true,
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce({
      role: 'owner',
      status: 'active',
      publish_identity: true,
      identity_name: 'Published Host',
      public_key_algorithm: 'ed25519',
      public_key_value: 'host_public_key',
    });

    const res = makeResponse();
    await getHandler('/resolve')({
      familyId: 'family_1',
      body: resolveBody(),
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ hostIdentityName: null }),
    }));
  });

  test('returns an attached active channel for a channel invitation', async () => {
    (directGuestLinkRepository.findById as jest.Mock).mockResolvedValueOnce(capableLink({
      link_id: 'link_1',
      host_identity_id: 'host_identity',
      secret_hash: 'secret_hash',
      status: 'active',
      auto_subscribe_to_channel: true,
      capability_descriptor: {
        ...capabilityDescriptor,
        payload: {
          ...capabilityDescriptor.payload,
          scope: { channelId: 'ach_1' },
        },
      },
    }));
    (directGuestLinkRepository.getDefaults as jest.Mock).mockResolvedValueOnce(null);
    (configService.getResolvedFamilyConfig as jest.Mock).mockResolvedValueOnce({
      noNamesOnServer: false,
      membersCanUseGuestServerAttachments: true,
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce({
      role: 'owner',
      status: 'active',
      publish_identity: false,
      public_key_algorithm: 'ed25519',
      public_key_value: 'host_public_key',
    });
    (announcementChannelRepository.findByLink as jest.Mock).mockResolvedValueOnce({
      channel_id: 'ach_1',
      title: 'Updates',
      description: 'Circle news',
      status: 'active',
    });

    const res = makeResponse();
    await getHandler('/resolve')({
      familyId: 'family_1',
      body: resolveBody(),
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        channelInvitation: {
          channelId: 'ach_1',
          title: 'Updates',
          description: 'Circle news',
        },
      }),
    }));
  });
});
