import { transaction } from '../db';
import { familyConfigRepository, identityRepository, inviteRepository } from '../db/repositories';

jest.mock('../db', () => ({
  query: jest.fn(),
  transaction: jest.fn()
}));

jest.mock('../../../shared/identityId', () => ({
  deriveIdentityIdFromPublicKey: jest.fn().mockResolvedValue('identity_owner')
}));

jest.mock('../services/circleMembershipStateService', () => ({
  validateCircleMembershipStateTransition: jest.fn().mockReturnValue({ ok: true }),
  appendCircleMembershipState: jest.fn().mockResolvedValue(undefined),
  listCircleMembershipStates: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/circleMembershipProofService', () => ({
  listCircleIdentityAdmissionProofs: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/configService', () => ({
  configService: {
    getResolvedFamilyConfig: jest.fn().mockResolvedValue({
      serverName: 'Test Circle',
      noNamesOnServer: false,
    }),
  },
}));

jest.mock('../services/linkCapabilityService', () => ({
  verifyCapabilityProof: jest.fn().mockReturnValue(true),
}));

jest.mock('../db/repositories', () => ({
  identityRepository: {
    findByPublicKey: jest.fn(),
    findByIdentityId: jest.fn(),
    create: jest.fn()
  },
  deviceRepository: {},
  inviteRepository: {
    findByToken: jest.fn(),
    findByTokenAnyFamily: jest.fn()
  },
  familyConfigRepository: {
    findByFamilyId: jest.fn()
  },
  systemEventRepository: {
    createEventId: jest.fn(),
    insertEvent: jest.fn()
  }
}));

jest.useFakeTimers();
const authRouter = require('./auth').default;

type MockResponse = {
  status: jest.Mock;
  json: jest.Mock;
};

function findRouteLayer(path: string, candidate: any = authRouter): any {
  for (const item of candidate.stack || []) {
    if (item.route?.path === path) return item;
    const nested = item.handle?.stack ? findRouteLayer(path, item.handle) : null;
    if (nested) return nested;
  }
  return null;
}

function getRegisterOwnerHandler() {
  const layer = findRouteLayer('/register-owner');
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function getRegisterHandler() {
  const layer = findRouteLayer('/register');
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function getCheckInviteHandler() {
  const layer = findRouteLayer('/check-invite');
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: MockResponse) => Promise<void>;
}

function makeResponse(): MockResponse {
  const res = {
    status: jest.fn(),
    json: jest.fn()
  };
  res.status.mockReturnValue(res);
  return res;
}

function makeRequest() {
  return {
    familyId: 'family_owner',
    body: {
      inviteToken: 'join_token',
      ownerClaimToken: 'claim_token',
      identityPublicKey: { algorithm: 'ed25519', value: 'public_key' },
      membershipState: {
        claim: {
          payload: {
            vpsId: 'vps-test',
            circleId: 'circle_test_1234567890',
            ownerIdentityId: 'identity_owner',
            members: [{
              identityId: 'identity_owner',
              publicKey: { algorithm: 'ed25519', value: 'public_key' },
              role: 'owner',
            }],
          },
        },
        admission: null,
      },
    }
  };
}

describe('auth register-owner', () => {
  const mockedTransaction = transaction as jest.Mock;

  beforeAll(() => {
    process.env.VPS_ID = 'vps-test';
  });

  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('creates the initial identity as owner and consumes both grants atomically', async () => {
    const future = new Date(Date.now() + 60_000);
    const createdAt = new Date();
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ status: 'pending_owner', circle_id: 'circle_test_1234567890', join_invite_id: 'invite_1', no_names_on_server: false, public_base_url: 'https://circle.example' }] })
        .mockResolvedValueOnce({ rows: [{ invite_id: 'invite_1', status: 'active', used_count: 0, max_uses: 1, expires_at: future, created_by: 'system' }] })
        .mockResolvedValueOnce({ rows: [{ family_id: 'family_owner', status: 'pending', expires_at: future }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ member_count: '0', total_count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ identity_id: 'identity_owner', public_key_algorithm: 'ed25519', public_key_value: 'public_key', encrypted_private_key: null, identity_name: null, created_at: createdAt, status: 'active' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    };
    mockedTransaction.mockImplementationOnce(async (callback: any) => callback(client));

    const res = makeResponse();
    await getRegisterOwnerHandler()(makeRequest(), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        identity: expect.objectContaining({ identityId: 'identity_owner', role: 'owner' })
      })
    }));
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO identities'))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE tenant_owner_claims'))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'active', owner_identity_id"))).toBe(true);
  });

  test('does not create an identity when owner claim has expired', async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ status: 'pending_owner', join_invite_id: 'invite_1' }] })
        .mockResolvedValueOnce({ rows: [{ invite_id: 'invite_1', status: 'active', used_count: 0, max_uses: 1, expires_at: future }] })
        .mockResolvedValueOnce({ rows: [{ family_id: 'family_owner', status: 'pending', expires_at: past }] })
    };
    mockedTransaction.mockImplementationOnce(async (callback: any) => callback(client));

    const res = makeResponse();
    await getRegisterOwnerHandler()(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({ message: 'Claim expired' })
    }));
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO identities'))).toBe(false);
  });

  test('does not permit a pending-owner invite through ordinary registration', async () => {
    const future = new Date(Date.now() + 60_000);
    (identityRepository.findByPublicKey as jest.Mock).mockResolvedValueOnce(null);
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValueOnce(null);
    (inviteRepository.findByToken as jest.Mock).mockResolvedValueOnce({
      invite_id: 'invite_1',
      family_id: 'family_owner',
      created_by: 'system',
      status: 'active',
      used_count: 0,
      max_uses: 1,
      expires_at: future
    });
    (familyConfigRepository.findByFamilyId as jest.Mock).mockResolvedValueOnce({
      status: 'pending_owner',
      join_invite_id: 'invite_1'
    });

    const res = makeResponse();
    const request = makeRequest();
    await getRegisterHandler()({
      familyId: request.familyId,
      body: {
        inviteToken: request.body.inviteToken,
        identityPublicKey: request.body.identityPublicKey
      }
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({
        message: 'Owner invite must be accepted through owner registration'
      })
    }));
    expect(identityRepository.create).not.toHaveBeenCalled();
  });

  test('returns encrypted membership checkpoint bundle for a capability invite', async () => {
    const future = new Date(Date.now() + 60_000);
    const encryptedMembershipCheckpointBundle = { cipher: 'aes-256-gcm', data: 'checkpoint', nonce: 'nonce', version: 1 };
    const descriptor = {
      payload: {
        capabilityId: 'cap_1',
        capabilityPublicKey: { algorithm: 'ed25519', value: 'capability_key' },
        kind: 'circle-invite',
        mode: 'single-use',
        issuerIdentityId: 'member_identity',
        targetIdentityId: 'family_owner',
        expiresAt: future.toISOString(),
        scope: {
          membershipCheckpoint: {
            version: 1,
            sequence: 3,
            stateId: 'cms_state0000003',
            stateHash: 'state_hash',
            ownerIdentityId: 'owner_identity',
          }
        },
      },
    };
    (inviteRepository.findByToken as jest.Mock).mockResolvedValueOnce({
      invite_id: 'invite_1',
      family_id: 'family_owner',
      created_by: 'member_identity',
      status: 'active',
      used_count: 0,
      max_uses: 1,
      expires_at: future,
      capability_mode: 'single-use',
      capability_descriptor: descriptor,
      encrypted_membership_checkpoint_bundle: encryptedMembershipCheckpointBundle,
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      status: 'active',
      public_key_algorithm: 'ed25519',
      public_key_value: 'member_public_key',
    });

    const res = makeResponse();
    await getCheckInviteHandler()({
      familyId: 'family_owner',
      body: {
        capabilityId: 'cap_1',
        proof: { payload: { capabilityId: 'cap_1' } },
      },
      headers: {},
    }, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      result: expect.objectContaining({
        descriptor,
        encryptedMembershipCheckpointBundle,
        issuerPublicKey: { algorithm: 'ed25519', value: 'member_public_key' },
      }),
    }));
  });
});
