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

function request(method = 'GET') {
  return {
    method,
    get: jest.fn((name: string) => {
      if (name.toLowerCase() === 'host') return 'old.example.test';
      if (name.toLowerCase() === 'origin') return 'https://client.example.test';
      return undefined;
    })
  };
}

describe('deleted Circle tenancy tombstones', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (familyDomainRepository.resolveActiveFamily as jest.Mock).mockResolvedValue({ kind: 'not_found' });
    (familyDomainRepository.findDeletedByHost as jest.Mock).mockResolvedValue({
      host: 'old.example.test',
      family_id: '11111111-1111-4111-8111-111111111111',
      public_base_url: 'https://old.example.test',
      extra_trusted_client_origins: ['https://client.example.test'],
      deleted_at: new Date('2026-08-23T12:00:00.000Z')
    });
    (familyDomainRepository.findSuspendedByHost as jest.Mock).mockResolvedValue(null);
  });

  it('returns an explicit permanent-deletion response with CORS', async () => {
    const req = request();
    const res = response();
    const next = jest.fn();

    await tenancyMiddleware(req as any, res as any, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'https://client.example.test'
    );
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({ code: 'CIRCLE_DELETED' })
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows the preflight needed to read the deletion response', async () => {
    const req = request('OPTIONS');
    const res = response();

    await tenancyMiddleware(req as any, res as any, jest.fn());

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
