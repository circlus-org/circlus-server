import { classifyCallerCancellation } from './callCancellationOutcomePolicy';

const base = {
  callCreatedAt: 1_000,
  recipientIdentityId: 'recipient',
  deliveredGraceMs: 3_000,
  noDeliveryFallbackMs: 10_000
};

describe('classifyCallerCancellation', () => {
  it('treats a call stopped before reaching the recipient as cancelled', () => {
    expect(classifyCallerCancellation({
      ...base,
      endedAt: 6_000,
      handlingEvents: []
    }).reason).toBe('cancelled');
  });

  it('treats a call stopped immediately after delivery as cancelled', () => {
    expect(classifyCallerCancellation({
      ...base,
      endedAt: 6_000,
      handlingEvents: [{
        identityId: 'recipient',
        eventType: 'ringing_started',
        recordedAt: 4_000
      }]
    })).toMatchObject({
      reason: 'cancelled',
      evidence: 'recipient_reached',
      waitAfterReachMs: 2_000
    });
  });

  it('treats a delivered call with a meaningful wait as no answer', () => {
    expect(classifyCallerCancellation({
      ...base,
      endedAt: 8_000,
      handlingEvents: [{
        identityId: 'recipient',
        eventType: 'incoming_ui_shown',
        recordedAt: 4_000
      }]
    })).toMatchObject({
      reason: 'no_answer',
      evidence: 'recipient_reached',
      waitAfterReachMs: 4_000
    });
  });

  it('keeps the exact three-second delivery grace as cancelled', () => {
    expect(classifyCallerCancellation({
      ...base,
      endedAt: 7_000,
      handlingEvents: [{
        identityId: 'recipient',
        eventType: 'ringing_started',
        recordedAt: 4_000
      }]
    }).reason).toBe('cancelled');
  });

  it('uses the ten-second fallback when old clients provide no delivery evidence', () => {
    expect(classifyCallerCancellation({
      ...base,
      endedAt: 12_000,
      handlingEvents: []
    }).reason).toBe('no_answer');
  });

  it('ignores delivery events reported by the caller', () => {
    expect(classifyCallerCancellation({
      ...base,
      endedAt: 6_000,
      handlingEvents: [{
        identityId: 'caller',
        eventType: 'ringing_started',
        recordedAt: 2_000
      }]
    }).reason).toBe('cancelled');
  });
});
