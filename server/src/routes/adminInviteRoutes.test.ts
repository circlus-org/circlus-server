import { query } from '../db';
import { inviteRepository } from '../db/repositories';

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireAdmin: jest.fn((_req, _res, next) => next())
}));
jest.mock('../db/repositories', () => ({
  inviteRepository: {
    findAll: jest.fn(),
    updateStatus: jest.fn()
  }
}));

const router = require('./adminInviteRoutes').default;

function getPostHandler(path: string) {
  const layer = (router as any).stack.find((item: any) => item.route?.path === path);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('Circle owner invitation journal', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns creator and acceptances without token or private title', async () => {
    const now = new Date();
    (inviteRepository.findAll as jest.Mock).mockResolvedValue([{
      invite_id: 'invite_1',
      token: 'private_token',
      title: 'Private local label',
      created_by: 'member_1',
      created_at: now,
      expires_at: new Date(now.getTime() + 60_000),
      max_uses: 1,
      used_count: 1,
      status: 'exhausted',
      capability_mode: 'single-use'
    }]);
    (query as jest.Mock).mockResolvedValue({
      rows: [{ invite_id: 'invite_1', accepted_by_identity_id: 'member_2', accepted_at: now }]
    });
    const res = response();

    await getPostHandler('/invites')({ familyId: 'family_1' }, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.result.invites[0]).toEqual(expect.objectContaining({
      inviteId: 'invite_1',
      createdBy: 'member_1',
      reusable: false,
      acceptances: [{ identityId: 'member_2', acceptedAt: now.toISOString() }]
    }));
    expect(payload.result.invites[0]).not.toHaveProperty('token');
    expect(payload.result.invites[0]).not.toHaveProperty('title');
  });
});
