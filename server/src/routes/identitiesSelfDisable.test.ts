jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireFullCircleIdentity: jest.fn((_req, _res, next) => next()),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {}),
}));
jest.mock('../middleware/rateLimit', () => ({
  createRateLimiter: jest.fn(() => (_req, _res, next) => next()),
  ipFamilyKey: jest.fn(),
}));
jest.mock('../db/repositories', () => ({
  identityRepository: {}, circleFileAccessRepository: {}, attachmentRepository: {}, familyConfigRepository: {},
  CircleDeleteGuardError: class CircleDeleteGuardError extends Error {},
}));
jest.mock('../services/identityDeletionService', () => ({
  deleteIdentityDataFromCircle: jest.fn(),
  IdentityDeletionServiceError: class IdentityDeletionServiceError extends Error {},
}));
jest.mock('../services/identitySelfDisableService', () => ({ disableOwnCircleIdentity: jest.fn() }));
jest.mock('../services/circleDirectoryNotificationService', () => ({ notifyCircleDirectoryChanged: jest.fn() }));
jest.mock('../ws/wsGateway', () => ({
  notifyIdentityServerDataDeleted: jest.fn(),
  notifyCircleServerDataDeleted: jest.fn(),
  suspendIdentityWsAccess: jest.fn(),
}));
jest.mock('../config/serverRuntimeConfig', () => ({
  ...jest.requireActual('../config/serverRuntimeConfig'),
  getServerIdentityRuntimeConfig: jest.fn(() => ({ vpsId: 'vps-test' }))
}));

import { disableOwnCircleIdentity } from '../services/identitySelfDisableService';
import { notifyCircleDirectoryChanged } from '../services/circleDirectoryNotificationService';
import { suspendIdentityWsAccess } from '../ws/wsGateway';

const router = require('./identities').default;
const disable = disableOwnCircleIdentity as jest.Mock;

const state = {
  claim: {
    signerId: 'member',
    payload: { action: 'remove', subjectIdentityId: 'member', vpsId: 'vps-test', circleId: 'circle-1' }
  },
  admission: null
};

function handler() {
  const route = router.stack.find((item: any) => item.route?.path === '/disable-self');
  return route.route.stack.at(-1).handle as (req: any, res: any) => Promise<void>;
}

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function request(membershipState: unknown = state) {
  return {
    familyId: 'family-1', circleId: 'circle-1',
    device: { identityId: 'member', deviceId: 'device-1' },
    signedRequest: { type: 'identity:disable-self', payload: { membershipState } }
  };
}

describe('self-disable route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    disable.mockResolvedValue('updated');
    (suspendIdentityWsAccess as jest.Mock).mockResolvedValue(undefined);
    (notifyCircleDirectoryChanged as jest.Mock).mockResolvedValue(undefined);
  });

  it('requires a self-signed removal scoped to the current Circle and VPS', async () => {
    for (const candidate of [
      { ...state, claim: { ...state.claim, signerId: 'other' } },
      { ...state, claim: { ...state.claim, payload: { ...state.claim.payload, action: 'restore' } } },
      { ...state, claim: { ...state.claim, payload: { ...state.claim.payload, circleId: 'other' } } },
      { ...state, claim: { ...state.claim, payload: { ...state.claim.payload, vpsId: 'other' } } },
    ]) {
      const res = response();
      await handler()(request(candidate), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(disable).not.toHaveBeenCalled();
  });

  it('cuts off access after a committed removal and reports its result', async () => {
    const res = response();
    await handler()(request(), res);
    expect(disable).toHaveBeenCalledWith({ familyId: 'family-1', identityId: 'member', membershipState: state });
    expect(suspendIdentityWsAccess).toHaveBeenCalledWith('family-1', 'member');
    expect(notifyCircleDirectoryChanged).toHaveBeenCalledWith('family-1', 'membership');
    expect(res.json).toHaveBeenCalledWith({ status: 'ok', result: { identityId: 'member', status: 'disabled' } });
  });
});
