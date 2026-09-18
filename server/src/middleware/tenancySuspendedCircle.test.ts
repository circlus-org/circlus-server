jest.mock('../db/repositories/familyDomainRepository', () => ({
  familyDomainRepository: {
    resolveActiveFamily: jest.fn(),
    findFamilyIdByActiveHost: jest.fn(),
    findDeletedByHost: jest.fn(),
    findSuspendedByHost: jest.fn(),
  }
}));

import { familyDomainRepository } from '../db/repositories/familyDomainRepository';
import { tenancyMiddleware } from './tenancy';

function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    end: jest.fn(),
    setHeader: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

function request(method = 'GET', path = '/api/messages/list') {
  return {
    method,
    path,
    get: jest.fn((name: string) => {
      if (name.toLowerCase() === 'host') return 'paused.example.test';
      if (name.toLowerCase() === 'origin') return 'https://client.example.test';
      return undefined;
    })
  };
}

describe('suspended Circle tenancy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (familyDomainRepository.resolveActiveFamily as jest.Mock).mockResolvedValue({ kind: 'not_found' });
    (familyDomainRepository.findDeletedByHost as jest.Mock).mockResolvedValue(null);
    (familyDomainRepository.findSuspendedByHost as jest.Mock).mockResolvedValue({
      host: 'paused.example.test',
      family_id: '11111111-1111-4111-8111-111111111111',
      circle_id: 'circle-paused',
      public_base_url: 'https://paused.example.test',
      extra_trusted_client_origins: ['https://client.example.test'],
      suspended_at: new Date('2026-08-24T10:00:00.000Z')
    });
  });

  it('returns an explicit temporary suspension response with CORS', async () => {
    const req = request();
    const res = response();
    const next = jest.fn();

    await tenancyMiddleware(req as any, res as any, next);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://client.example.test');
    expect(res.status).toHaveBeenCalledWith(423);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({ code: 'CIRCLE_SUSPENDED' })
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows preflight so the client can recognize suspension', async () => {
    const res = response();
    await tenancyMiddleware(request('OPTIONS') as any, res as any, jest.fn());
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it.each([
    '/api/devices/list',
    '/api/devices/revoke',
    '/api/temporary-access/devices/list',
    '/api/temporary-access/devices/revoke',
    '/api/circle-membership/state',
    '/api/circle-membership/state/append',
    '/api/identities/delete-self',
    '/api/identities/delete-owned-circle'
  ])('passes %s to its signed route with suspended Circle context', async (path) => {
    const req = request('POST', path);
    const res = response();
    const next = jest.fn();

    await tenancyMiddleware(req as any, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req).toMatchObject({
      familyId: '11111111-1111-4111-8111-111111111111',
      circleId: 'circle-paused',
      circleSuspended: true
    });
    expect(res.setHeader).toHaveBeenCalledWith('X-Circlus-Circle-Suspended', '1');
  });

  it.each([
    ['POST', '/api/messages/send'],
    ['POST', '/api/devices/add'],
    ['GET', '/api/devices/list'],
    ['POST', '/api/admin/users/list']
  ])('keeps %s %s blocked', async (method, path) => {
    const res = response();
    const next = jest.fn();
    await tenancyMiddleware(request(method, path) as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(423);
    expect(next).not.toHaveBeenCalled();
  });
});
