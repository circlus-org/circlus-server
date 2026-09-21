jest.mock('../services/reliableOperation', () => ({ reliableOperation: (handler: unknown) => handler }));
import { inviteRepository, identityRepository, systemEventRepository } from '../db/repositories';

jest.mock('../db', () => ({
  query: jest.fn(),
  transaction: jest.fn(async (work) => work({})),
  inTransactionContext: jest.fn(async (_client, work) => work())
}));

jest.mock('../ws/wsGateway', () => ({ sendToIdentityWs: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  requireAdmin: jest.fn((_req, _res, next) => next()),
  getRequestAuthorization: jest.fn((req) => ({
    createCircleInvites: req.identity?.role === 'owner' || req.identity?.canCreateInvites === true
  })),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {})
}));

jest.mock('../db/repositories', () => ({
  inviteRepository: {
    create: jest.fn(),
    findById: jest.fn(),
    findByCreator: jest.fn(),
    revokeOwnedInvite: jest.fn()
  },
  identityRepository: {
    findByIdentityId: jest.fn()
  },
  systemEventRepository: {
    createEventId: jest.fn(() => 'event-1'),
    insertEvent: jest.fn()
  }
}));

jest.mock('../services/linkCapabilityService', () => ({
  verifyCapabilityDescriptor: jest.fn(() => true),
  verifyCapabilityRevocation: jest.fn(() => true)
}));

const invitesRouter = require('./invites').default;

type MockResponse = {
  status: jest.Mock;
  json: jest.Mock;
};

function getPostHandler(path: string) {
  const layer = (invitesRouter as any).stack.find((item: any) => item.route?.path === path);
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

function makeGuestRequest(payload: Record<string, unknown> = {}) {
  return {
    familyId: 'family_1',
    identity: { role: 'guest' },
    device: { identityId: 'guest_identity' },
    signedRequest: { payload }
  };
}

function makeMemberRequest(canCreateInvites: boolean, payload: Record<string, unknown> = {}) {
  return {
    familyId: 'family_1',
    identity: { role: 'member', canCreateInvites },
    device: { identityId: 'member_identity' },
    signedRequest: { payload }
  };
}

function makeOwnerRequest(payload: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  return {
    familyId: 'family_1',
    identity: { role: 'owner' },
    device: { identityId: 'owner_identity' },
    params,
    signedRequest: { payload }
  };
}

describe('invites guest restrictions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reports no invite quota for guests', async () => {
    const res = makeResponse();

    await getPostHandler('/status')(makeGuestRequest(), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(identityRepository.findByIdentityId).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      result: {
        canCreate: false,
        unlimited: false,
        remaining: 0
      }
    });
  });

  test('does not allow guests to create circle invites', async () => {
    const res = makeResponse();

    await getPostHandler('/create')(makeGuestRequest(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(inviteRepository.create).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({
        code: 'FORBIDDEN',
        message: 'Invitation creation permission required'
      })
    }));
  });

  test('does not allow a member without invitation permission to create invites', async () => {
    const res = makeResponse();

    await getPostHandler('/create')(makeMemberRequest(false), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(inviteRepository.create).not.toHaveBeenCalled();
  });

  test('allows an authorized member to create an unlimited invite', async () => {
    const res = makeResponse();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const descriptor = {
      payload: {
        capabilityId: 'cap_1',
        capabilityPublicKey: { algorithm: 'ed25519', value: 'capability_key' },
        mode: 'unlimited',
        expiresAt,
        scope: {
          membershipCheckpoint: {
            version: 1,
            sequence: 7,
            stateId: 'cms_state0000007',
            stateHash: 'state_hash',
            ownerIdentityId: 'owner_identity'
          }
        }
      }
    };
    const encryptedMembershipCheckpointBundle = { cipher: 'aes-256-gcm', data: 'checkpoint', nonce: 'nonce2', version: 1 };
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      public_key_algorithm: 'ed25519',
      public_key_value: 'member_public_key'
    });
    (inviteRepository.create as jest.Mock).mockResolvedValue({
      invite_id: 'invite_1',
      token: 'cap_1',
      created_by: 'member_identity',
      created_at: new Date(),
      accepted_by_identity_id: null,
      accepted_by_public_key: null,
      accepted_at: null,
      expires_at: new Date(expiresAt),
      max_uses: 2147483647,
      used_count: 0,
      status: 'active',
      capability_id: 'cap_1',
      capability_mode: 'unlimited',
      capability_descriptor: descriptor,
      encrypted_secret: { cipher: 'aes-256-gcm', data: 'data', nonce: 'nonce', version: 1 },
      encrypted_membership_checkpoint_bundle: encryptedMembershipCheckpointBundle
    });

    await getPostHandler('/create')(makeMemberRequest(true, {
      mode: 'unlimited',
      expiresAt,
      capabilityDescriptor: descriptor,
      encryptedSecret: { cipher: 'aes-256-gcm', data: 'data', nonce: 'nonce', version: 1 },
      encryptedMembershipCheckpointBundle
    }), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(inviteRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: 'member_identity',
      maxUses: 2147483647,
      encryptedMembershipCheckpointBundle
    }));
  });

  test('requires encrypted membership checkpoint bundle when descriptor carries checkpoint', async () => {
    const res = makeResponse();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const descriptor = {
      payload: {
        capabilityId: 'cap_1',
        capabilityPublicKey: { algorithm: 'ed25519', value: 'capability_key' },
        mode: 'single-use',
        expiresAt,
        scope: {
          membershipCheckpoint: {
            version: 1,
            sequence: 7,
            stateId: 'cms_state0000007',
            stateHash: 'state_hash',
            ownerIdentityId: 'owner_identity'
          }
        }
      }
    };
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      public_key_algorithm: 'ed25519',
      public_key_value: 'member_public_key'
    });

    await getPostHandler('/create')(makeMemberRequest(true, {
      mode: 'single-use',
      expiresAt,
      capabilityDescriptor: descriptor,
      encryptedSecret: { cipher: 'aes-256-gcm', data: 'data', nonce: 'nonce', version: 1 }
    }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(inviteRepository.create).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({
        code: 'INVALID_REQUEST',
        message: 'Invite membership checkpoint bundle is required'
      })
    }));
  });

  test('delivers a directed single-use invitation only to its active guest', async () => {
    const { query } = require('../db');
    const { sendToIdentityWs } = require('../ws/wsGateway');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const descriptor = { payload: {
      capabilityId: 'cap_guest', mode: 'single-use', expiresAt,
      scope: { membershipCheckpoint: {}, guestRegistrationId: 'registration-1',
        guestIdentityId: 'guest-1', guestPublicKey: 'guest-key' }
    } };
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      public_key_algorithm: 'ed25519', public_key_value: 'host-key'
    });
    query.mockImplementation(async (sql: string) => ({ rows: String(sql).includes('FROM direct_guest_registrations')
      ? [{ public_key_algorithm: 'ed25519', public_key_value: 'guest-key' }]
      : [{ circle_id: 'circle-1' }] }));
    (inviteRepository.create as jest.Mock).mockResolvedValue({
      invite_id: 'invite-1', token: 'cap_guest', created_by: 'owner_identity',
      created_at: new Date(), accepted_by_identity_id: null, accepted_by_public_key: null,
      accepted_at: null, expires_at: new Date(expiresAt), max_uses: 1, used_count: 0, status: 'active'
    });
    const response = makeResponse();
    await getPostHandler('/create')(makeOwnerRequest({
      mode: 'single-use', expiresAt, capabilityDescriptor: descriptor,
      encryptedSecret: { cipher: 'aes-256-gcm', data: 'host-copy', nonce: 'nonce', version: 1 },
      encryptedMembershipCheckpointBundle: { cipher: 'aes-256-gcm', data: 'checkpoint', nonce: 'nonce', version: 1 },
      guestDelivery: { registrationId: 'registration-1', guestIdentityId: 'guest-1', encryptedSecret: 'v3:guest-ciphertext' }
    }), response);
    expect(response.status).not.toHaveBeenCalled();
    expect(inviteRepository.create).toHaveBeenCalledWith(expect.objectContaining({ maxUses: 1 }));
    expect(systemEventRepository.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      recipientIdentityId: 'guest-1', type: 'invite:guest-membership',
      payload: expect.objectContaining({ encryptedSecret: 'v3:guest-ciphertext' })
    }));
    expect(sendToIdentityWs).toHaveBeenCalledWith('family_1', 'guest-1', expect.objectContaining({ type: 'system:event' }));
  });

  test('revoking an owned invite reports retained history', async () => {
    const res = makeResponse();
    const revocation = { type: 'link-capability-revocation', payload: { capabilityId: 'cap_1' } };
    (inviteRepository.findById as jest.Mock).mockResolvedValue({
      invite_id: 'invite_1',
      capability_id: 'cap_1',
      status: 'active'
    });
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({
      public_key_algorithm: 'ed25519',
      public_key_value: 'owner_public_key'
    });
    (inviteRepository.revokeOwnedInvite as jest.Mock).mockResolvedValue({
      ok: true,
      invite: null,
      remaining: null,
      deleted: false
    });

    await getPostHandler('/:inviteId/revoke')(
      makeOwnerRequest({ revocation }, { inviteId: 'invite_1' }),
      res
    );

    expect(inviteRepository.revokeOwnedInvite).toHaveBeenCalledWith(expect.objectContaining({
      inviteId: 'invite_1',
      familyId: 'family_1',
      identityId: 'owner_identity',
      revocation
    }));
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      result: {
        invite: null,
        remaining: null,
        deleted: false
      }
    });
  });
});
