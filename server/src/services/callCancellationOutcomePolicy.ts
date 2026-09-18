export type CallReachEvidence = {
  identityId: string;
  eventType: string;
  recordedAt: number;
};

export type CallerCancellationOutcome = {
  reason: 'cancelled' | 'no_answer';
  evidence: 'recipient_reached' | 'elapsed_fallback';
  totalWaitMs: number;
  reachedAt?: number;
  waitAfterReachMs?: number;
};

const RECIPIENT_REACHED_EVENT_TYPES = new Set([
  'fcm_received',
  'incoming_call_accepted',
  'push_received',
  'foreground_service_start_requested',
  'foreground_service_received',
  'foreground_service_started',
  'telecom_reported',
  'incoming_ui_shown',
  'ringing_started',
  'answered'
]);

export function classifyCallerCancellation(params: {
  callCreatedAt: number;
  endedAt: number;
  recipientIdentityId: string;
  handlingEvents: CallReachEvidence[];
  deliveredGraceMs?: number;
  noDeliveryFallbackMs?: number;
}): CallerCancellationOutcome {
  const requestedGraceMs = params.deliveredGraceMs ?? 3_000;
  const deliveredGraceMs = Number.isFinite(requestedGraceMs) ? Math.max(0, requestedGraceMs) : 3_000;
  const requestedFallbackMs = params.noDeliveryFallbackMs ?? 10_000;
  const noDeliveryFallbackMs = Number.isFinite(requestedFallbackMs)
    ? Math.max(deliveredGraceMs, requestedFallbackMs)
    : Math.max(deliveredGraceMs, 10_000);
  const totalWaitMs = Math.max(0, params.endedAt - params.callCreatedAt);
  const reachedAt = params.handlingEvents
    .filter((event) => (
      event.identityId === params.recipientIdentityId
      && RECIPIENT_REACHED_EVENT_TYPES.has(event.eventType)
      && Number.isFinite(event.recordedAt)
      && event.recordedAt <= params.endedAt
    ))
    .reduce<number | undefined>((earliest, event) => (
      earliest === undefined ? event.recordedAt : Math.min(earliest, event.recordedAt)
    ), undefined);

  if (reachedAt !== undefined) {
    const waitAfterReachMs = Math.max(0, params.endedAt - reachedAt);
    return {
      reason: waitAfterReachMs > deliveredGraceMs ? 'no_answer' : 'cancelled',
      evidence: 'recipient_reached',
      totalWaitMs,
      reachedAt,
      waitAfterReachMs
    };
  }

  return {
    reason: totalWaitMs >= noDeliveryFallbackMs ? 'no_answer' : 'cancelled',
    evidence: 'elapsed_fallback',
    totalWaitMs
  };
}
