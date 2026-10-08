import type { DBFamilyConfig } from '../db/types';
import { getPublicAccessRuntimeConfig } from '../config/serverRuntimeConfig';
import { IOS_BUNDLED_CLIENT_ORIGIN } from '../config/officialClientOrigins';

const IOS_BUNDLED_CLIENT = new URL(IOS_BUNDLED_CLIENT_ORIGIN);

export function normalizeTrustedOrigin(raw: string | null | undefined): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    // The only accepted non-HTTP origin. URL.origin is "null" for custom schemes,
    // so it is compared part by part.
    if (parsed.protocol === IOS_BUNDLED_CLIENT.protocol) {
      // Hosts of custom schemes keep their case in URL; origins compare case-insensitively.
      return parsed.host.toLowerCase() === IOS_BUNDLED_CLIENT.host && !parsed.username && !parsed.password
        ? IOS_BUNDLED_CLIENT_ORIGIN
        : null;
    }
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function parseTrustedOriginsList(raw: string | null | undefined): string[] {
  return Array.from(
    new Set(
      String(raw || '')
        .split(',')
        .map((entry) => normalizeTrustedOrigin(entry))
        .filter((value): value is string => Boolean(value))
    )
  );
}

export function getGlobalTrustedClientOrigins(): string[] {
  return [...getPublicAccessRuntimeConfig().trustedClientOrigins];
}

export function getFamilyTrustedClientOrigins(config: DBFamilyConfig | null | undefined): string[] {
  const raw = Array.isArray(config?.extra_trusted_client_origins) ? config!.extra_trusted_client_origins : [];
  return Array.from(
    new Set(
      raw
        .map((entry) => normalizeTrustedOrigin(entry))
        .filter((value): value is string => Boolean(value))
    )
  );
}

export function getEffectiveTrustedClientOrigins(config: DBFamilyConfig | null | undefined): string[] {
  return Array.from(new Set([
    ...getGlobalTrustedClientOrigins(),
    ...getFamilyTrustedClientOrigins(config),
  ]));
}

export function isTrustedClientOrigin(origin: string | null | undefined, config: DBFamilyConfig | null | undefined): boolean {
  const normalized = normalizeTrustedOrigin(origin);
  if (!normalized) return false;
  return getEffectiveTrustedClientOrigins(config).includes(normalized);
}
