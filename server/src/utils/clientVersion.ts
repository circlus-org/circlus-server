/** Header with the client build: platform, app and interface versions. */
export const CLIENT_VERSION_HEADER = 'X-Circlus-Client-Version';

const CLIENT_VERSION_PATTERN = /^[A-Za-z0-9 ._()/+:-]{1,80}$/;

/**
 * The reported client build, or null. Shown to operators so they can see which app
 * versions are still in use before support for an older protocol version ends.
 */
export function normalizeClientVersion(raw: string | null | undefined): string | null {
  const value = String(raw || '').trim();
  return CLIENT_VERSION_PATTERN.test(value) ? value : null;
}
