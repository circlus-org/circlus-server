jest.mock('../db/repositories', () => ({
  identityRepository: { findByIdentityId: jest.fn() },
  deviceRepository: {}, serverAdminRepository: {}, temporaryDeviceRepository: {}
}));
jest.mock('../config/serverRuntimeConfig', () => ({
  ...jest.requireActual('../config/serverRuntimeConfig'),
  getRateLimitRuntimeConfig: () => ({ communicationIdentity: { windowMs: 60_000, readMax: 2, writeMax: 2 } })
}));

import type { Response } from 'express';
import { requireActiveIdentity, type AuthRequest } from './auth';
import { identityRepository } from '../db/repositories';
import { communicationRequestBudget, createCommunicationIdentityRateLimiter } from './communicationIdentityRateLimit';
import { loadRateLimitRuntimeConfig } from '../config/rateLimitRuntimeConfig';

function request(type: string, overrides: Record<string, unknown> = {}): AuthRequest {
  return {
    familyId: 'circle', ip: '127.0.0.1',
    identity: { identityId: 'alice', status: 'active', role: 'guest' },
    device: { identityId: 'alice', deviceId: 'phone' },
    signedRequest: { type, payload: { identityId: 'untrusted-payload-identity' } },
    ...overrides
  } as unknown as AuthRequest;
}

function response() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    setHeader: jest.fn((name: string, value: string) => { headers[name] = value; }),
    status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis()
  };
  return res as unknown as Response & typeof res;
}

function limiter() {
  return createCommunicationIdentityRateLimiter({ windowMs: 60_000, readMax: 2, writeMax: 2 });
}

test('devices, IPs and chats share the identity budget; reads stay available after mutation exhaustion', () => {
  const limit = limiter();
  const next = jest.fn();
  limit(request('msg:reactions:set'), response(), next);
  limit(request('announcement-channels:notifications', {
    ip: '192.0.2.1', device: { identityId: 'alice', deviceId: 'laptop' }
  }), response(), next);
  const blocked = response();
  limit(request('announcement-channels:reactions:set'), blocked, next);
  expect(next).toHaveBeenCalledTimes(2);
  expect(blocked.status).toHaveBeenCalledWith(429);
  expect(blocked.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'RATE_LIMITED' }) }));
  expect(Number(blocked.headers['Retry-After'])).toBeGreaterThan(0);
  limit(request('announcement-channels:posts:list'), response(), next);
  limit(request('msg:http:list'), response(), next);
  expect(next).toHaveBeenCalledTimes(4);
  const readBlocked = response();
  limit(request('grp:messages:list'), readBlocked, next);
  expect(readBlocked.status).toHaveBeenCalledWith(429);
});

test('identities behind one IP and identities in different circles have independent budgets', () => {
  const limit = limiter();
  const next = jest.fn();
  for (let i = 0; i < 3; i++) limit(request('msg:reactions:set'), response(), next);
  limit(request('msg:reactions:set', {
    identity: { identityId: 'bob' }, device: { identityId: 'bob', deviceId: 'phone' }
  }), response(), next);
  limit(request('msg:reactions:set', { familyId: 'other-circle' }), response(), next);
  expect(next).toHaveBeenCalledTimes(4);
});

test('the budget resets after the window; retries count as requests and do not extend it', () => {
  jest.useFakeTimers();
  try {
    const limit = limiter();
    const next = jest.fn();
    const req = request('announcement-channels:reactions:set');
    for (let i = 0; i < 3; i++) limit(req, response(), next);
    jest.advanceTimersByTime(59_000);
    const blocked = response();
    limit(req, blocked, next);
    expect(blocked.headers['Retry-After']).toBe('1');
    jest.advanceTimersByTime(1_000);
    limit(req, response(), next);
    expect(next).toHaveBeenCalledTimes(3);
  } finally { jest.useRealTimers(); }
});

test('read exhaustion does not consume the mutation budget or block unrelated APIs', () => {
  const limit = limiter();
  const next = jest.fn();
  for (let i = 0; i < 3; i++) limit(request('announcement-channels:reactions:list'), response(), next);
  limit(request('announcement-channels:unsubscribe'), response(), next);
  limit(request('devices:list'), response(), next);
  expect(next).toHaveBeenCalledTimes(4);
});

test.each(['guest', 'member', 'owner'])('technical protection applies to role %s', role => {
  const limit = limiter();
  const next = jest.fn();
  for (let i = 0; i < 3; i++) limit(request('announcement-channels:reactions:set', {
    identity: { identityId: 'alice', role }
  }), response(), next);
  expect(next).toHaveBeenCalledTimes(2);
});

test('a missing or mismatched authenticated identity fails closed without consuming another identity budget', () => {
  const limit = limiter();
  const next = jest.fn();
  for (const overrides of [{ identity: undefined }, { familyId: undefined }, { device: { identityId: 'bob' } }]) {
    const res = response();
    limit(request('msg:reactions:set', overrides), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  }
  expect(next).not.toHaveBeenCalled();
  limit(request('msg:reactions:set'), response(), next);
  expect(next).toHaveBeenCalledTimes(1);
});

test.each([
  'announcement-channels:read', 'announcement-channels:received', 'announcement-channels:subscribe',
  'announcement-channels:keys:claim', 'msg:http:status', 'msg:http:sync-ack',
  'grp:messages:read', 'grp:keys:claim-or-publish', 'announcement-channels:future-operation'
])('%s is a mutation even when it accompanies reading', type => {
  expect(communicationRequestBudget(type)).toBe('write');
});

test('active identity middleware actually enforces the shared limiter using the database identity', async () => {
  (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ identity_id: 'integration-user', status: 'active', role: 'guest' });
  const next = jest.fn();
  for (let i = 0; i < 3; i++) {
    const res = response();
    await requireActiveIdentity(request('announcement-channels:reactions:set', {
      identity: undefined, device: { identityId: 'integration-user', deviceId: `device-${i}` }
    }), res, next);
    if (i === 2) expect(res.status).toHaveBeenCalledWith(429);
  }
  expect(next).toHaveBeenCalledTimes(2);
  await requireActiveIdentity(request('announcement-channels:posts:list', {
    identity: undefined, device: { identityId: 'integration-user', deviceId: 'reader' }
  }), response(), next);
  expect(next).toHaveBeenCalledTimes(3);
});

test('communication limits have documented defaults and support server configuration', () => {
  expect(loadRateLimitRuntimeConfig({}).communicationIdentity).toEqual({ windowMs: 60_000, readMax: 600, writeMax: 240 });
  expect(loadRateLimitRuntimeConfig({
    RATE_LIMIT_COMMUNICATION_IDENTITY_WINDOW_MS: '120000',
    RATE_LIMIT_COMMUNICATION_IDENTITY_READ_MAX: '800',
    RATE_LIMIT_COMMUNICATION_IDENTITY_WRITE_MAX: '300'
  }).communicationIdentity).toEqual({ windowMs: 120_000, readMax: 800, writeMax: 300 });
  expect(() => loadRateLimitRuntimeConfig({ RATE_LIMIT_COMMUNICATION_IDENTITY_WRITE_MAX: '0' })).toThrow();
});
