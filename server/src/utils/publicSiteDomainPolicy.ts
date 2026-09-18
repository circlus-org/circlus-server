import { normalizeHost } from '../middleware/tenancy';
import { getPublicAccessRuntimeConfig } from '../config/serverRuntimeConfig';

/**
 * Circlus-managed subdomain suffixes where public-site publishing must be
 * blocked. This is a denylist rather than an allowlist: independent server
 * owners may publish from any domain that is not explicitly blocked.
 */
export function getBlockedDomainSuffixes(): string[] {
  return [...getPublicAccessRuntimeConfig().blockedPublicSiteDomainSuffixes];
}

/**
 * True if `host` is the blocked suffix itself or a subdomain of it
 * (`foo.space.circlus.org` is blocked; `myspace.circlus.org` is NOT, since it
 * is not a subdomain of `space.circlus.org` even though it ends with the same
 * characters).
 */
export function isBlockedManagedHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const normalized = normalizeHost(host);
  if (!normalized) return false;

  return getBlockedDomainSuffixes().some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`)
  );
}

export function getPublicSiteProductUrl(): string {
  return getPublicAccessRuntimeConfig().publicSiteProductUrl;
}
