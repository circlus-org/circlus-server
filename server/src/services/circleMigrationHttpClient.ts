import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isBlockedIpAddress } from '../utils/safeHttpFetch';
import { normalizePublicServerUrl } from '../utils/serverIdentity';
import {
  getCircleMigrationRuntimeConfig,
  getServerIdentityRuntimeConfig
} from '../config/serverRuntimeConfig';

const MAX_RESPONSE_BYTES = 256 * 1024;

export class CircleMigrationHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: unknown,
    message: string
  ) {
    super(message);
  }
}

function isLocalDevelopmentUrl(url: URL): boolean {
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return getServerIdentityRuntimeConfig().nodeEnvironment !== 'production'
    && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1');
}

async function resolvePinnedAddress(url: URL): Promise<{ address: string; family: 4 | 6 } | null> {
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isLocalDevelopmentUrl(url)) {
    const family = net.isIP(hostname);
    return family === 4 || family === 6 ? { address: hostname, family } : null;
  }
  if (url.protocol !== 'https:') {
    throw new Error('Migration service endpoint must use HTTPS');
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedIpAddress(hostname)) throw new Error('Migration service endpoint resolves to a private address');
    return { address: hostname, family: literalFamily };
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new Error('Migration service endpoint resolves to a private address');
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

export async function postCircleMigrationJson<T>(
  serviceEndpoint: string,
  path: string,
  payload: unknown,
  options: { authorization?: string } = {}
): Promise<T> {
  const normalized = normalizePublicServerUrl(serviceEndpoint);
  if (!normalized) throw new Error('Migration service endpoint is invalid');
  const baseUrl = new URL(normalized);
  const pinned = await resolvePinnedAddress(baseUrl);
  if (!pinned && !isLocalDevelopmentUrl(baseUrl)) {
    throw new Error('Migration service endpoint could not be resolved');
  }

  const requestUrl = new URL(path, `${baseUrl.origin}/`);
  if (requestUrl.origin !== baseUrl.origin) {
    throw new Error('Migration request path changed the service origin');
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const timeoutMs = getCircleMigrationRuntimeConfig().httpTimeoutMs;
  const transport = requestUrl.protocol === 'https:' ? https : http;

  return new Promise<T>((resolve, reject) => {
    const request = transport.request({
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port || undefined,
      method: 'POST',
      path: `${requestUrl.pathname}${requestUrl.search}`,
      servername: requestUrl.protocol === 'https:' ? requestUrl.hostname : undefined,
      rejectUnauthorized: requestUrl.protocol === 'https:',
      // Node's Happy Eyeballs connection logic (default since Node 20) calls
      // this with `{ all: true }` and expects an address array; older
      // single-address call sites expect (err, address, family). Support
      // both, otherwise real (non-localhost) migration targets fail to
      // connect with ERR_INVALID_IP_ADDRESS.
      lookup: pinned
        ? ((_hostname, lookupOptions, callback) => {
            if (typeof lookupOptions === 'object' && lookupOptions !== null && lookupOptions.all) {
              callback(null, [{ address: pinned.address, family: pinned.family }]);
            } else {
              callback(null, pinned.address, pinned.family);
            }
          })
        : undefined,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(body.length),
        'user-agent': 'Circlus-Circle-Migration/1',
        ...(options.authorization ? { authorization: options.authorization } : {})
      },
      timeout: timeoutMs
    }, (response) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('Migration response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          reject(new Error('Migration service returned invalid JSON'));
          return;
        }
        const status = response.statusCode || 500;
        if (status >= 300 && status < 400) {
          reject(new CircleMigrationHttpError(status, parsed, 'Migration service redirects are forbidden'));
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new CircleMigrationHttpError(status, parsed, `Migration service returned HTTP ${status}`));
          return;
        }
        resolve(parsed as T);
      });
    });
    request.once('timeout', () => request.destroy(new Error('Migration service request timed out')));
    request.once('error', reject);
    request.end(body);
  });
}
