import { describe, expect, test } from '@jest/globals';
import {
  SIGNED_PROTOCOL_RANGES,
  SIGNED_PROTOCOL_VERSIONS,
  negotiateSignedProtocolVersion,
  signedProtocolUpdateDeadline,
  supportsSignedProtocolRanges,
  type SignedProtocolRanges
} from '../../../shared/protocolVersions';

function rangesWith(overrides: Partial<SignedProtocolRanges>): SignedProtocolRanges {
  return { ...SIGNED_PROTOCOL_RANGES, ...overrides } as SignedProtocolRanges;
}

describe('signed protocol ranges', () => {
  const current = SIGNED_PROTOCOL_VERSIONS.signedRequestEnvelope;

  test('each protocol currently accepts exactly its current version', () => {
    for (const [name, version] of Object.entries(SIGNED_PROTOCOL_VERSIONS)) {
      expect(SIGNED_PROTOCOL_RANGES[name as keyof typeof SIGNED_PROTOCOL_VERSIONS]).toEqual({ min: version, max: version });
    }
    expect(supportsSignedProtocolRanges(SIGNED_PROTOCOL_RANGES)).toBe(true);
  });

  test('a server that also keeps the previous version serves an older client', () => {
    const olderClient = rangesWith({ signedRequestEnvelope: { min: current - 1, max: current - 1 } });
    const server = rangesWith({ signedRequestEnvelope: { min: current - 1, max: current } });
    expect(negotiateSignedProtocolVersion('signedRequestEnvelope', server, olderClient)).toBe(current - 1);
    expect(supportsSignedProtocolRanges(server, olderClient)).toBe(true);
    expect(negotiateSignedProtocolVersion('signedRequestEnvelope', server)).toBe(current);
  });

  test('fails closed without a common version or with a malformed range', () => {
    const newerServer = rangesWith({ signedRequestEnvelope: { min: current + 1, max: current + 1 } });
    expect(supportsSignedProtocolRanges(newerServer)).toBe(false);
    expect(supportsSignedProtocolRanges({ ...SIGNED_PROTOCOL_RANGES, deviceEnrollment: { min: 3, max: 1 } })).toBe(false);
    const missing: Record<string, unknown> = { ...SIGNED_PROTOCOL_RANGES };
    delete missing.circleMigration;
    expect(supportsSignedProtocolRanges(missing)).toBe(false);
    expect(supportsSignedProtocolRanges(undefined)).toBe(false);
  });

  test('reports when a newer server stops accepting this build', () => {
    const server = rangesWith({
      signedRequestEnvelope: { min: current, max: current + 1, minRaisesAt: '2027-03-01T00:00:00.000Z' },
      deviceEnrollment: {
        min: SIGNED_PROTOCOL_VERSIONS.deviceEnrollment,
        max: SIGNED_PROTOCOL_VERSIONS.deviceEnrollment + 1,
        minRaisesAt: '2027-02-01T00:00:00.000Z'
      }
    });
    expect(signedProtocolUpdateDeadline(server)).toBe('2027-02-01T00:00:00.000Z');
    // A date on a protocol where this build is already current does not apply.
    const sameVersion = rangesWith({ signedRequestEnvelope: { min: current, max: current, minRaisesAt: '2027-01-01T00:00:00.000Z' } });
    expect(signedProtocolUpdateDeadline(sameVersion)).toBeNull();
  });
});
