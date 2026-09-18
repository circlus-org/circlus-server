import { query, transaction } from '../db';
import { listCircleIdentityAdmissionProofs } from '../services/circleMembershipProofService';
import { appendCircleMembershipState, listCircleMembershipStates } from '../services/circleMembershipStateService';
import { notifyCircleDirectoryChanged } from '../services/circleDirectoryNotificationService';

jest.mock('../db', () => ({ query: jest.fn(), transaction: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  verifySignature: jest.fn((_req, _res, next) => next()),
  requireActiveIdentity: jest.fn((_req, _res, next) => next()),
  getSignedPayload: jest.fn((req) => req.signedRequest?.payload || {})
}));
jest.mock('../services/circleMembershipProofService', () => ({ listCircleIdentityAdmissionProofs: jest.fn() }));
jest.mock('../services/circleMembershipStateService', () => ({
  appendCircleMembershipState: jest.fn(),
  listCircleMembershipStates: jest.fn()
}));
jest.mock('../services/circleDirectoryNotificationService', () => ({ notifyCircleDirectoryChanged: jest.fn() }));
jest.mock('../utils/crypto', () => ({ verifySignedRequest: jest.fn(() => true) }));
jest.mock('../config/serverRuntimeConfig', () => ({
  ...jest.requireActual('../config/serverRuntimeConfig'),
  getServerIdentityRuntimeConfig: jest.fn(() => ({ vpsId: 'vps-test' }))
}));

const router = require('./circleMembership').default;
const dbQuery = query as jest.Mock;
const inTransaction = transaction as jest.Mock;
const membershipStates = listCircleMembershipStates as jest.Mock;
const admissionProofs = listCircleIdentityAdmissionProofs as jest.Mock;
const appendState = appendCircleMembershipState as jest.Mock;
const notify = notifyCircleDirectoryChanged as jest.Mock;

function handler(path: string) {
  const layer = router.stack.find((item: any) => item.route?.path === path && item.route?.methods?.post);
  if (!layer) throw new Error(`Missing route ${path}`);
  return layer.route.stack.at(-1).handle as (req: any, res: any) => Promise<void>;
}

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function request(payload: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    familyId: 'family-1',
    circleId: 'circle-1',
    identity: { identityId: 'alice' },
    signedRequest: { payload },
    ...overrides
  };
}

const members = [
  { identityId: 'alice', publicKey: { algorithm: 'ed25519', value: 'alice-key' } },
  { identityId: 'bob', publicKey: { algorithm: 'ed25519', value: 'bob-key' } }
];
const head = {
  claim: {
    payload: { stateId: 'state-1', sequence: 1, circleId: 'circle-1', members }
  }
};
const envelope = {
  epoch: 1,
  keyCommitment: 'commitment-1',
  membershipStateId: 'state-1',
  publisherIdentityId: 'alice',
  recipientIdentityId: 'bob',
  envelopeCiphertext: 'encrypted-key'
};
const epochClaim = {
  type: 'circle:profile-epoch',
  signerId: 'alice',
  payload: {
    version: 1,
    purpose: 'circle-profile-epoch-v1',
    circleId: 'circle-1',
    membershipStateId: 'state-1',
    membershipSequence: 1,
    epoch: 1,
    keyCommitment: 'commitment-1',
    previousKeyCommitment: null
  }
};
const profile = {
  ownerIdentityId: 'alice',
  epoch: 1,
  revision: 1,
  sourceRevision: null,
  publicationId: 'publication-1234567890',
  publicationKind: 'manual',
  ciphertext: 'encrypted-profile'
};
const profileRow = {
  owner_identity_id: 'alice',
  epoch: 1,
  revision: 1,
  source_revision: null,
  publication_id: profile.publicationId,
  publication_kind: 'manual',
  ciphertext: 'encrypted-profile',
  updated_at: new Date('2026-01-01T00:00:00.000Z')
};

describe('Circle membership route behavior', () => {
  const clientQuery = jest.fn();
  const client = { query: clientQuery };

  beforeEach(() => {
    jest.clearAllMocks();
    membershipStates.mockResolvedValue([head]);
    admissionProofs.mockResolvedValue([{ proofId: 'proof-1' }]);
    dbQuery.mockResolvedValue({ rows: [] });
    clientQuery.mockResolvedValue({ rows: [] });
    inTransaction.mockImplementation((callback: (client: typeof client) => Promise<unknown>) => callback(client));
  });

  it('returns the directory head with numeric counters and requires a Circle', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{
      membership_state_id: 'state-1', membership_sequence: '4', profile_epoch: '2',
      profile_epoch_count: '2', profile_envelope_count: '5', profile_count: '3', profile_revision_sum: '9'
    }] });
    const res = response();
    await handler('/head')(request(), res);
    expect(res.json.mock.calls[0][0].result).toEqual({
      membershipStateId: 'state-1', membershipSequence: 4, profileEpoch: 2,
      profileEpochCount: 2, profileEnvelopeCount: 5, profileCount: 3, profileRevisionSum: '9'
    });
    expect(dbQuery.mock.calls[0][1]).toEqual(['family-1']);

    const denied = response();
    await handler('/head')(request({}, { familyId: undefined }), denied);
    expect(denied.status).toHaveBeenCalledWith(500);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it('returns membership states and admission proofs for the Circle', async () => {
    const res = response();
    await handler('/state')(request(), res);
    expect(membershipStates).toHaveBeenCalledWith('family-1');
    expect(admissionProofs).toHaveBeenCalledWith('family-1');
    expect(res.json.mock.calls[0][0].result).toEqual({
      states: [head], membershipProofs: [{ proofId: 'proof-1' }], atomicAdminMembershipTransitions: true
    });

    const denied = response();
    await handler('/state')(request({}, { familyId: undefined }), denied);
    expect(denied.status).toHaveBeenCalledWith(500);
    expect(membershipStates).toHaveBeenCalledTimes(1);
  });

  it('reads only the requesting identity’s key envelopes and rejects a missing identity', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ claim: epochClaim }] })
      .mockResolvedValueOnce({ rows: [{
        epoch: 1, key_commitment: 'commitment-1', membership_state_id: 'state-1',
        publisher_identity_id: 'alice', recipient_identity_id: 'bob', envelope_ciphertext: 'encrypted-key'
      }] })
      .mockResolvedValueOnce({ rows: [{ epoch: 1, recipient_identity_id: 'bob' }] })
      .mockResolvedValueOnce({ rows: [profileRow] });
    const res = response();
    await handler('/profile-state')(request({}, { identity: { identityId: 'bob' } }), res);
    expect(dbQuery.mock.calls[1][1]).toEqual(['family-1', 'bob']);
    expect(res.json.mock.calls[0][0].result).toMatchObject({
      epochs: [epochClaim], envelopes: [envelope],
      epochRecipients: [{ epoch: 1, recipientIdentityId: 'bob' }],
      profiles: [{ ownerIdentityId: 'alice', updatedAt: '2026-01-01T00:00:00.000Z' }]
    });

    const denied = response();
    await handler('/profile-state')(request({}, { identity: undefined }), denied);
    expect(denied.status).toHaveBeenCalledWith(400);
    expect(dbQuery).toHaveBeenCalledTimes(4);
  });

  it('publishes an epoch and its envelopes in one transaction after validating the signer', async () => {
    const res = response();
    await handler('/profile-epoch/publish')(request({ claim: epochClaim, envelopes: [envelope] }), res);
    expect(res.json.mock.calls[0][0].result).toEqual({ epoch: 1 });
    expect(inTransaction).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('INSERT INTO circle_profile_epochs'),
      expect.stringContaining('INSERT INTO circle_profile_epoch_envelopes')
    ]);
    expect(notify).toHaveBeenCalledWith('family-1', 'profile_epoch');

    const denied = response();
    await handler('/profile-epoch/publish')(request({ claim: { ...epochClaim, signerId: 'bob' }, envelopes: [envelope] }), denied);
    expect(denied.status).toHaveBeenCalledWith(409);
    expect(inTransaction).toHaveBeenCalledTimes(1);
  });

  it('publishes only envelopes for the current epoch and current members', async () => {
    dbQuery.mockResolvedValue({ rows: [{ epoch: 1, key_commitment: 'commitment-1' }] });
    const res = response();
    await handler('/profile-epoch/envelopes/publish')(request({ envelopes: [envelope] }), res);
    expect(res.json.mock.calls[0][0].result).toEqual({ published: 1 });
    expect(inTransaction).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls[0][0]).toContain('INSERT INTO circle_profile_epoch_envelopes');

    const denied = response();
    await handler('/profile-epoch/envelopes/publish')(request({
      envelopes: [{ ...envelope, recipientIdentityId: 'mallory' }]
    }), denied);
    expect(denied.status).toHaveBeenCalledWith(409);
    expect(inTransaction).toHaveBeenCalledTimes(1);
  });

  it('publishes an own profile only against the locked current epoch', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT epoch FROM circle_profile_epochs')) return { rows: [{ epoch: 1 }] };
      if (sql.includes('SELECT owner_identity_id')) return { rows: [] };
      if (sql.includes('INSERT INTO circle_encrypted_identity_profiles')) return { rows: [profileRow] };
      return { rows: [] };
    });
    const res = response();
    await handler('/profiles/publish')(request({ profile }), res);
    expect(res.json.mock.calls[0][0].result).toMatchObject({ applied: true, profile: { ownerIdentityId: 'alice' } });
    expect(clientQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('SELECT epoch FROM circle_profile_epochs'),
      expect.stringContaining('FROM circle_encrypted_identity_profiles'),
      expect.stringContaining('INSERT INTO circle_encrypted_identity_profiles')
    ]);
    expect(notify).toHaveBeenCalledWith('family-1', 'profile');

    const denied = response();
    await handler('/profiles/publish')(request({ profile: { ...profile, ownerIdentityId: 'bob' } }), denied);
    expect(denied.status).toHaveBeenCalledWith(400);
    expect(inTransaction).toHaveBeenCalledTimes(1);

    clientQuery.mockClear();
    clientQuery.mockImplementation(async (sql: string) => sql.includes('SELECT epoch FROM circle_profile_epochs')
      ? { rows: [{ epoch: 2 }] } : { rows: [] });
    const stale = response();
    await handler('/profiles/publish')(request({ profile }), stale);
    expect(stale.status).toHaveBeenCalledWith(409);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO circle_encrypted_identity_profiles'))).toBe(false);
  });

  it('allows self-removal through the transaction client but rejects administrative adds', async () => {
    const record = {
      claim: {
        signerId: 'alice',
        payload: {
          action: 'remove', subjectIdentityId: 'alice', stateId: 'state-2', sequence: 2,
          vpsId: 'vps-test', circleId: 'circle-1'
        }
      }
    };
    const res = response();
    await handler('/state/append')(request({ state: record }), res);
    expect(appendState).toHaveBeenCalledWith({ familyId: 'family-1', record, client });
    expect(notify).toHaveBeenCalledWith('family-1', 'membership');
    expect(res.json.mock.calls[0][0].result).toEqual({ stateId: 'state-2', sequence: 2 });

    const denied = response();
    await handler('/state/append')(request({ state: {
      ...record, claim: { ...record.claim, payload: { ...record.claim.payload, action: 'add' } }
    } }), denied);
    expect(denied.status).toHaveBeenCalledWith(400);
    expect(inTransaction).toHaveBeenCalledTimes(1);
  });

  it('permits only self-removal while the Circle is suspended', async () => {
    const selfRemoval = { claim: { signerId: 'alice', payload: {
      action: 'remove', subjectIdentityId: 'alice', stateId: 'state-2', sequence: 2,
      vpsId: 'vps-test', circleId: 'circle-1'
    } } };
    const allowed = response();
    await handler('/state/append')(request({ state: selfRemoval }, { circleSuspended: true }), allowed);
    expect(allowed.json.mock.calls[0][0].status).toBe('ok');

    const rejected = response();
    await handler('/state/append')(request({ state: {
      claim: { ...selfRemoval.claim, payload: { ...selfRemoval.claim.payload, action: 'repair' } }
    } }, { circleSuspended: true }), rejected);
    expect(rejected.status).toHaveBeenCalledWith(423);
    expect(inTransaction).toHaveBeenCalledTimes(1);
  });
});
