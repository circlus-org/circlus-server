import {
  booleanSetting,
  httpUrlSetting,
  integerSetting
} from './runtimeConfigParsing';

export type PublicAccessRuntimeConfig = {
  appOpenUrl: string;
  publicSiteProductUrl: string;
  blockedPublicSiteDomainSuffixes: string[];
  trustedClientOrigins: string[];
  tenantValidation: { dnsCheck: boolean; tlsCheck: boolean; tlsTimeoutMs: number };
};

function normalizedOrigin(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function trustedClientOrigins(environment: NodeJS.ProcessEnv): string[] {
  const configured = String(environment.TRUSTED_CLIENT_ORIGINS || '')
    .split(',')
    .map((entry) => normalizedOrigin(entry))
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(['https://web.circlus.org', ...configured]));
}

function normalizeDomainSuffix(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '').split(':')[0];
}

function blockedPublicSiteDomainSuffixes(environment: NodeJS.ProcessEnv): string[] {
  const configured = String(environment.CIRCLUS_PUBLIC_SITE_BLOCKED_DOMAIN_SUFFIXES || '')
    .split(',')
    .map((entry) => normalizeDomainSuffix(entry))
    .filter(Boolean);
  return configured.length > 0 ? Array.from(new Set(configured)) : ['space.circlus.org'];
}

export function loadPublicAccessRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): PublicAccessRuntimeConfig {
  return {
    appOpenUrl: httpUrlSetting(
      environment,
      'CIRCLUS_APP_OPEN_URL',
      'https://web.circlus.org/open'
    ),
    publicSiteProductUrl: httpUrlSetting(
      environment,
      'CIRCLUS_PUBLIC_SITE_URL',
      'https://circlus.org'
    ),
    blockedPublicSiteDomainSuffixes: blockedPublicSiteDomainSuffixes(environment),
    trustedClientOrigins: trustedClientOrigins(environment),
    tenantValidation: {
      dnsCheck: booleanSetting({
        environment, key: 'SERVER_ADMIN_TENANT_DNS_CHECK', defaultValue: true
      }),
      tlsCheck: booleanSetting({
        environment, key: 'SERVER_ADMIN_TENANT_TLS_CHECK', defaultValue: true
      }),
      tlsTimeoutMs: integerSetting({
        environment, key: 'SERVER_ADMIN_TENANT_TLS_TIMEOUT_MS', defaultValue: 5_000, min: 500, max: 60_000
      })
    }
  };
}
