export const PUBLIC_INITIAL_SCHEMA_VERSION = '001_initial_schema.sql';

/**
 * Last pre-public migration folded into the public initial schema. A database
 * with this recorded migration can adopt 001 without executing its DDL again.
 */
export const PRE_PUBLIC_BASELINE_COMPLETION_VERSION =
  '000-pre-public/168_direct_guest_membership_promotion.sql';

export function shouldAdoptPublicInitialSchema(
  migrationVersion: string,
  appliedVersions: ReadonlySet<string>
): boolean {
  return migrationVersion === PUBLIC_INITIAL_SCHEMA_VERSION
    && appliedVersions.has(PRE_PUBLIC_BASELINE_COMPLETION_VERSION);
}
