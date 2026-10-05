import type { DBFamilyConfig } from '../db/types';
import { isTrustedClientOrigin, normalizeTrustedOrigin } from './trustedOrigins';

/** A native SDK has no browser Origin; only a current committed QR reservation can admit it. */
export function admittedDeviceEnrollmentSource(input: {
  originHeader: string | undefined;
  sdkHeader: string | undefined;
  bootstrapCommitment: string | null | undefined;
  familyConfig: DBFamilyConfig;
}): string | null {
  const origin = normalizeTrustedOrigin(input.originHeader);
  if (input.originHeader) {
    return origin && isTrustedClientOrigin(origin, input.familyConfig) ? origin : null;
  }
  if (input.sdkHeader === 'node-v1' && input.bootstrapCommitment) {
    return 'Circlus SDK (Node)';
  }
  return null;
}
