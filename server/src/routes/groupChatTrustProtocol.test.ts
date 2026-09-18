jest.mock('../utils/crypto', () => ({
  verifySignedRequest: jest.fn(() => true)
}));

import type {
  GroupLeaveRequestClaim,
  GroupStateTransitionClaim,
  GroupStateTransitionPayload,
  PublicKey
} from '../../../shared/types';
import {
  findCurrentGroupMembershipTransitionId,
  validateGroupLeaveRequest,
  validateGroupStateTransition
} from './groupChatTrustProtocol';

const publicKey: PublicKey = { algorithm: 'ed25519', value: 'test' };

function claim(payload: GroupStateTransitionPayload, signerId = 'owner'): GroupStateTransitionClaim {
  return {
    type: 'grp:state-transition',
    timestamp: 1,
    nonce: 'nonce',
    signerId,
    payload,
    signature: 'signature'
  };
}

function leaveRequest(
  membershipTransitionId: string,
  observedTransitionId: string,
  signerId = 'member'
): GroupLeaveRequestClaim {
  return {
    type: 'grp:leave-request',
    timestamp: 1,
    nonce: 'nonce',
    signerId,
    payload: {
      version: 1,
      purpose: 'group-leave-request-v1',
      chatId: genesisPayload.chatId,
      requestId: 'glr_member_leave_request',
      participantIdentityId: 'member',
      membershipTransitionId,
      observedTransitionId,
      requestedAt: 1
    },
    signature: 'signature'
  };
}

const genesisPayload: GroupStateTransitionPayload = {
  version: 2,
  purpose: 'group-state-transition-v2',
  chatId: 'gc_test_chat',
  transitionId: 'gst_genesis_transition',
  previousTransitionId: null,
  sequence: 1,
  action: 'create',
  ownerIdentityId: 'owner',
  participantIdentityIds: ['owner', 'member'],
  epoch: 1,
  keyCommitment: 'a'.repeat(64),
  titleCiphertext: 'gct1:1:title'
};

describe('group trust protocol', () => {
  it('requires the current owner to sign the single CAS successor', () => {
    const previous = claim(genesisPayload);
    const next = claim({
      ...genesisPayload,
      transitionId: 'gst_remove_transition',
      previousTransitionId: genesisPayload.transitionId,
      sequence: 2,
      action: 'remove_participants',
      participantIdentityIds: ['owner'],
      epoch: 2,
      keyCommitment: 'b'.repeat(64),
      titleCiphertext: 'gct1:2:title'
    });
    expect(validateGroupStateTransition({
      claim: next,
      chatId: genesisPayload.chatId,
      signerPublicKey: publicKey,
      previous
    })).toEqual({ ok: true });

    expect(validateGroupStateTransition({
      claim: { ...next, signerId: 'member' },
      chatId: genesisPayload.chatId,
      signerPublicKey: publicKey,
      previous
    }).ok).toBe(false);
    expect(validateGroupStateTransition({
      claim: { ...next, payload: { ...next.payload, previousTransitionId: 'gst_other_branch' } },
      chatId: genesisPayload.chatId,
      signerPublicKey: publicKey,
      previous
    }).ok).toBe(false);
  });

  it('does not allow membership changes without rotating the epoch key', () => {
    const previous = claim(genesisPayload);
    const unsafe = claim({
      ...genesisPayload,
      transitionId: 'gst_unsafe_addition',
      previousTransitionId: genesisPayload.transitionId,
      sequence: 2,
      action: 'add_participants',
      participantIdentityIds: ['owner', 'member', 'new-member']
    });
    expect(validateGroupStateTransition({
      claim: unsafe,
      chatId: genesisPayload.chatId,
      signerPublicKey: publicKey,
      previous
    }).ok).toBe(false);
  });

  it('binds a leave request to the participant current membership incarnation', () => {
    const genesis = claim(genesisPayload);
    const request = leaveRequest(genesisPayload.transitionId, genesisPayload.transitionId);
    expect(validateGroupLeaveRequest({
      claim: request,
      chatId: genesisPayload.chatId,
      participantPublicKey: publicKey,
      transitions: [genesis]
    })).toEqual({ ok: true });
    expect(validateGroupLeaveRequest({
      claim: { ...request, signerId: 'owner' },
      chatId: genesisPayload.chatId,
      participantPublicKey: publicKey,
      transitions: [genesis]
    }).ok).toBe(false);

    const removed = claim({
      ...genesisPayload,
      transitionId: 'gst_leave_remove_transition',
      previousTransitionId: genesisPayload.transitionId,
      sequence: 2,
      action: 'remove_participants',
      participantIdentityIds: ['owner'],
      epoch: 2,
      keyCommitment: 'b'.repeat(64),
      titleCiphertext: 'gct1:2:title'
    });
    const readmitted = claim({
      ...genesisPayload,
      transitionId: 'gst_leave_readmit_transition',
      previousTransitionId: removed.payload.transitionId,
      sequence: 3,
      action: 'add_participants',
      participantIdentityIds: ['owner', 'member'],
      epoch: 3,
      keyCommitment: 'c'.repeat(64),
      titleCiphertext: 'gct1:3:title'
    });
    const history = [genesis, removed, readmitted];

    expect(validateGroupLeaveRequest({
      claim: request,
      chatId: genesisPayload.chatId,
      participantPublicKey: publicKey,
      transitions: history
    })).toEqual({ ok: true });
    expect(findCurrentGroupMembershipTransitionId(history, 'member')).toBe(readmitted.payload.transitionId);
    expect(findCurrentGroupMembershipTransitionId(history, 'member')).not.toBe(request.payload.membershipTransitionId);
  });
});
