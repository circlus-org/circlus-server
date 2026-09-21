jest.mock('../services/reliableOperation', () => ({ reliableOperation: (handler: unknown) => handler }));
jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireFullCircleIdentity: jest.fn((_req, _res, next) => next()),
  requireServerAdmin: jest.fn((_req, _res, next) => next()),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {}),
}));

jest.mock('../db/repositories', () => ({
  familyConfigRepository: {
    findByFamilyId: jest.fn(),
    listWithStats: jest.fn(),
    create: jest.fn(),
    replaceJoinInvite: jest.fn(),
    suspendWithDomain: jest.fn(),
    resumeWithDomain: jest.fn(),
    deleteWithData: jest.fn(),
  },
  familyDomainRepository: {
    findByHost: jest.fn(),
    createPrimaryDomain: jest.fn(),
  },
  identityRepository: {
    findAll: jest.fn(),
    findByIdentityId: jest.fn(),
    count: jest.fn(),
  },
  inviteRepository: {
    create: jest.fn(),
    updateStatus: jest.fn(),
  },
  serverAdminRepository: {
    listActive: jest.fn(),
    listActiveDetailed: jest.fn(),
    listEligibleCandidatesDetailed: jest.fn(),
    findActiveByIdentityId: jest.fn(),
    grantToIdentity: jest.fn(),
    updateDisplayName: jest.fn(),
    revoke: jest.fn(),
  },
  tenantOwnerClaimsRepository: {
    create: jest.fn(),
    revokePending: jest.fn(),
  },
  TenantSuspensionError: class TenantSuspensionError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

jest.mock('../services/configService', () => ({ configService: {} }));
jest.mock('../services/attachmentStorageService', () => ({
  attachmentStorageService: { deleteBlob: jest.fn().mockResolvedValue(undefined) }
}));
jest.mock('../services/publicSiteAssetStorageService', () => ({
  publicSiteAssetStorageService: { deleteAsset: jest.fn().mockResolvedValue(undefined) }
}));
jest.mock('../utils/tenantDomainValidation', () => ({
  validateTenantDomainDns: jest.fn().mockResolvedValue({ ok: true }),
  validateTenantTlsCertificate: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../ws/wsGateway', () => ({
  suspendCircleWsAccess: jest.fn().mockResolvedValue(undefined)
}));

import {
  familyConfigRepository,
  familyDomainRepository,
  identityRepository,
  inviteRepository,
  serverAdminRepository,
  tenantOwnerClaimsRepository
} from '../db/repositories';
import { suspendCircleWsAccess } from '../ws/wsGateway';
import { attachmentStorageService } from '../services/attachmentStorageService';
import { publicSiteAssetStorageService } from '../services/publicSiteAssetStorageService';
import {
  validateTenantDomainDns,
  validateTenantTlsCertificate
} from '../utils/tenantDomainValidation';

const router = require('./serverAdmin').default;

type MockResponse = { status: jest.Mock; json: jest.Mock };

function findRoute(candidate: any, path: string): any {
  for (const item of candidate.stack || []) {
    if (item.route?.path === path) return item;
    const nested = item.handle?.stack ? findRoute(item.handle, path) : null;
    if (nested) return nested;
  }
  return null;
}

function getPostHandler(path: string) {
  const layer = findRoute(router, path);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function makeResponse(): MockResponse {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeReq(payload: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    familyId: 'family_1',
    identity: { identityId: 'current_admin', role: 'member' },
    device: { deviceId: 'device_current' },
    serverAdmin: { serverAdminId: 'sa_current' },
    signedRequest: { payload },
    params: {},
    ...overrides,
  };
}

describe('server administrator provisioning capabilities', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does not expose server-admin owner replacement or recovery claims', () => {
    for (const path of [
      '/tenants/:familyId/owner-recovery/options',
      '/tenants/:familyId/owner-recovery/assign',
      '/tenants/:familyId/owner-recovery/claims',
      '/tenants/:familyId/owner-recovery/create-profile'
    ]) {
      expect(findRoute(router, path)).toBeNull();
    }
  });

  test.each([
    [undefined, false],
    ['https://', false],
    ['circles.example.test', true]
  ])('reports managed wildcard availability from server configuration', async (configuredDomain, expected) => {
    const previousWildcard = process.env.CIRCLE_WILDCARD_BASE_DOMAIN;
    if (configuredDomain === undefined) delete process.env.CIRCLE_WILDCARD_BASE_DOMAIN;
    else process.env.CIRCLE_WILDCARD_BASE_DOMAIN = configuredDomain;
    try {
      (serverAdminRepository.findActiveByIdentityId as jest.Mock).mockResolvedValue({
        server_admin_id: 'sa_current',
        principal_identity_id: 'current_admin',
        granted_at: new Date('2026-01-01T00:00:00Z')
      });
      const res = makeResponse();

      await getPostHandler('/status')(makeReq(), res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'ok',
        result: expect.objectContaining({ managedWildcardAvailable: expected })
      }));
    } finally {
      if (previousWildcard === undefined) delete process.env.CIRCLE_WILDCARD_BASE_DOMAIN;
      else process.env.CIRCLE_WILDCARD_BASE_DOMAIN = previousWildcard;
    }
  });
});

describe('tenant provisioning invites', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creates the initial owner invite as a system invite', async () => {
    (familyDomainRepository.findByHost as jest.Mock).mockResolvedValue(null);
    (familyConfigRepository.create as jest.Mock).mockResolvedValue({ server_name: 'Personal' });
    (familyDomainRepository.createPrimaryDomain as jest.Mock).mockResolvedValue(undefined);
    (inviteRepository.create as jest.Mock).mockResolvedValue(undefined);
    (tenantOwnerClaimsRepository.create as jest.Mock).mockResolvedValue(undefined);
    const res = makeResponse();

    await getPostHandler('/tenants')(
      makeReq({
        serverName: 'Personal',
        addressMode: 'custom',
        publicBaseUrl: 'https://personal.example'
      }),
      res
    );

    expect(inviteRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: 'system',
      maxUses: 1
    }));
    expect(validateTenantDomainDns).toHaveBeenCalled();
    expect(validateTenantTlsCertificate).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  test('requires an explicit Circle URL when managed wildcard provisioning is disabled', async () => {
    const previousWildcard = process.env.CIRCLE_WILDCARD_BASE_DOMAIN;
    delete process.env.CIRCLE_WILDCARD_BASE_DOMAIN;
    try {
      const res = makeResponse();
      await getPostHandler('/tenants')(makeReq({ serverName: 'Personal', addressMode: 'custom' }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({
          code: 'INVALID_REQUEST',
          message: expect.stringContaining('publicBaseUrl is required')
        })
      }));
      expect(familyConfigRepository.create).not.toHaveBeenCalled();
    } finally {
      if (previousWildcard === undefined) delete process.env.CIRCLE_WILDCARD_BASE_DOMAIN;
      else process.env.CIRCLE_WILDCARD_BASE_DOMAIN = previousWildcard;
    }
  });

  test('assigns a unique managed wildcard URL when the administrator omits the Circle URL', async () => {
    const previousWildcard = process.env.CIRCLE_WILDCARD_BASE_DOMAIN;
    process.env.CIRCLE_WILDCARD_BASE_DOMAIN = 'circles.example.test';
    try {
      (familyConfigRepository.create as jest.Mock).mockImplementation(async ({ familyId, serverName, publicBaseUrl }) => ({
        family_id: familyId,
        circle_id: 'circle_generated_1234567890',
        server_name: serverName,
        public_base_url: publicBaseUrl
      }));
      const res = makeResponse();

      await getPostHandler('/tenants')(makeReq({ serverName: 'Personal', addressMode: 'managed' }), res);

      const createParams = (familyConfigRepository.create as jest.Mock).mock.calls[0][0];
      expect(createParams.publicBaseUrl).toBe(`https://${createParams.familyId}.circles.example.test`);
      expect(familyDomainRepository.createPrimaryDomain).toHaveBeenCalledWith(expect.objectContaining({
        familyId: createParams.familyId,
        host: `${createParams.familyId}.circles.example.test`,
        publicBaseUrl: createParams.publicBaseUrl
      }));
      expect(validateTenantDomainDns).not.toHaveBeenCalled();
      expect(validateTenantTlsCertificate).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'ok',
        result: expect.objectContaining({
          circleId: 'circle_generated_1234567890',
          publicBaseUrl: createParams.publicBaseUrl
        })
      }));
    } finally {
      if (previousWildcard === undefined) delete process.env.CIRCLE_WILDCARD_BASE_DOMAIN;
      else process.env.CIRCLE_WILDCARD_BASE_DOMAIN = previousWildcard;
    }
  });

  test('creates another Circle on the current shared origin without DNS or TLS provisioning', async () => {
    (familyConfigRepository.create as jest.Mock).mockImplementation(async ({ familyId, serverName, publicBaseUrl }) => ({
      family_id: familyId,
      circle_id: 'circle_shared_1234567890',
      server_name: serverName,
      public_base_url: publicBaseUrl
    }));
    const res = makeResponse();
    const request = makeReq({
      serverName: 'Second Circle',
      addressMode: 'shared',
      publicBaseUrl: 'https://shared.example.test'
    }, {
      get: (name: string) => name.toLowerCase() === 'host' ? 'shared.example.test' : undefined
    });

    await getPostHandler('/tenants')(request, res);

    expect(familyConfigRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'shared.example.test',
      publicBaseUrl: 'https://shared.example.test'
    }));
    expect(validateTenantDomainDns).not.toHaveBeenCalled();
    expect(validateTenantTlsCertificate).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        circleId: 'circle_shared_1234567890',
        publicBaseUrl: 'https://shared.example.test'
      })
    }));
  });

  test('reissues the owner invite as a system invite', async () => {
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({
      status: 'pending_owner',
      join_invite_id: 'invite_old'
    });
    const res = makeResponse();

    await getPostHandler('/tenants/:familyId/reissue-owner-claim')(
      makeReq({}, { params: { familyId: 'family_target' } }),
      res
    );

    expect(inviteRepository.updateStatus).toHaveBeenCalledWith(
      'family_target',
      'invite_old',
      'revoked'
    );
    expect(inviteRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family_target',
      createdBy: 'system',
      maxUses: 1
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });
});

describe('server administrator Circle cleanup', () => {
  beforeEach(() => jest.clearAllMocks());

  test('allows an administrator to suspend an active Circle without revoking its identities or invites', async () => {
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({
      status: 'active',
      join_invite_id: 'invite_active'
    });
    const res = makeResponse();

    await getPostHandler('/tenants/:familyId/suspend')(
      makeReq({}, { familyId: 'family_admin', params: { familyId: 'family_target' } }),
      res
    );

    expect(familyConfigRepository.suspendWithDomain).toHaveBeenCalledWith({
      familyId: 'family_target',
      requestFamilyId: 'family_admin'
    });
    expect(suspendCircleWsAccess).toHaveBeenCalledWith('family_target');
    expect(tenantOwnerClaimsRepository.revokePending).not.toHaveBeenCalled();
    expect(inviteRepository.updateStatus).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: { familyId: 'family_target', tenantStatus: 'suspended' }
    }));
  });

  test('resumes a suspended Circle with its existing identities and devices', async () => {
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({ status: 'suspended' });
    const res = makeResponse();

    await getPostHandler('/tenants/:familyId/resume')(
      makeReq({}, { familyId: 'family_admin', params: { familyId: 'family_target' } }),
      res
    );

    expect(familyConfigRepository.resumeWithDomain).toHaveBeenCalledWith('family_target');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: { familyId: 'family_target', tenantStatus: 'active' }
    }));
  });

  test('immediately deletes an active Circle only with matching signed confirmation', async () => {
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({ status: 'active' });
    (familyConfigRepository.deleteWithData as jest.Mock).mockResolvedValue({
      attachmentStorageKeys: ['attachments/family_target/file'],
      publicSiteAssetStorageKeys: ['sites/family_target/logo']
    });
    const res = makeResponse();

    await getPostHandler('/tenants/:familyId/delete')(
      makeReq(
        { immediate: true, expectedFamilyId: 'family_target' },
        { params: { familyId: 'family_target' } }
      ),
      res
    );

    expect(identityRepository.count).not.toHaveBeenCalled();
    expect(familyConfigRepository.deleteWithData).toHaveBeenCalledWith('family_target');
    expect(attachmentStorageService.deleteBlob).toHaveBeenCalledWith('attachments/family_target/file');
    expect(publicSiteAssetStorageService.deleteAsset).toHaveBeenCalledWith('sites/family_target/logo');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: { familyId: 'family_target', deleted: true }
    }));
  });

  test('rejects immediate deletion when the signed Circle ID does not match the route', async () => {
    const res = makeResponse();

    await getPostHandler('/tenants/:familyId/delete')(
      makeReq(
        { immediate: true, expectedFamilyId: 'family_other' },
        { params: { familyId: 'family_target' } }
      ),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(familyConfigRepository.findByFamilyId).not.toHaveBeenCalled();
    expect(familyConfigRepository.deleteWithData).not.toHaveBeenCalled();
  });

  test('keeps the legacy guarded delete behavior for requests without immediate mode', async () => {
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({ status: 'active' });
    const res = makeResponse();

    await getPostHandler('/tenants/:familyId/delete')(
      makeReq({}, { params: { familyId: 'family_target' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(familyConfigRepository.deleteWithData).not.toHaveBeenCalled();
  });
});

describe('server administrator Circle summary', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns profile, device and channel counts plus a privacy-safe owner name', async () => {
    const baseTenant = {
      family_id: 'family_named',
      public_base_url: 'https://named.example',
      server_name: 'Named Circle',
      status: 'active',
      owner_identity_id: 'owner_named',
      no_names_on_server: false,
      identity_count: 5,
      active_device_count: 8,
      owner_active_device_count: 2,
      active_channel_count: 3,
      owner_identity_name: 'Alice',
      pending_owner_claim_count: 0,
      current_domain_host: 'named.example',
      current_domain_status: 'active',
      join_invite_token: null,
      join_invite_expires_at: null,
      owner_claim_expires_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      claimed_at: new Date('2026-01-02T00:00:00Z'),
      revoked_at: null,
      last_activity_at: new Date('2026-01-03T00:00:00Z')
    };
    (familyConfigRepository.listWithStats as jest.Mock).mockResolvedValue([
      baseTenant,
      {
        ...baseTenant,
        family_id: 'family_private',
        public_base_url: 'https://private.example',
        no_names_on_server: true
      }
    ]);
    const res = makeResponse();

    await getPostHandler('/tenants/list')(makeReq(), res);

    const response = res.json.mock.calls[0]?.[0];
    expect(response.result.tenants[0]).toEqual(expect.objectContaining({
      identityCount: 5,
      activeDeviceCount: 8,
      activeChannelCount: 3,
      ownerName: null
    }));
    expect(response.result.tenants[1].ownerName).toBeNull();
  });
});

describe('server admin profile management', () => {
  beforeEach(() => jest.clearAllMocks());

  test('lists privacy-safe labels, carrier Circles and active device counts', async () => {
    (serverAdminRepository.listActiveDetailed as jest.Mock).mockResolvedValue([{
      server_admin_id: 'sa_1',
      principal_identity_id: 'identity_1',
      display_name: null,
      identity_name: 'Alice',
      carrier_family_id: 'family_1',
      carrier_circle_name: 'Family',
      active_device_count: 2,
      granted_at: new Date('2026-01-01T00:00:00Z'),
      granted_via: 'bootstrap',
      granted_by_server_admin_id: null,
    }]);

    const res = makeResponse();
    await getPostHandler('/admins/list')(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: { admins: [expect.objectContaining({
        displayName: 'identity_1 · Family',
        carrierFamilyId: 'family_1',
        carrierCircleName: 'Family',
        activeDeviceCount: 2,
      })] }
    }));
  });

  test('offers eligible identities from every active Circle on the server', async () => {
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({ server_name: 'Family' });
    (serverAdminRepository.listEligibleCandidatesDetailed as jest.Mock).mockResolvedValue([
      { family_id: 'family_1', circle_name: 'Family', identity_id: 'member_1', identity_name: 'Bob', role: 'member' },
      { family_id: 'family_2', circle_name: 'Friends', identity_id: 'owner_2', identity_name: 'Alice', role: 'owner' },
    ]);
    (serverAdminRepository.listActive as jest.Mock).mockResolvedValue([]);

    const res = makeResponse();
    await getPostHandler('/admins/candidates')(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        circle: { familyId: 'family_1', name: 'Family' },
        candidates: [
          expect.objectContaining({
            identityId: 'member_1',
            familyId: 'family_1',
            circleName: 'Family',
            defaultDisplayName: 'member_1 · Family'
          }),
          expect.objectContaining({
            identityId: 'owner_2',
            familyId: 'family_2',
            circleName: 'Friends',
            defaultDisplayName: 'owner_2 · Friends'
          })
        ]
      })
    }));
  });

  test('grants access to an active member of the same Circle', async () => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      identity_id: 'member_1', identity_name: 'Bob', role: 'member', status: 'active'
    });
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({ server_name: 'Family', status: 'active' });
    (serverAdminRepository.findActiveByIdentityId as jest.Mock).mockResolvedValue(null);
    (serverAdminRepository.grantToIdentity as jest.Mock).mockResolvedValue({
      server_admin_id: 'sa_new',
      principal_identity_id: 'member_1',
      granted_at: new Date('2026-01-02T00:00:00Z'),
      granted_via: 'admin_grant',
    });

    const res = makeResponse();
    await getPostHandler('/admins/grant')(makeReq({
      familyId: 'family_1',
      identityId: 'member_1',
      displayName: 'Backup admin'
    }), res);

    expect(serverAdminRepository.grantToIdentity).toHaveBeenCalledWith({
      identityId: 'member_1',
      grantedVia: 'admin_grant',
      grantedByServerAdminId: 'sa_current',
      displayName: 'Backup admin',
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  test('grants access to an active member of another active Circle on the server', async () => {
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      identity_id: 'other_circle_identity', identity_name: 'Alice', role: 'owner', status: 'active'
    });
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({ server_name: 'Friends', status: 'active' });
    (serverAdminRepository.findActiveByIdentityId as jest.Mock).mockResolvedValue(null);
    (serverAdminRepository.grantToIdentity as jest.Mock).mockResolvedValue({
      server_admin_id: 'sa_other',
      principal_identity_id: 'other_circle_identity',
      granted_at: new Date('2026-01-02T00:00:00Z'),
      granted_via: 'admin_grant',
    });

    const res = makeResponse();
    await getPostHandler('/admins/grant')(makeReq({
      familyId: 'family_2',
      identityId: 'other_circle_identity'
    }), res);

    expect(identityRepository.findByIdentityId).toHaveBeenCalledWith('family_2', 'other_circle_identity');
    expect(serverAdminRepository.grantToIdentity).toHaveBeenCalledWith(expect.objectContaining({
      identityId: 'other_circle_identity',
      grantedByServerAdminId: 'sa_current'
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({ carrierFamilyId: 'family_2', carrierCircleName: 'Friends' })
    }));
  });

  test('allows the current administrator to revoke their own record', async () => {
    (serverAdminRepository.revoke as jest.Mock).mockResolvedValue({
      server_admin_id: 'sa_current',
      principal_identity_id: 'current_admin',
      revoked_at: new Date('2026-01-03T00:00:00Z'),
    });
    const res = makeResponse();
    await getPostHandler('/admins/:serverAdminId/revoke')(
      makeReq({}, { params: { serverAdminId: 'sa_current' } }),
      res
    );

    expect(serverAdminRepository.revoke).toHaveBeenCalledWith('sa_current');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

});
