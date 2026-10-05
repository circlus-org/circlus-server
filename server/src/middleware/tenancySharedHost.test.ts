jest.mock('../db/repositories/familyDomainRepository', () => ({
  familyDomainRepository: {
    resolveActiveFamily: jest.fn(),
    listByHost: jest.fn(),
    findDeletedByHost: jest.fn(),
    findSuspendedByHost: jest.fn()
  }
}));
jest.mock('./security', () => ({ isTrustedClientRequestOrigin: jest.fn() }));

import { familyDomainRepository } from '../db/repositories/familyDomainRepository';
import { isTrustedClientRequestOrigin } from './security';
import { tenancyMiddleware } from './tenancy';

function response() {
  const res = { status: jest.fn(), json: jest.fn(), end: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function request(method: string) {
  return {
    method, path: '/api/config/capabilities', url: '/api/config/capabilities',
    get: jest.fn((name: string) => {
      if (name.toLowerCase() === 'host') return 'shared.example.test';
      if (name.toLowerCase() === 'origin') return 'https://app.example.test';
      return undefined;
    })
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (familyDomainRepository.resolveActiveFamily as jest.Mock).mockResolvedValue({ kind: 'not_found' });
  (familyDomainRepository.listByHost as jest.Mock).mockResolvedValue([
    { family_id: 'family-a', status: 'active' },
    { family_id: 'family-b', status: 'active' }
  ]);
});

test('allows preflight for a trusted origin without selecting a Circle', async () => {
  (isTrustedClientRequestOrigin as jest.Mock).mockImplementation(async (_origin, familyId) => familyId === 'family-b');
  const req = request('OPTIONS');
  const res = response();
  const next = jest.fn();
  await tenancyMiddleware(req as any, res as any, next);
  expect(isTrustedClientRequestOrigin).toHaveBeenCalledWith('https://app.example.test', 'family-b');
  expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://app.example.test');
  expect(res.status).toHaveBeenCalledWith(204);
  expect(next).not.toHaveBeenCalled();
  expect(req).not.toHaveProperty('familyId');
});

test('rejects an untrusted preflight on a shared host', async () => {
  (isTrustedClientRequestOrigin as jest.Mock).mockResolvedValue(false);
  const res = response();
  await tenancyMiddleware(request('OPTIONS') as any, res as any, jest.fn());
  expect(res.status).toHaveBeenCalledWith(403);
});

test('requires an explicit Circle ID for an operation on a shared host', async () => {
  const res = response();
  await tenancyMiddleware(request('GET') as any, res as any, jest.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    error: expect.objectContaining({ code: 'CIRCLE_ID_REQUIRED' })
  }));
  expect(familyDomainRepository.resolveActiveFamily).not.toHaveBeenCalled();
});


test('rejects a missing Circle ID even when this host has only one active Circle', async () => {
  (familyDomainRepository.listByHost as jest.Mock).mockResolvedValue([
    { family_id: 'family-a', status: 'active' }
  ]);
  (familyDomainRepository.resolveActiveFamily as jest.Mock).mockResolvedValue({
    kind: 'found', familyId: 'family-a', circleId: 'circle-a'
  });
  const res = response();
  const next = jest.fn();
  await tenancyMiddleware(request('GET') as any, res as any, next);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    error: expect.objectContaining({ code: 'CIRCLE_ID_REQUIRED' })
  }));
  expect(familyDomainRepository.resolveActiveFamily).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

test('does not select a deleted or suspended Circle without its ID', async () => {
  (familyDomainRepository.resolveActiveFamily as jest.Mock).mockResolvedValue({ kind: 'not_found' });
  const res = response();
  await tenancyMiddleware(request('POST') as any, res as any, jest.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(familyDomainRepository.resolveActiveFamily).not.toHaveBeenCalled();
  expect(familyDomainRepository.findDeletedByHost).not.toHaveBeenCalled();
  expect(familyDomainRepository.findSuspendedByHost).not.toHaveBeenCalled();
});
