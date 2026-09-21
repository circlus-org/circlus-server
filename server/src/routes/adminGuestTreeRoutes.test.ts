const repositories = {
  circleOwnerGuestTreeRepository: { listChildren: jest.fn() },
  identityRepository: { findAll: jest.fn(), findByIdentityId: jest.fn() },
  deviceLifecyclePolicyRepository: { get: jest.fn(), listReviewDevices: jest.fn(), listUnreachableProfiles: jest.fn() },
  deviceRepository: { findByIdentityId: jest.fn() },
};

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../db/repositories', () => repositories);
jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireAdmin: jest.fn((_req, _res, next) => next()),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {}),
}));
jest.mock('../services/versionedAccessOperation', () => ({ versionedAccessOperation: (handler: unknown) => handler }));
jest.mock('../services/circleOwnershipService', () => ({ changeCircleOwnerToExistingIdentity: jest.fn(), CircleOwnershipError: class extends Error {}, deliverCircleOwnerChangedPush: jest.fn() }));
jest.mock('../services/adminDeviceRevocationService', () => ({ revokeDeviceAsAdmin: jest.fn(), AdminDeviceRevocationError: class extends Error {} }));
jest.mock('../services/adminIdentityRemovalService', () => ({ removeIdentityFromCircle: jest.fn(), AdminIdentityRemovalError: class extends Error {} }));
jest.mock('../services/publicSiteGeneratorService', () => ({ publicSiteGeneratorService: {} }));
jest.mock('../services/attachmentStorageService', () => ({ attachmentStorageService: {} }));
jest.mock('../services/publicSiteAssetStorageService', () => ({ publicSiteAssetStorageService: {} }));
jest.mock('../services/identityDeletionService', () => ({ deleteIdentityDataFromCircle: jest.fn(), IdentityDeletionServiceError: class extends Error {} }));
jest.mock('../services/circleMembershipProofService', () => ({ listCircleIdentityAdmissionProofs: jest.fn() }));
jest.mock('../services/circleMembershipStateService', () => ({ listCircleMembershipStates: jest.fn() }));
jest.mock('../services/circleInvitePermissionService', () => ({ setCircleInvitePermission: jest.fn() }));
jest.mock('../services/circleMembershipAdminService', () => ({ setCircleMemberStatus: jest.fn() }));
jest.mock('../services/circleDirectoryNotificationService', () => ({ notifyCircleDirectoryChanged: jest.fn() }));
jest.mock('../services/guestInvitePermissionService', () => ({ setGuestInvitePermission: jest.fn() }));
jest.mock('../services/directGuestAccessService', () => ({
  mapDirectGuestPermissionsFromDb: jest.fn(() => ({ canMessage: true, canCall: false, canDirectFileTransfer: false })),
}));
jest.mock('../ws/wsGateway', () => ({ notifyIdentityServerDataDeleted: jest.fn(), suspendIdentityWsAccess: jest.fn() }));

const router = require('./adminUserRoutes').default;

function handler(path: string) {
  const layer = (router as any).stack.find((item: any) => item.route?.path === path);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('Circle owner guest tree API', () => {
  beforeEach(() => jest.clearAllMocks());

  it('removes connection labels from the owner inactivity report', async () => {
    repositories.deviceLifecyclePolicyRepository.get.mockResolvedValue({
      reviewAfterDays: 30,
      autoRevokeEnabled: false,
      autoRevokeAfterDays: 90,
      warningDays: 7,
    });
    repositories.deviceLifecyclePolicyRepository.listReviewDevices.mockResolvedValue([{
      deviceId: 'device-1',
      identityId: 'member-1',
      label: 'Private phone name',
      status: 'active',
    }]);
    repositories.deviceLifecyclePolicyRepository.listUnreachableProfiles.mockResolvedValue([]);
    const res = response();

    await handler('/devices/inactivity-review')({ familyId: 'family-1' }, res);

    expect(res.json.mock.calls[0][0].result.devices[0]).toEqual(expect.objectContaining({
      deviceId: 'device-1',
      label: null,
    }));
  });

  it('keeps guests out of the member roster and returns only per-host counts', async () => {
    const now = new Date('2026-09-21T10:00:00.000Z');
    repositories.identityRepository.findAll.mockResolvedValue([
      { identity_id: 'owner-1', role: 'owner', status: 'active', public_key_algorithm: 'ed25519', public_key_value: 'owner-key', created_at: now },
      { identity_id: 'guest-1', role: 'guest', status: 'active', public_key_algorithm: 'ed25519', public_key_value: 'guest-key', created_at: now },
    ]);
    require('../services/circleMembershipProofService').listCircleIdentityAdmissionProofs.mockResolvedValue([]);
    require('../services/circleMembershipStateService').listCircleMembershipStates.mockResolvedValue([]);
    const dbQuery = require('../db').query as jest.Mock;
    dbQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ host_identity_id: 'owner-1', active_guest_count: '2' }],
    });
    const res = response();

    await handler('/users')({ familyId: 'family-1' }, res);

    expect(res.json.mock.calls[0][0].result.users).toEqual([
      expect.objectContaining({ identityId: 'owner-1', activeGuestCount: 2 }),
    ]);
  });

  it('returns one host-scoped page with counts and no names or device labels', async () => {
    const now = new Date('2026-09-21T10:00:00.000Z');
    repositories.identityRepository.findByIdentityId.mockResolvedValue({ identity_id: 'host-1', role: 'member', status: 'active' });
    repositories.circleOwnerGuestTreeRepository.listChildren.mockResolvedValue([
      {
        registration_id: 'dgr-1', link_id: 'link-1', host_identity_id: 'host-1', guest_identity_id: 'guest-1',
        guest_public_key_algorithm: 'ed25519', guest_public_key_value: 'guest-key', guest_status: 'active', registration_status: 'active',
        can_create_guest_invites: true, created_at: now, updated_at: now, revoked_at: null, last_seen_at: now,
        active_device_count: 2, revoked_device_count: 1, active_child_guest_count: 3,
      },
    ]);
    const res = response();

    await handler('/guests/children')({
      familyId: 'family-1',
      signedRequest: { payload: { hostIdentityId: 'host-1', limit: 25 } },
    }, res);

    expect(repositories.circleOwnerGuestTreeRepository.listChildren).toHaveBeenCalledWith({
      familyId: 'family-1', hostIdentityId: 'host-1', afterRegistrationId: null, limit: 25, includeInactive: false,
    });
    const payload = res.json.mock.calls[0][0];
    expect(payload.result.guests[0]).toEqual(expect.objectContaining({
      guestIdentityId: 'guest-1', activeConnectionCount: 2, revokedConnectionCount: 1, activeChildGuestCount: 3,
    }));
    expect(payload.result.guests[0]).not.toHaveProperty('identityName');
    expect(payload.result.guests[0]).not.toHaveProperty('deviceLabel');
  });

  it('does not expose guest devices through the member device endpoint', async () => {
    repositories.identityRepository.findByIdentityId.mockResolvedValue({ identity_id: 'guest-1', role: 'guest', status: 'active' });
    const res = response();

    await handler('/users/:identityId/devices')({ familyId: 'family-1', params: { identityId: 'guest-1' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(repositories.deviceRepository.findByIdentityId).not.toHaveBeenCalled();
  });

  it('removes connection labels from owner-visible member device records', async () => {
    const now = new Date('2026-09-21T10:00:00.000Z');
    repositories.identityRepository.findByIdentityId.mockResolvedValue({ identity_id: 'member-1', role: 'member', status: 'active' });
    repositories.deviceRepository.findByIdentityId.mockResolvedValue([{
      device_id: 'device-1', identity_id: 'member-1', public_key_algorithm: 'ed25519', public_key_value: 'device-key',
      label: 'Private phone name', status: 'active', created_at: now, last_seen_at: now,
    }]);
    const res = response();

    await handler('/users/:identityId/devices')({ familyId: 'family-1', params: { identityId: 'member-1' } }, res);

    expect(res.json.mock.calls[0][0].result.devices[0]).toEqual(expect.objectContaining({
      deviceId: 'device-1', label: null,
    }));
  });
});
