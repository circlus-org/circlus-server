/** Versions are explicit compatibility boundaries. Unsupported versions must fail closed. */
export const CAPABILITIES_DOCUMENT_VERSION = 2 as const;

export const SIGNED_PROTOCOL_VERSIONS = Object.freeze({
  signedRequestEnvelope: 3,
  circleMembership: 2,
  circleInviteMembershipCheckpoint: 2,
  linkCapability: 2,
  circleMigration: 2,
  deviceEnrollment: 2,
} as const);

export type SignedProtocolVersions = {
  [K in keyof typeof SIGNED_PROTOCOL_VERSIONS]: number;
};

export function supportsCurrentSignedProtocols(value: unknown): value is SignedProtocolVersions {
  if (!value || typeof value !== 'object') return false;
  const versions = value as Record<string, unknown>;
  return Object.entries(SIGNED_PROTOCOL_VERSIONS).every(([name, version]) => versions[name] === version);
}
