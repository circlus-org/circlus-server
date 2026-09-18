jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireFullCircleIdentity: jest.fn((_req, _res, next) => next()),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {}),
}));

jest.mock('../db/repositories', () => ({
  circleOwnerRecoveryRepository: { findByTokenHash: jest.fn() },
  familyConfigRepository: { findByFamilyId: jest.fn() },
  identityRepository: { findByRole: jest.fn(), updateRole: jest.fn() },
  inviteRepository: { findById: jest.fn(), updateStatus: jest.fn() },
  serverAdminRepository: { findById: jest.fn(), listActive: jest.fn(), grantToIdentity: jest.fn() },
  tenantOwnerClaimsRepository: { findByTokenHash: jest.fn(), markUsed: jest.fn() },
}));

jest.mock('../services/circleOwnershipService', () => ({
  CircleOwnershipError: class CircleOwnershipError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
  recoverCircleOwnerWithNewIdentity: jest.fn(),
  deliverCircleOwnerChangedPush: jest.fn(),
}));

import {
  circleOwnerRecoveryRepository,
  familyConfigRepository,
  serverAdminRepository
} from '../db/repositories';
import {
  deliverCircleOwnerChangedPush,
  recoverCircleOwnerWithNewIdentity
} from '../services/circleOwnershipService';

const router = require('./tenantOwnerClaims').default;

type MockResponse = { status: jest.Mock; json: jest.Mock };

function getPostHandler(path: string) {
  const layer = (router as any).stack.find((item: any) => item.route?.path === path);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function makeResponse(): MockResponse {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

const activeClaim = {
  claim_id: 'claim_1',
  family_id: 'family_1',
  token_hash: 'hash',
  expected_owner_identity_id: 'owner_old',
  created_by_server_admin_id: 'sa_1',
  created_authorization: { signerId: 'admin_device' },
  status: 'pending',
  expires_at: new Date('2099-01-01T00:00:00Z'),
};

describe('tenant owner recovery claims', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects a link after the Circle owner has changed', async () => {
    (circleOwnerRecoveryRepository.findByTokenHash as jest.Mock).mockResolvedValue(activeClaim);
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValue({
      owner_identity_id: 'owner_new',
      server_name: 'Family',
    });
    const res = makeResponse();

    await getPostHandler('/recovery-claims/inspect')(
      { familyId: 'family_1', body: { claimToken: 'secret' } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'OWNER_CHANGED' }),
    }));
  });

  test('redeems only through the claim-pinned server-admin authorization', async () => {
    const acceptance = { type: 'circle-owner:recovery:accept', signerId: 'identity_new' };
    (circleOwnerRecoveryRepository.findByTokenHash as jest.Mock).mockResolvedValue(activeClaim);
    (serverAdminRepository.findById as jest.Mock).mockResolvedValue({
      server_admin_id: 'sa_1',
      principal_identity_id: 'admin_identity',
    });
    (recoverCircleOwnerWithNewIdentity as jest.Mock).mockResolvedValue({
      changeId: 'change_1',
      recipients: ['owner_old', 'identity_new'],
    });
    const res = makeResponse();

    await getPostHandler('/recovery-claims/redeem')(
      { familyId: 'family_1', body: { claimToken: 'secret', acceptance } },
      res
    );

    expect(recoverCircleOwnerWithNewIdentity).toHaveBeenCalledWith(expect.objectContaining({
      familyId: 'family_1',
      expectedOwnerIdentityId: 'owner_old',
      acceptance,
      initiatedByIdentityId: 'admin_identity',
      initiatedByDeviceId: 'admin_device',
      initiatedByServerAdminId: 'sa_1',
      signedAuthorization: activeClaim.created_authorization,
      recoveryClaim: expect.objectContaining({ claimId: 'claim_1' }),
    }));
    expect(deliverCircleOwnerChangedPush).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });
});
