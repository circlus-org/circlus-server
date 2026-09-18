import { EarlyEndedCallSessionRegistry } from './earlyEndedCallSessionRegistry';

describe('early-ended call session registry', () => {
  let now = 1_000;
  let registry: EarlyEndedCallSessionRegistry;

  beforeEach(() => {
    now = 1_000;
    registry = new EarlyEndedCallSessionRegistry(5_000, () => now);
  });

  it('consumes a matching early termination only once', () => {
    registry.remember({
      familyId: 'family-1',
      callSessionId: 'call-1',
      endedByIdentityId: 'identity-caller'
    });

    expect(registry.consume({
      familyId: 'family-1',
      callSessionId: 'call-1',
      initiatorIdentityId: 'identity-caller'
    })).toBe(true);
    expect(registry.consume({
      familyId: 'family-1',
      callSessionId: 'call-1',
      initiatorIdentityId: 'identity-caller'
    })).toBe(false);
  });

  it('keeps records scoped by family and terminating identity', () => {
    registry.remember({
      familyId: 'family-1',
      callSessionId: 'call-1',
      endedByIdentityId: 'identity-caller'
    });

    expect(registry.consume({
      familyId: 'family-2',
      callSessionId: 'call-1',
      initiatorIdentityId: 'identity-caller'
    })).toBe(false);
    expect(registry.consume({
      familyId: 'family-1',
      callSessionId: 'call-1',
      initiatorIdentityId: 'identity-other'
    })).toBe(false);
    expect(registry.consume({
      familyId: 'family-1',
      callSessionId: 'call-1',
      initiatorIdentityId: 'identity-caller'
    })).toBe(true);
  });

  it('expires stale records', () => {
    registry.remember({
      familyId: 'family-1',
      callSessionId: 'call-1',
      endedByIdentityId: 'identity-caller'
    });
    now += 5_000;

    expect(registry.consume({
      familyId: 'family-1',
      callSessionId: 'call-1',
      initiatorIdentityId: 'identity-caller'
    })).toBe(false);
  });

  it('ignores empty call session identifiers and rejects invalid TTLs', () => {
    registry.remember({
      familyId: 'family-1',
      callSessionId: '   ',
      endedByIdentityId: 'identity-caller'
    });
    expect(registry.consume({
      familyId: 'family-1',
      callSessionId: '   ',
      initiatorIdentityId: 'identity-caller'
    })).toBe(false);
    expect(() => new EarlyEndedCallSessionRegistry(0)).toThrow(
      'Early-ended call session TTL must be positive'
    );
  });
});
