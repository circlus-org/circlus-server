export type CallHistoryServerStatus =
  | 'ringing'
  | 'answered'
  | 'rejected'
  | 'missed'
  | 'ended'
  | 'failed';

export function isCallRejectionReason(reason?: string | null): boolean {
  const normalized = String(reason || '').trim().toLowerCase();
  return normalized.includes('declin') || normalized.includes('reject');
}

export function deriveCallHistoryFinalStatus(params: {
  existingStatus: CallHistoryServerStatus;
  reportedStatus: Exclude<CallHistoryServerStatus, 'missed' | 'ringing'>;
  connectedAt: number | null;
}): CallHistoryServerStatus {
  if (params.connectedAt !== null) return 'answered';
  if (params.reportedStatus === 'answered') return 'answered';
  if (params.existingStatus === 'answered') return 'answered';
  if (params.reportedStatus === 'rejected') return 'rejected';

  // A decline is authoritative. Both participants can send best-effort final
  // reports afterwards, and an initiator used to overwrite `rejected` with
  // `ended` depending on request order.
  if (params.existingStatus === 'rejected') return 'rejected';
  if (
    params.existingStatus === 'missed'
    && (params.reportedStatus === 'ended' || params.reportedStatus === 'failed')
  ) {
    return 'missed';
  }

  return params.reportedStatus;
}

export function deriveCallHistoryFinalReason(params: {
  existingStatus: CallHistoryServerStatus;
  nextStatus: CallHistoryServerStatus;
  existingReason?: string | null;
  reportedReason?: string | null;
}): string | null {
  const existingReason = String(params.existingReason || '').trim() || null;
  const reportedReason = String(params.reportedReason || '').trim() || null;
  const existingIsAuthoritative = (
    params.existingStatus === 'missed' || params.existingStatus === 'rejected'
  ) && params.nextStatus === params.existingStatus;

  return existingIsAuthoritative && existingReason
    ? existingReason
    : reportedReason || existingReason;
}
