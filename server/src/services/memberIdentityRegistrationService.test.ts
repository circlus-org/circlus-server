const transactionClient = { query: jest.fn() };

jest.mock('../db', () => ({
  transaction: jest.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient))
}));

jest.mock('./linkCapabilityService', () => ({
  verifyCapabilityProof: jest.fn(() => true)
}));

jest.mock('../utils/crypto', () => ({
  verifySignedRequest: jest.fn(() => true)
}));

jest.mock('./circleMembershipStateService', () => ({
  appendCircleMembershipState: jest.fn().mockResolvedValue(undefined),
}));

import {
  MemberIdentityRegistrationError,
  registerMemberIdentity
} from './memberIdentityRegistrationService';

beforeAll(() => {
  process.env.VPS_ID = 'vps-test';
});

const params = {
  familyId: 'family-1',
  identityId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
  payload: {
    inviteToken: 'invite-token',
    identityPublicKey: { algorithm: 'ed25519' as const, value: 'identity-public-key' },
    encryptedIdentityPrivateKey: { cipher: 'aes-256-gcm', data: 'ciphertext' },
    publishIdentity: true,
    identityName: 'Alice'
    ,inviteCapabilityProof: {
      type: 'link-capability:proof',
      signerId: 'cap_123456789012345678901234',
      payload: { claimId: 'claim-1' }
    },
    inviteAcceptance: {
      type: 'circle-invite:acceptance',
      signerId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
      payload: {
        version: 2,
        purpose: 'circlus-circle-invite-acceptance-v2',
        capabilityId: 'cap_123456789012345678901234',
        claimId: 'claim-1',
        identityPublicKey: { algorithm: 'ed25519' as const, value: 'identity-public-key' },
        capabilityProof: {
          type: 'link-capability:proof',
          signerId: 'cap_123456789012345678901234',
          payload: { claimId: 'claim-1' }
        }
      }
    },
    membershipState: {
      claim: { payload: { vpsId: 'vps-test', circleId: 'circle_test_1234567890', action: 'add', subjectIdentityId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA' } },
      admission: {
        kind: 'circle_invite',
        capabilityId: 'cap_123456789012345678901234',
        descriptor: { payload: { capabilityId: 'cap_123456789012345678901234' } },
        issuerIdentityId: 'owner-1',
        issuerPublicKey: { algorithm: 'ed25519' as const, value: 'owner-public-key' },
        claim: {
          capabilityProof: {
            type: 'link-capability:proof',
            signerId: 'cap_123456789012345678901234',
            payload: { claimId: 'claim-1' }
          },
          subjectAcceptance: {
            type: 'circle-invite:acceptance',
            signerId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
            payload: {
              version: 2,
              purpose: 'circlus-circle-invite-acceptance-v2',
              capabilityId: 'cap_123456789012345678901234',
              claimId: 'claim-1',
              identityPublicKey: { algorithm: 'ed25519' as const, value: 'identity-public-key' },
              capabilityProof: {
                type: 'link-capability:proof',
                signerId: 'cap_123456789012345678901234',
                payload: { claimId: 'claim-1' }
              }
            }
          }
        }
      }
    }
  },
  noNamesOnServer: false
};

function configureQueries(overrides: {
  inviteStatus?: string;
  inviteUsedCount?: number;
  memberCount?: number;
  totalCount?: number;
  creatorStatus?: string | null;
  existingGuest?: boolean;
  guestScope?: Record<string, unknown>;
  activeGuestRegistration?: boolean;
} = {}) {
  transactionClient.query.mockImplementation(async (sqlValue: string) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM family_config')) {
      return {
        rows: [{
          status: 'active',
          circle_id: 'circle_test_1234567890',
          join_invite_id: null,
          max_member_identities: 5,
          max_total_identities: 10
        }]
      };
    }
    if (sql.includes('SELECT * FROM invites')) {
      return {
        rows: [{
          invite_id: 'invite-1',
          family_id: 'family-1',
          created_by: 'owner-1',
          status: overrides.inviteStatus || 'active',
          expires_at: new Date('2030-01-01T00:00:00.000Z'),
          used_count: overrides.inviteUsedCount ?? 0,
          max_uses: 1,
          capability_id: 'cap_123456789012345678901234',
          capability_descriptor: { payload: { capabilityId: 'cap_123456789012345678901234',
            ...(overrides.guestScope ? { scope: overrides.guestScope } : {}) } }
        }]
      };
    }
    if (sql.includes('SELECT status') && sql.includes('FROM identities')) {
      return {
        rows: overrides.creatorStatus === null
          ? []
          : [{
              status: overrides.creatorStatus || 'active',
              public_key_algorithm: 'ed25519',
              public_key_value: 'owner-public-key'
            }]
      };
    }
    if (sql.includes('SELECT * FROM identities') && sql.includes('public_key_value')) {
      return overrides.existingGuest
        ? { rows: [{
            identity_id: params.identityId,
            public_key_algorithm: 'ed25519',
            public_key_value: 'identity-public-key',
            encrypted_private_key: null,
            identity_name: null,
            created_at: new Date('2029-01-01T00:00:00.000Z'),
            status: 'active',
            role: 'guest'
          }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM direct_guest_registrations')) return overrides.activeGuestRegistration === false
      ? { rows: [], rowCount: 0 } : { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (sql.includes('COUNT(*) FILTER')) {
      return {
        rows: [{
          member_count: String(overrides.memberCount ?? 1),
          total_count: String(overrides.totalCount ?? 1)
        }]
      };
    }
    if (sql.includes('INSERT INTO identities')) {
      return {
        rows: [{
          identity_id: params.identityId,
          public_key_algorithm: 'ed25519',
          public_key_value: 'identity-public-key',
          encrypted_private_key: params.payload.encryptedIdentityPrivateKey,
          identity_name: null,
          created_at: new Date('2029-01-01T00:00:00.000Z'),
          status: 'active',
          role: 'member'
        }]
      };
    }
    if (sql.includes('UPDATE identities') && sql.includes("role = 'member'")) {
      return {
        rows: [{
          identity_id: params.identityId,
          public_key_algorithm: 'ed25519',
          public_key_value: 'identity-public-key',
          encrypted_private_key: params.payload.encryptedIdentityPrivateKey,
          identity_name: null,
          created_at: new Date('2029-01-01T00:00:00.000Z'),
          status: 'active',
          role: 'member'
        }]
      };
    }
    return { rows: [], rowCount: 1 };
  });
}

describe('member identity registration service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureQueries();
  });

  test('creates identity and consumes invite atomically', async () => {
    const result = await registerMemberIdentity(params);

    expect(result.identity.identity_id).toBe(params.identityId);
    expect(result.inviteCreator).toBe('owner-1');
    const statements = transactionClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('INSERT INTO identities'))).toBe(true);
    expect(statements.some((sql) => sql.includes('SET used_count = used_count + 1'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO invite_acceptances'))).toBe(true);
  });

  test('promotes an active direct guest without creating a new identity', async () => {
    configureQueries({ existingGuest: true });

    const result = await registerMemberIdentity(params);

    expect(result.identity.identity_id).toBe(params.identityId);
    const statements = transactionClient.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("SET role = 'member'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("SET status = 'promoted'"))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO identities'))).toBe(false);
    expect(statements.some((sql) => sql.includes('INSERT INTO invite_acceptances'))).toBe(true);
  });

  test('rejects a directed invitation claimed by a different guest key', async () => {
    configureQueries({ existingGuest: true, guestScope: {
      guestIdentityId: params.identityId, guestRegistrationId: 'registration-1', guestPublicKey: 'another-key'
    } });
    await expect(registerMemberIdentity(params)).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    expect(transactionClient.query.mock.calls.some(([sql]) => String(sql).includes("SET role = 'member'"))).toBe(false);
  });

  test('rejects a directed invitation after guest access was revoked', async () => {
    configureQueries({ existingGuest: true, activeGuestRegistration: false, guestScope: {
      guestIdentityId: params.identityId, guestRegistrationId: 'registration-1', guestPublicKey: params.payload.identityPublicKey.value
    } });
    await expect(registerMemberIdentity(params)).rejects.toMatchObject({ code: 'INVITE_INVALID' });
  });

  test('rejects a membership proof addressed to another VPS', async () => {
    const mismatchedParams = structuredClone(params);
    mismatchedParams.payload.membershipState.claim.payload.vpsId = 'vps-other';

    await expect(registerMemberIdentity(mismatchedParams))
      .rejects.toMatchObject<Partial<MemberIdentityRegistrationError>>({
        code: 'INVITE_INVALID',
        status: 400
      });
  });

  test('rejects an exhausted invite before inserting identity', async () => {
    configureQueries({ inviteUsedCount: 1 });

    await expect(registerMemberIdentity(params))
      .rejects.toMatchObject<Partial<MemberIdentityRegistrationError>>({
        code: 'INVITE_EXHAUSTED',
        status: 400
      });
    expect(transactionClient.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO identities')))
      .toBe(false);
  });

  test('rejects an invite created by a suspended identity', async () => {
    configureQueries({ creatorStatus: 'disabled' });

    await expect(registerMemberIdentity(params))
      .rejects.toMatchObject<Partial<MemberIdentityRegistrationError>>({
        code: 'INVITE_INVALID',
        status: 400
      });
    expect(transactionClient.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO identities')))
      .toBe(false);
  });

  test('rejects an invite whose creator no longer exists', async () => {
    configureQueries({ creatorStatus: null });

    await expect(registerMemberIdentity(params))
      .rejects.toMatchObject<Partial<MemberIdentityRegistrationError>>({
        code: 'INVITE_INVALID',
        status: 400
      });
    expect(transactionClient.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO identities')))
      .toBe(false);
  });

  test('checks identity quotas while holding the family configuration lock', async () => {
    configureQueries({ memberCount: 5 });

    await expect(registerMemberIdentity(params))
      .rejects.toMatchObject<Partial<MemberIdentityRegistrationError>>({
        code: 'MEMBER_LIMIT_EXCEEDED',
        details: { limit: 5, current: 5 }
      });
  });
});
