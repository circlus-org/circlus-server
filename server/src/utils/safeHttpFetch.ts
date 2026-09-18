import { lookup } from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const DEFAULT_MAX_REDIRECTS = 3;

export type SafeFetchResult = {
  body: Buffer;
  contentType: string;
  finalUrl: string;
};

export type SafeFetchOptions = {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  userAgent?: string;
};

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  );
}

export function isBlockedIpAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) {
    // WHATWG URL canonicalizes expanded, compressed and dotted IPv6 forms.
    // Always classify the embedded IPv4 address, including hex DNS AAAA answers.
    const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
    const mapped = canonical.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      return isPrivateIpv4([high >>> 8, high & 255, low >>> 8, low & 255].join('.'));
    }
    return isBlockedIpv6(canonical);
  }
  return true;
}

type PinnedAddress = { address: string; family: 4 | 6 };

/**
 * Resolves and validates the address that will actually be connected to.
 * The caller must reuse the returned address for the connection (via a
 * pinned `lookup`) rather than re-resolving the hostname later — an
 * intervening DNS answer change (DNS rebinding) would otherwise let a
 * public-IP check here be paired with a private-IP connection made later.
 */
async function resolvePinnedSafeAddress(url: URL): Promise<PinnedAddress> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http/https URLs are allowed');
  }

  if (!url.hostname || isBlockedHostname(url.hostname)) {
    throw new Error('Private URLs are not allowed');
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const literalIpVersion = net.isIP(hostname);
  if (literalIpVersion !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error('Private URLs are not allowed');
    }
    return { address: hostname, family: literalIpVersion as 4 | 6 };
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new Error('Private URLs are not allowed');
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

/**
 * Validates that a URL is currently safe to fetch. Kept for callers that
 * want an early validation error message to show the user. This check is
 * necessarily a point-in-time snapshot — safeHttpFetch() re-resolves and
 * pins its own address for the connection it actually makes, so it remains
 * safe even if DNS answers change between this call and the real fetch.
 */
export async function assertSafePublicHttpUrl(url: URL): Promise<void> {
  await resolvePinnedSafeAddress(url);
}

type RawFetchResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function fetchPinned(url: URL, pinned: PinnedAddress, options: SafeFetchOptions): Promise<RawFetchResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const transport = url.protocol === 'https:' ? https : http;
    const hostnameForTls = url.hostname.replace(/^\[(.*)\]$/, '$1');

    const clearDeadline = () => {
      if (deadline) {
        clearTimeout(deadline);
        deadline = null;
      }
    };

    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      servername: url.protocol === 'https:' ? hostnameForTls : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      // Pin the connection to the address we already validated instead of
      // letting the transport resolve the hostname again on its own. Node's
      // Happy Eyeballs connection logic (default since Node 20) calls this
      // with `{ all: true }` and expects an address array; older single-
      // address call sites expect (err, address, family). Support both.
      lookup: (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === 'object' && lookupOptions !== null && lookupOptions.all) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      },
      headers: {
        'user-agent': options.userAgent || 'Mozilla/5.0 (compatible; Circlus/1.0; +https://circlus.org)'
      }
      // No `timeout` option here: that's an *idle* socket timeout, reset by
      // every byte received, so a server trickling one byte every few
      // seconds could keep the request open indefinitely. The explicit
      // deadline timer below is a real wall-clock cap regardless of
      // activity, matching the original AbortController-based behavior.
    }, (response) => {
      // Check the status before touching the body at all. A 3xx doesn't
      // need its body read/buffered just to read the Location header, and
      // doing so anyway would burn up to maxBytes (and the deadline below)
      // on every redirect hop for no reason.
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        if (settled) return;
        settled = true;
        clearDeadline();
        // Do not keep draining a redirect body after resolving the promise:
        // once the wall-clock deadline is cleared, a trickling peer could
        // otherwise retain the socket indefinitely in the background.
        response.destroy();
        resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.alloc(0) });
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearDeadline();
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks)
        });
      };

      response.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        chunks.push(chunk);
        if (totalBytes >= options.maxBytes) {
          response.destroy();
          finish();
        }
      });
      response.on('end', finish);
      response.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        reject(error);
      });
    });

    request.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    });

    // A real wall-clock deadline, independent of socket activity. Node's
    // request `timeout` option is only an idle-socket timeout.
    deadline = setTimeout(() => {
      request.destroy(new Error('Request timed out'));
    }, options.timeoutMs);
    request.end();
  });
}

export async function safeHttpFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult | null> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl: URL;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    let pinned: PinnedAddress;
    try {
      pinned = await resolvePinnedSafeAddress(currentUrl);
    } catch {
      return null;
    }

    let response: RawFetchResponse;
    try {
      response = await fetchPinned(currentUrl, pinned, options);
    } catch {
      return null;
    }

    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = firstHeaderValue(response.headers.location);
      if (!location || redirectCount === maxRedirects) return null;
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        return null;
      }
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) return null;

    return {
      body: response.body,
      contentType: firstHeaderValue(response.headers['content-type']),
      finalUrl: currentUrl.toString()
    };
  }

  return null;
}
