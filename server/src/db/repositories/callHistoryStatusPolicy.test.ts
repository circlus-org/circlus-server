import {
  deriveCallHistoryFinalReason,
  deriveCallHistoryFinalStatus,
  isCallRejectionReason
} from './callHistoryStatusPolicy';

describe('isCallRejectionReason', () => {
  it.each(['declined', 'native_declined', 'mobile_declined', 'tab_rejected'])(
    'recognizes the historical rejection reason %s',
    (reason) => {
      expect(isCallRejectionReason(reason)).toBe(true);
    }
  );
});

describe('deriveCallHistoryFinalStatus', () => {
  it.each(['ended', 'failed'] as const)(
    'does not downgrade a rejected call to %s when a late client report arrives',
    (reportedStatus) => {
      expect(deriveCallHistoryFinalStatus({
        existingStatus: 'rejected',
        reportedStatus,
        connectedAt: null
      })).toBe('rejected');
    }
  );

  it('allows an answered call to supersede an earlier rejection report', () => {
    expect(deriveCallHistoryFinalStatus({
      existingStatus: 'rejected',
      reportedStatus: 'answered',
      connectedAt: null
    })).toBe('answered');
  });

  it('keeps a connected call answered regardless of a terminal client report', () => {
    expect(deriveCallHistoryFinalStatus({
      existingStatus: 'ended',
      reportedStatus: 'rejected',
      connectedAt: 100
    })).toBe('answered');
  });

  it.each(['ended', 'failed'] as const)(
    'does not downgrade a server-side missed result to %s',
    (reportedStatus) => {
      expect(deriveCallHistoryFinalStatus({
        existingStatus: 'missed',
        reportedStatus,
        connectedAt: null
      })).toBe('missed');
    }
  );
});

describe('deriveCallHistoryFinalReason', () => {
  it.each(['missed', 'rejected'] as const)(
    'keeps the authoritative %s reason when a late report has the same outcome',
    (existingStatus) => {
      expect(deriveCallHistoryFinalReason({
        existingStatus,
        nextStatus: existingStatus,
        existingReason: existingStatus === 'missed' ? 'no_answer' : 'declined',
        reportedReason: 'user_cancelled'
      })).toBe(existingStatus === 'missed' ? 'no_answer' : 'declined');
    }
  );

  it('uses the reported reason when the outcome legitimately changes', () => {
    expect(deriveCallHistoryFinalReason({
      existingStatus: 'missed',
      nextStatus: 'rejected',
      existingReason: 'timeout',
      reportedReason: 'declined'
    })).toBe('declined');
  });
});
