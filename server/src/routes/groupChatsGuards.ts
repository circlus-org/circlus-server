export type EnvelopeCoverageItem = {
  identityId: string;
  hasEnvelope: boolean;
};

export function buildEnvelopeCoverage(
  participantIdentityIds: string[],
  hasEnvelopeByIdentityId: Record<string, boolean>
): { coverage: EnvelopeCoverageItem[]; missingIdentityIds: string[] } {
  const coverage = participantIdentityIds.map((identityId) => ({
    identityId,
    hasEnvelope: Boolean(hasEnvelopeByIdentityId[identityId])
  }));

  return {
    coverage,
    missingIdentityIds: coverage.filter((item) => !item.hasEnvelope).map((item) => item.identityId)
  };
}

export function senderEnvelopePrecondition(hasSenderEnvelope: boolean):
  | { ok: true }
  | { ok: false; status: number; message: string } {
  if (hasSenderEnvelope) return { ok: true };
  return {
    ok: false,
    status: 412,
    message: 'Group key envelope is missing for sender at current epoch'
  };
}
