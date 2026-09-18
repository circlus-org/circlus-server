import type { CircleMembershipStateRecord, CircleProfileEpochClaim } from '../../../shared/types';

export type StoredCircleProfileEpochHead = {
  epoch: number;
  keyCommitment: string;
  membershipSequence: number;
} | null;

export function isValidCircleProfileEpochAdvance(params: {
  claim: CircleProfileEpochClaim;
  previous: StoredCircleProfileEpochHead;
  membershipStates: CircleMembershipStateRecord[];
}): boolean {
  const { claim, previous, membershipStates } = params;
  if (!previous) {
    return claim.payload.epoch === 1
      && claim.payload.previousKeyCommitment === null;
  }
  const removalSincePrevious = membershipStates.some((state) => (
    state.claim.payload.sequence > previous.membershipSequence
    && state.claim.payload.sequence <= claim.payload.membershipSequence
    && state.claim.payload.action === 'remove'
  ));
  return claim.payload.epoch === previous.epoch + 1
    && claim.payload.previousKeyCommitment === previous.keyCommitment
    && claim.payload.membershipSequence > previous.membershipSequence
    && removalSincePrevious;
}
