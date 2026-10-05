jest.mock('../db/repositories', () => ({ identityRepository: { findByIdentityId: jest.fn() } }));
jest.mock('../utils/crypto', () => ({ verifySignedRequest: jest.fn() }));
jest.mock('../services/identitySelfDisableRecoveryService', () => ({
  getSelfDisableStatus: jest.fn()
}));
jest.mock('../middleware/rateLimit', () => ({
  createRateLimiter: jest.fn(() => (_req, _res, next) => next()), ipFamilyKey: jest.fn()
}));
jest.mock('../config/serverRuntimeConfig', () => ({
  ...jest.requireActual('../config/serverRuntimeConfig'),
  getServerIdentityRuntimeConfig: jest.fn(() => ({ vpsId: 'vps-test' }))
}));

import { identityRepository } from '../db/repositories';
import { verifySignedRequest } from '../utils/crypto';
import { getSelfDisableStatus } from '../services/identitySelfDisableRecoveryService';
const router = require('./identitySelfDisableRecovery').default;

function handler(path: string) {
  return router.stack.find((item: any) => item.route?.path === path).route.stack.at(-1).handle as (req: any, res: any) => Promise<void>;
}
function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}
function request(type: string) {
  return {
    familyId: 'family', circleId: 'circle',
    body: {
      type, signerId: 'old', vpsId: 'vps-test', circleId: 'circle',
      timestamp: Date.now(), nonce: 'nonce', signature: 'signed',
      payload: {}
    }
  };
}

describe('identity-signed self-disable recovery routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ public_key_algorithm: 'ed25519', public_key_value: 'key' });
    (verifySignedRequest as jest.Mock).mockReturnValue(true);
    (getSelfDisableStatus as jest.Mock).mockResolvedValue({ disabled: true, selfDisabled: true, membershipStateId: 'state' });
  });
  it('returns a committed result without a device-signed request', async () => {
    const res = response();
    await handler('/status')(request('identity:self-disable-status'), res);
    expect(getSelfDisableStatus).toHaveBeenCalledWith('family', 'old');
    expect(res.json).toHaveBeenCalledWith({ status: 'ok', result: { disabled: true, selfDisabled: true, membershipStateId: 'state' } });
  });
  it('rejects a forged signature and does not reveal status', async () => {
    (verifySignedRequest as jest.Mock).mockReturnValue(false);
    const res = response();
    await handler('/status')(request('identity:self-disable-status'), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(getSelfDisableStatus).not.toHaveBeenCalled();
  });
});
