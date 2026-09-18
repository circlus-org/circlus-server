import { buildEnvelopeCoverage, senderEnvelopePrecondition } from './groupChatsGuards';

describe('group chat guards', () => {
  test('buildEnvelopeCoverage returns coverage and missing ids', () => {
    const result = buildEnvelopeCoverage(['u1', 'u2', 'u3'], {
      u1: true,
      u2: false,
      u3: true
    });

    expect(result.coverage).toEqual([
      { identityId: 'u1', hasEnvelope: true },
      { identityId: 'u2', hasEnvelope: false },
      { identityId: 'u3', hasEnvelope: true }
    ]);
    expect(result.missingIdentityIds).toEqual(['u2']);
  });

  test('senderEnvelopePrecondition returns 412 when missing', () => {
    expect(senderEnvelopePrecondition(true)).toEqual({ ok: true });
    expect(senderEnvelopePrecondition(false)).toEqual({
      ok: false,
      status: 412,
      message: 'Group key envelope is missing for sender at current epoch'
    });
  });
});
