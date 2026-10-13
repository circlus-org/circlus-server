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

/**
 * Versions of one signed protocol a build accepts. During a compatibility
 * support window, `min` stays at the previous version; `minRaisesAt` announces
 * when it becomes `max`, so older apps can remind their users to update in time.
 */
export type SignedProtocolRange = {
  min: number;
  max: number;
  minRaisesAt?: string;
};

export type SignedProtocolRanges = {
  [K in keyof typeof SIGNED_PROTOCOL_VERSIONS]: SignedProtocolRange;
};

type SignedProtocolName = keyof typeof SIGNED_PROTOCOL_VERSIONS;

/**
 * The ranges this build accepts. Each protocol supports only its current version
 * until a version change adds the previous format back as `min`.
 */
export const SIGNED_PROTOCOL_RANGES: SignedProtocolRanges = Object.freeze(
  Object.fromEntries(
    (Object.entries(SIGNED_PROTOCOL_VERSIONS) as Array<[SignedProtocolName, number]>)
      .map(([name, version]) => [name, Object.freeze({ min: version, max: version })])
  ) as SignedProtocolRanges
);

function readRange(value: unknown): SignedProtocolRange | null {
  if (!value || typeof value !== 'object') return null;
  const range = value as Record<string, unknown>;
  const min = range.min;
  const max = range.max;
  if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) > (max as number)) return null;
  const minRaisesAt = typeof range.minRaisesAt === 'string' ? range.minRaisesAt : undefined;
  return { min: min as number, max: max as number, ...(minRaisesAt ? { minRaisesAt } : {}) };
}

/** The highest version both sides accept, or null when their ranges do not overlap. */
export function negotiateSignedProtocolVersion(
  name: SignedProtocolName,
  remoteRanges: unknown,
  localRanges: SignedProtocolRanges = SIGNED_PROTOCOL_RANGES
): number | null {
  const remote = readRange((remoteRanges as Record<string, unknown> | null | undefined)?.[name]);
  if (!remote) return null;
  const local = localRanges[name];
  const version = Math.min(local.max, remote.max);
  return version >= Math.max(local.min, remote.min) ? version : null;
}

/** Fails closed: every protocol this build knows must have a common version. */
export function supportsSignedProtocolRanges(
  remoteRanges: unknown,
  localRanges: SignedProtocolRanges = SIGNED_PROTOCOL_RANGES
): boolean {
  if (!remoteRanges || typeof remoteRanges !== 'object') return false;
  return (Object.keys(localRanges) as SignedProtocolName[])
    .every((name) => negotiateSignedProtocolVersion(name, remoteRanges, localRanges) !== null);
}

/**
 * The earliest date on which the remote side stops accepting a version this build
 * still relies on, or null. Only protocols where the remote side already supports a
 * newer version count: their `minRaisesAt` cuts this build off.
 */
export function signedProtocolUpdateDeadline(
  remoteRanges: unknown,
  localRanges: SignedProtocolRanges = SIGNED_PROTOCOL_RANGES
): string | null {
  if (!remoteRanges || typeof remoteRanges !== 'object') return null;
  let earliest: { at: number; value: string } | null = null;
  for (const name of Object.keys(localRanges) as SignedProtocolName[]) {
    const remote = readRange((remoteRanges as Record<string, unknown>)[name]);
    if (!remote?.minRaisesAt || remote.max <= localRanges[name].max) continue;
    const at = Date.parse(remote.minRaisesAt);
    if (!Number.isFinite(at)) continue;
    if (!earliest || at < earliest.at) earliest = { at, value: remote.minRaisesAt };
  }
  return earliest?.value ?? null;
}

/** Header with the newest version of each signed protocol the client build supports. */
export const CLIENT_PROTOCOLS_HEADER = 'X-Circlus-Client-Protocols';

/** e.g. "signedRequestEnvelope=3,circleMembership=2,…" from this build's ranges. */
export function formatClientProtocolsReport(localRanges: SignedProtocolRanges = SIGNED_PROTOCOL_RANGES): string {
  return (Object.keys(localRanges) as SignedProtocolName[])
    .map((name) => `${name}=${localRanges[name].max}`)
    .join(',');
}

/**
 * Known protocols with their reported newest version, or null for a malformed report.
 * Names this build does not know are skipped: a newer client may report more protocols.
 */
export function parseClientProtocolsReport(raw: string | null | undefined): Partial<SignedProtocolVersions> | null {
  const value = String(raw || '').trim();
  if (!value || value.length > 512) return null;
  const known = new Set(Object.keys(SIGNED_PROTOCOL_VERSIONS));
  const report: Partial<Record<SignedProtocolName, number>> = {};
  for (const entry of value.split(',')) {
    const match = /^([A-Za-z]{1,64})=([1-9][0-9]{0,3})$/.exec(entry.trim());
    if (!match) return null;
    if (known.has(match[1])) report[match[1] as SignedProtocolName] = Number(match[2]);
  }
  return Object.keys(report).length > 0 ? report : null;
}

/**
 * Protocols for which a client with this report is not ready for the newest version this
 * server accepts, with the date the server stops accepting older ones (null when no date
 * is announced). Missing protocols count as not ready.
 */
export function outdatedClientProtocols(
  report: Partial<SignedProtocolVersions> | null,
  serverRanges: SignedProtocolRanges = SIGNED_PROTOCOL_RANGES
): Array<{ name: SignedProtocolName; reported: number | null; required: number; minRaisesAt: string | null }> {
  return (Object.keys(serverRanges) as SignedProtocolName[])
    .filter((name) => (report?.[name] ?? 0) < serverRanges[name].max)
    .map((name) => ({
      name,
      reported: report?.[name] ?? null,
      required: serverRanges[name].max,
      minRaisesAt: serverRanges[name].minRaisesAt ?? null,
    }));
}
