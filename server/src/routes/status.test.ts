jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireFullCircleIdentity: jest.fn((req, res, next) => req.identity.role === 'guest'
    ? res.status(403).json({ status: 'error' }) : next()),
  getRequestAuthorization: jest.fn((req) => ({ fullCircleMember: ['owner', 'member'].includes(req.identity.role) })),
  getSignedPayload: jest.fn((req) => req.signedRequest.payload),
}));
jest.mock('../db', () => ({ query: jest.fn(), transaction: jest.fn() }));
jest.mock('../db/repositories', () => ({
  identityRepository: { getStatuses: jest.fn() },
  directGuestRegistrationRepository: { findActiveByPair: jest.fn() },
}));

import router from './status';
import { query } from '../db';
import { directGuestRegistrationRepository, identityRepository } from '../db/repositories';

const seenAt = new Date('2026-09-26T10:00:00Z');
async function request(role: string, identityIds: unknown[]) {
  const req = { familyId: 'circle-a', device: { identityId: 'viewer' }, identity: { role }, signedRequest: { payload: { identityIds } } };
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const route = router.stack.find((layer: any) => layer.route?.path === '/get')!.route;
  for (const layer of route.stack) {
    await layer.handle(req, res, () => {});
    if (res.json.mock.calls.length) break;
  }
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  (query as jest.Mock).mockResolvedValue({ rows: [] });
  (directGuestRegistrationRepository.findActiveByPair as jest.Mock).mockImplementation(async (_circle, _viewer, target) => target === 'host' ? {} : null);
  (identityRepository.getStatuses as jest.Mock).mockImplementation(async (_circle, ids) => new Map(ids.map((id: string) => [id, {
    avatarBlobId: 'private-circle-avatar', presenceVisible: true, isOnline: true,
    lastSeenAt: seenAt, onlineUntil: new Date(seenAt.getTime() + 75_000),
  }])));
});

test('a direct guest receives fresh host presence, without Circle profile metadata', async () => {
  const res = await request('guest', ['host', 'unrelated-member', 'revoked-host', 'other-circle-member', 'host']);
  expect(res.status).not.toHaveBeenCalled();
  expect(identityRepository.getStatuses).toHaveBeenCalledWith('circle-a', ['host']);
  expect(directGuestRegistrationRepository.findActiveByPair).toHaveBeenCalledWith('circle-a', 'viewer', 'host');
  expect(query).not.toHaveBeenCalled();
  expect(res.json.mock.calls[0][0].result.statuses).toEqual({ host: {
    encryptedStatus: null, avatarBlobId: null,
    presence: { visibility: 'visible', isOnline: true, lastSeenAt: seenAt.toISOString(), onlineUntil: '2026-09-26T10:01:15.000Z' },
  } });
});

test('guest-hosts can see guests registered to them', async () => {
  (directGuestRegistrationRepository.findActiveByPair as jest.Mock).mockResolvedValue({ host_identity_id: 'viewer', guest_identity_id: 'child' });
  const res = await request('guest', ['child']);
  expect(res.json.mock.calls[0][0].result.statuses.child.presence.isOnline).toBe(true);
});

test('guest cannot retrieve presence after the pair is revoked', async () => {
  (directGuestRegistrationRepository.findActiveByPair as jest.Mock).mockResolvedValue(null);
  const res = await request('guest', ['host']);
  expect(identityRepository.getStatuses).toHaveBeenCalledWith('circle-a', []);
  expect(res.json.mock.calls[0][0].result.statuses).toEqual({});
});

test('hidden presence remains hidden for a registered guest', async () => {
  (identityRepository.getStatuses as jest.Mock).mockResolvedValue(new Map([['host', {
    avatarBlobId: null, presenceVisible: false, isOnline: false, lastSeenAt: null, onlineUntil: null,
  }]]));
  const res = await request('guest', ['host']);
  expect(res.json.mock.calls[0][0].result.statuses.host.presence).toEqual({
    visibility: 'hidden', isOnline: false, lastSeenAt: null, onlineUntil: null,
  });
});

test.each(['owner', 'member'])('%s retains full Circle status access', async (role) => {
  const res = await request(role, ['member']);
  expect(directGuestRegistrationRepository.findActiveByPair).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalled();
  expect(res.json.mock.calls[0][0].result.statuses.member.avatarBlobId).toBe('private-circle-avatar');
});

test('unrecognized roles cannot read statuses', async () => {
  const res = await request('unknown', ['host']);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(identityRepository.getStatuses).not.toHaveBeenCalled();
});

test('guest batch requests retain the size limit', async () => {
  const res = await request('guest', Array(101).fill('host'));
  expect(res.status).toHaveBeenCalledWith(400);
  expect(directGuestRegistrationRepository.findActiveByPair).not.toHaveBeenCalled();
});
