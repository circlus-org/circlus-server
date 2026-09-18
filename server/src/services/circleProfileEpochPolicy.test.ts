import type { CircleMembershipStateRecord, CircleProfileEpochClaim } from '@shared/types';
import { isValidCircleProfileEpochAdvance } from './circleProfileEpochPolicy';

function state(sequence: number, action: CircleMembershipStateRecord['claim']['payload']['action']): CircleMembershipStateRecord {
  return { claim: { payload: { sequence, action } } } as CircleMembershipStateRecord;
}

function epoch(overrides: Partial<CircleProfileEpochClaim['payload']>): CircleProfileEpochClaim {
  return { payload: { epoch: 1, membershipSequence: 1, previousKeyCommitment: null, ...overrides } } as CircleProfileEpochClaim;
}

describe('Circle profile epoch rotation policy', () => {
  test('creates epoch one without a prior key', () => {
    expect(isValidCircleProfileEpochAdvance({ claim: epoch({}), previous: null, membershipStates: [state(1, 'genesis')] })).toBe(true);
  });

  test('does not rotate merely because members joined', () => {
    expect(isValidCircleProfileEpochAdvance({
      claim: epoch({ epoch: 2, membershipSequence: 3, previousKeyCommitment: 'first' }),
      previous: { epoch: 1, membershipSequence: 1, keyCommitment: 'first' },
      membershipStates: [state(1, 'genesis'), state(2, 'add'), state(3, 'add')],
    })).toBe(false);
  });

  test('rotates after removal and preserves the commitment chain', () => {
    expect(isValidCircleProfileEpochAdvance({
      claim: epoch({ epoch: 2, membershipSequence: 4, previousKeyCommitment: 'first' }),
      previous: { epoch: 1, membershipSequence: 2, keyCommitment: 'first' },
      membershipStates: [state(3, 'remove'), state(4, 'add')],
    })).toBe(true);
  });

  test('rejects a forked previous commitment', () => {
    expect(isValidCircleProfileEpochAdvance({
      claim: epoch({ epoch: 2, membershipSequence: 3, previousKeyCommitment: 'fork' }),
      previous: { epoch: 1, membershipSequence: 1, keyCommitment: 'first' },
      membershipStates: [state(3, 'remove')],
    })).toBe(false);
  });
});
