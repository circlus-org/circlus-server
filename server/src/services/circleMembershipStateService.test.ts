jest.mock('../db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../utils/crypto', () => ({ verifySignedRequest: jest.fn(() => true) }));
jest.mock('./linkCapabilityService', () => ({ verifyCapabilityProof: jest.fn(() => true) }));

import type { CircleMembershipStateRecord, PublicKey } from '@shared/types';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@shared/signatureMessage';
import { validateCircleMembershipStateTransition } from './circleMembershipStateService';

const ownerKey = { algorithm: 'ed25519' as const, value: 'owner-key' };
const memberKey = { algorithm: 'ed25519' as const, value: 'member-key' };
const members = [
  { identityId: 'MEMBER', publicKey: memberKey, role: 'member' as const },
  { identityId: 'OWNER', publicKey: ownerKey, role: 'owner' as const },
];
const membersWithInvitePermission = [
  { ...members[0]!, permissions: { canCreateInvites: true } },
  members[1]!,
];

function record(overrides: Partial<CircleMembershipStateRecord['claim']['payload']>): CircleMembershipStateRecord {
  return {
    claim: {
      type: 'circle:membership-state',
      signerId: 'OWNER',
      signature: 'signature',
      payload: {
        version: 2,
        purpose: 'circle-membership-state-v2',
        vpsId: 'vps-test',
        circleId: 'circle-id',
        stateId: 'cms_ownerrepair0000',
        sequence: 2,
        previousStateId: 'cms_genesis000000',
        ownerIdentityId: 'OWNER',
        members,
        action: 'repair',
        subjectIdentityId: 'OWNER',
        issuedAt: new Date().toISOString(),
        ...overrides,
      },
    },
    admission: null,
  };
}

const genesis = record({
  stateId: 'cms_genesis000000',
  sequence: 1,
  previousStateId: null,
  action: 'genesis',
});

describe('Circle membership owner repair', () => {
  it('accepts only an owner-signed reset to the owner immediately after genesis', () => {
    expect(validateCircleMembershipStateTransition({
      record: record({ members: [members[1]!] }),
      previous: genesis.claim,
    })).toEqual({ ok: true });

    expect(validateCircleMembershipStateTransition({
      record: record({}),
      previous: genesis.claim,
    })).toEqual({ ok: false, message: 'Invalid Circle membership repair' });

    expect(validateCircleMembershipStateTransition({
      record: record({ sequence: 3 }),
      previous: genesis.claim,
    })).toEqual({ ok: false, message: 'Circle membership compare-and-swap conflict' });
  });

  it('binds a modern transition to the exact previous signed claim', () => {
    const previousStateHash = createHash('sha256')
      .update(canonicalizeJson(genesis.claim), 'utf8')
      .digest('base64url');
    expect(validateCircleMembershipStateTransition({
      record: record({ members: [members[1]!], previousStateHash }),
      previous: genesis.claim,
    })).toEqual({ ok: true });
    expect(validateCircleMembershipStateTransition({
      record: record({ members: [members[1]!], previousStateHash: 'tampered' }),
      previous: genesis.claim,
    })).toEqual({ ok: false, message: 'Circle membership compare-and-swap conflict' });
  });

  it('rejects direct guests in Circle membership state', () => {
    expect(validateCircleMembershipStateTransition({
      record: record({
        members: [
          members[1]!,
          { identityId: 'GUEST', publicKey: { algorithm: 'ed25519', value: 'guest-key' }, role: 'guest' } as any,
        ],
      }),
      previous: genesis.claim,
    })).toEqual({ ok: false, message: 'Invalid Circle membership state' });
  });
});

describe('Circle membership invite permission transitions', () => {
  it('accepts an owner-signed invitation permission update for one non-owner member', () => {
    expect(validateCircleMembershipStateTransition({
      record: record({
        stateId: 'cms_inviteperm0001',
        action: 'set_invite_permission',
        subjectIdentityId: 'MEMBER',
        members: membersWithInvitePermission,
      }),
      previous: genesis.claim,
    })).toEqual({ ok: true });
  });

  it('does not allow invitation permission to be granted through a member add', () => {
    const previous = record({
      stateId: 'cms_previous00000',
      sequence: 1,
      previousStateId: null,
      action: 'genesis',
      members: [members[1]!],
    });
    const add = record({
      stateId: 'cms_addmember0000',
      sequence: 2,
      previousStateId: previous.claim.payload.stateId,
      action: 'add',
      subjectIdentityId: 'MEMBER',
      members: membersWithInvitePermission,
    });
    add.claim.signerId = 'cap_1';
    add.admission = {
      kind: 'circle_invite',
      capabilityId: 'cap_1',
      descriptor: {
        type: 'link-capability:descriptor',
        signerId: 'OWNER',
        signature: 'sig',
        payload: {
          version: 2,
          purpose: 'circlus-link-capability-v2',
          capabilityId: 'cap_1',
          kind: 'circle-invite',
          mode: 'single-use',
          issuerIdentityId: 'OWNER',
          targetIdentityId: 'OWNER',
          capabilityPublicKey: ownerKey,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          scope: { membershipCheckpoint: { version: 1, sequence: 1, stateId: previous.claim.payload.stateId, stateHash: 'hash', ownerIdentityId: 'OWNER' } },
        },
      },
      issuerIdentityId: 'OWNER',
      issuerPublicKey: ownerKey,
      claim: {
        capabilityProof: {
          type: 'link-capability:proof',
          signerId: 'cap_1',
          signature: 'sig',
          payload: {
            version: 2,
            purpose: 'circlus-link-capability-proof-v2',
            capabilityId: 'cap_1',
            action: 'circle-invite:claim',
            targetIdentityId: 'OWNER',
            subjectIdentityId: 'MEMBER',
            subjectPublicKey: memberKey,
            claimId: 'claim-1',
          },
        },
        subjectAcceptance: {
          type: 'circle-invite:acceptance',
          signerId: 'MEMBER',
          signature: 'sig',
          payload: {
            version: 2,
            purpose: 'circlus-circle-invite-acceptance-v2',
            capabilityId: 'cap_1',
            claimId: 'claim-1',
            identityPublicKey: memberKey,
            capabilityProof: {} as any,
          },
        },
      },
    };

    expect(validateCircleMembershipStateTransition({
      record: add,
      previous: previous.claim,
    })).toEqual({ ok: false, message: 'Invalid Circle member addition' });
  });
});

function invitedMemberAdd(params: {
  previous: CircleMembershipStateRecord;
  identityId: string;
  publicKey: PublicKey;
  mode: 'single-use' | 'unlimited';
  claimId: string;
  stateId: string;
}): CircleMembershipStateRecord {
  const capabilityId = 'cap_reusable_invite';
  const descriptor = {
    type: 'link-capability:descriptor' as const,
    signerId: 'OWNER',
    signature: 'reusable-descriptor-signature',
    payload: {
      version: 2 as const,
      purpose: 'circlus-link-capability-v2' as const,
      capabilityId,
      kind: 'circle-invite' as const,
      mode: params.mode,
      issuerIdentityId: 'OWNER',
      targetIdentityId: 'OWNER',
      capabilityPublicKey: ownerKey,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scope: {
        membershipCheckpoint: {
          version: 1,
          sequence: 1,
          stateId: 'cms_reusablegenesis',
          stateHash: 'hash',
          ownerIdentityId: 'OWNER',
        },
      },
    },
  };
  const capabilityProof = {
    type: 'link-capability:proof' as const,
    signerId: capabilityId,
    signature: `proof-${params.claimId}`,
    payload: {
      version: 2 as const,
      purpose: 'circlus-link-capability-proof-v2' as const,
      capabilityId,
      action: 'circle-invite:claim' as const,
      targetIdentityId: 'OWNER',
      subjectIdentityId: params.identityId,
      subjectPublicKey: params.publicKey,
      claimId: params.claimId,
    },
  };
  const add = record({
    stateId: params.stateId,
    sequence: params.previous.claim.payload.sequence + 1,
    previousStateId: params.previous.claim.payload.stateId,
    action: 'add',
    subjectIdentityId: params.identityId,
    members: [
      ...params.previous.claim.payload.members,
      {
        identityId: params.identityId,
        publicKey: params.publicKey,
        role: 'member' as const,
        permissions: { canCreateInvites: false },
      },
    ].sort((left, right) => left.identityId.localeCompare(right.identityId)),
  });
  add.claim.signerId = capabilityId;
  add.admission = {
    kind: 'circle_invite',
    capabilityId,
    descriptor,
    issuerIdentityId: 'OWNER',
    issuerPublicKey: ownerKey,
    claim: {
      capabilityProof,
      subjectAcceptance: {
        type: 'circle-invite:acceptance',
        signerId: params.identityId,
        signature: `acceptance-${params.claimId}`,
        payload: {
          version: 2,
          purpose: 'circlus-circle-invite-acceptance-v2',
          capabilityId,
          claimId: params.claimId,
          identityPublicKey: params.publicKey,
          capabilityProof,
        },
      },
    },
  };
  return add;
}

describe('Circle membership invite reuse', () => {
  const ownerOnlyGenesis = record({
    stateId: 'cms_reusablegenesis',
    sequence: 1,
    previousStateId: null,
    action: 'genesis',
    subjectIdentityId: 'OWNER',
    members: [members[1]!],
  });
  const secondMemberKey = { algorithm: 'ed25519' as const, value: 'member-two-key' };

  it('allows two different members to join through one unlimited invite', () => {
    const first = invitedMemberAdd({
      previous: ownerOnlyGenesis,
      identityId: 'MEMBER_ONE',
      publicKey: memberKey,
      mode: 'unlimited',
      claimId: 'claim-1',
      stateId: 'cms_reusablefirst00',
    });
    const second = invitedMemberAdd({
      previous: first,
      identityId: 'MEMBER_TWO',
      publicKey: secondMemberKey,
      mode: 'unlimited',
      claimId: 'claim-2',
      stateId: 'cms_reusablesecond0',
    });

    expect(validateCircleMembershipStateTransition({
      record: first,
      previous: ownerOnlyGenesis.claim,
      history: [ownerOnlyGenesis],
    })).toEqual({ ok: true });
    expect(validateCircleMembershipStateTransition({
      record: second,
      previous: first.claim,
      history: [ownerOnlyGenesis, first],
    })).toEqual({ ok: true });
  });

  it('still rejects a second use of a single-use invite', () => {
    const first = invitedMemberAdd({
      previous: ownerOnlyGenesis,
      identityId: 'MEMBER_ONE',
      publicKey: memberKey,
      mode: 'single-use',
      claimId: 'claim-1',
      stateId: 'cms_singleusefirst0',
    });
    const second = invitedMemberAdd({
      previous: first,
      identityId: 'MEMBER_TWO',
      publicKey: secondMemberKey,
      mode: 'single-use',
      claimId: 'claim-2',
      stateId: 'cms_singleusesecond',
    });

    expect(validateCircleMembershipStateTransition({
      record: first,
      previous: ownerOnlyGenesis.claim,
      history: [ownerOnlyGenesis],
    })).toEqual({ ok: true });
    expect(validateCircleMembershipStateTransition({
      record: second,
      previous: first.claim,
      history: [ownerOnlyGenesis, first],
    })).toEqual({ ok: false, message: 'Invalid Circle member addition' });
  });

  it('rejects replaying the same claim through an unlimited invite', () => {
    const first = invitedMemberAdd({
      previous: ownerOnlyGenesis,
      identityId: 'MEMBER_ONE',
      publicKey: memberKey,
      mode: 'unlimited',
      claimId: 'replayed-claim',
      stateId: 'cms_replayfirst000',
    });
    const replay = invitedMemberAdd({
      previous: first,
      identityId: 'MEMBER_TWO',
      publicKey: secondMemberKey,
      mode: 'unlimited',
      claimId: 'replayed-claim',
      stateId: 'cms_replaysecond00',
    });

    expect(validateCircleMembershipStateTransition({
      record: first,
      previous: ownerOnlyGenesis.claim,
      history: [ownerOnlyGenesis],
    })).toEqual({ ok: true });
    expect(validateCircleMembershipStateTransition({
      record: replay,
      previous: first.claim,
      history: [ownerOnlyGenesis, first],
    })).toEqual({ ok: false, message: 'Invalid Circle member addition' });
  });
});
