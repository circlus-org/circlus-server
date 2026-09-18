import type { SignedRequest } from './types';

export function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalizeJsonValue(nestedValue)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

/**
 * Create canonical message to sign from signed request fields.
 *
 * IMPORTANT: Any change here is a protocol change and must be coordinated
 * between client and server.
 */
export function createSignatureMessage<T>(
  request: Omit<SignedRequest<T>, 'signature'>
): string {
  return canonicalizeJson(request);
}
