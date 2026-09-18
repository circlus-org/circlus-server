function isProbablyLocalhostHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host.startsWith('127.0.0.1:') ||
    host === '::1' ||
    host.startsWith('::1:') ||
    host === '[::1]' ||
    host.startsWith('[::1]:')
  );
}

export function normalizePublicServerUrl(input?: string | null): string | undefined {
  const raw = String(input || '').trim();
  if (!raw) return undefined;

  const noTrailingSlash = raw.replace(/\/+$/, '');
  if (!noTrailingSlash) return undefined;

  if (noTrailingSlash.startsWith('http://') || noTrailingSlash.startsWith('https://')) {
    try {
      const url = new URL(noTrailingSlash);
      return url.origin;
    } catch {
      return undefined;
    }
  }

  const scheme = isProbablyLocalhostHost(noTrailingSlash) ? 'http' : 'https';
  try {
    return new URL(`${scheme}://${noTrailingSlash}`).origin;
  } catch {
    return undefined;
  }
}

export function resolveServerIdForClients(publicBaseUrl: string): string {
  return normalizePublicServerUrl(publicBaseUrl) ?? 'default-server';
}
