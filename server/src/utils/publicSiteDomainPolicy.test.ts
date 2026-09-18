import { getBlockedDomainSuffixes, isBlockedManagedHost, getPublicSiteProductUrl } from './publicSiteDomainPolicy';

describe('publicSiteDomainPolicy', () => {
  const originalSuffixes = process.env.CIRCLUS_PUBLIC_SITE_BLOCKED_DOMAIN_SUFFIXES;
  const originalUrl = process.env.CIRCLUS_PUBLIC_SITE_URL;

  afterEach(() => {
    if (originalSuffixes === undefined) delete process.env.CIRCLUS_PUBLIC_SITE_BLOCKED_DOMAIN_SUFFIXES;
    else process.env.CIRCLUS_PUBLIC_SITE_BLOCKED_DOMAIN_SUFFIXES = originalSuffixes;
    if (originalUrl === undefined) delete process.env.CIRCLUS_PUBLIC_SITE_URL;
    else process.env.CIRCLUS_PUBLIC_SITE_URL = originalUrl;
  });

  describe('default suffix list', () => {
    beforeEach(() => {
      delete process.env.CIRCLUS_PUBLIC_SITE_BLOCKED_DOMAIN_SUFFIXES;
    });

    test('defaults to space.circlus.org', () => {
      expect(getBlockedDomainSuffixes()).toEqual(['space.circlus.org']);
    });

    test('blocks the suffix itself', () => {
      expect(isBlockedManagedHost('space.circlus.org')).toBe(true);
    });

    test('blocks a subdomain of the suffix', () => {
      expect(isBlockedManagedHost('family.space.circlus.org')).toBe(true);
      expect(isBlockedManagedHost('a.b.space.circlus.org')).toBe(true);
    });

    test('does NOT block a host that merely ends with the same characters', () => {
      expect(isBlockedManagedHost('myspace.circlus.org')).toBe(false);
      expect(isBlockedManagedHost('notspace.circlus.org')).toBe(false);
    });

    test('does NOT block an unrelated domain', () => {
      expect(isBlockedManagedHost('family.example.com')).toBe(false);
      expect(isBlockedManagedHost('circlus.org')).toBe(false);
    });

    test('normalizes case, port, and trailing dot', () => {
      expect(isBlockedManagedHost('Family.SPACE.circlus.org:443')).toBe(true);
      expect(isBlockedManagedHost('family.space.circlus.org.')).toBe(true);
    });

    test('handles null/empty host', () => {
      expect(isBlockedManagedHost(null)).toBe(false);
      expect(isBlockedManagedHost(undefined)).toBe(false);
      expect(isBlockedManagedHost('')).toBe(false);
    });
  });

  describe('custom suffix list via env', () => {
    test('parses comma-separated suffixes', () => {
      process.env.CIRCLUS_PUBLIC_SITE_BLOCKED_DOMAIN_SUFFIXES = 'space.circlus.org, staging.circlus.org';
      expect(getBlockedDomainSuffixes()).toEqual(['space.circlus.org', 'staging.circlus.org']);
      expect(isBlockedManagedHost('foo.staging.circlus.org')).toBe(true);
    });

    test('ignores empty/whitespace-only entries', () => {
      process.env.CIRCLUS_PUBLIC_SITE_BLOCKED_DOMAIN_SUFFIXES = 'space.circlus.org,, ,';
      expect(getBlockedDomainSuffixes()).toEqual(['space.circlus.org']);
    });

    test('falls back to default when env is empty/whitespace-only', () => {
      process.env.CIRCLUS_PUBLIC_SITE_BLOCKED_DOMAIN_SUFFIXES = '   ';
      expect(getBlockedDomainSuffixes()).toEqual(['space.circlus.org']);
    });
  });

  describe('getPublicSiteProductUrl', () => {
    test('defaults to https://circlus.org', () => {
      delete process.env.CIRCLUS_PUBLIC_SITE_URL;
      expect(getPublicSiteProductUrl()).toBe('https://circlus.org');
    });

    test('uses the configured value', () => {
      process.env.CIRCLUS_PUBLIC_SITE_URL = 'https://custom.example.com';
      expect(getPublicSiteProductUrl()).toBe('https://custom.example.com');
    });
  });
});
