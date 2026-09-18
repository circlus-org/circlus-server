import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { ConfigRepository } from './config';
import type { AuthorizedServerConfig } from './types';

const HEADER_SERVER_ID = 'x-ice-server-id';
const HEADER_KEY_ID = 'x-ice-key-id';
const HEADER_TIMESTAMP = 'x-ice-timestamp';
const HEADER_NONCE = 'x-ice-nonce';
const HEADER_BODY_SHA256 = 'x-ice-body-sha256';
const HEADER_SIGNATURE = 'x-ice-signature';

const NONCE_WINDOW_MS = 5 * 60 * 1000;
const usedNonces = new Map<string, number>();

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function sha256Base64Url(body: string): string {
  return base64UrlEncode(crypto.createHash('sha256').update(body, 'utf8').digest());
}

function hmacSha256Base64Url(secret: Buffer, input: string): string {
  return base64UrlEncode(crypto.createHmac('sha256', secret).update(input, 'utf8').digest());
}

function canonicalString(params: {
  method: string;
  path: string;
  timestampMs: string;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    params.method.toUpperCase(),
    params.path,
    params.timestampMs,
    params.nonce,
    params.bodySha256
  ].join('\n');
}

function header(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] || '';
  return raw || '';
}

function deny(res: ServerResponse, statusCode: number, message: string): null {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', error: { message } }));
  return null;
}

function cleanupNonces(now: number): void {
  for (const [key, expiresAt] of usedNonces.entries()) {
    if (expiresAt <= now) usedNonces.delete(key);
  }
}

export function verifyIceServiceAuth(params: {
  req: IncomingMessage;
  res: ServerResponse;
  body: string;
  repository: ConfigRepository;
}): AuthorizedServerConfig | null {
  const serverId = header(params.req, HEADER_SERVER_ID);
  const keyId = header(params.req, HEADER_KEY_ID);
  const timestampMs = header(params.req, HEADER_TIMESTAMP);
  const nonce = header(params.req, HEADER_NONCE);
  const bodySha256 = header(params.req, HEADER_BODY_SHA256);
  const signature = header(params.req, HEADER_SIGNATURE);

  if (!serverId || !keyId || !timestampMs || !nonce || !bodySha256 || !signature) {
    return deny(params.res, 401, 'Missing ICE service auth headers');
  }

  const now = Date.now();
  cleanupNonces(now);
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > NONCE_WINDOW_MS) {
    return deny(params.res, 401, 'ICE service auth timestamp is outside the allowed window');
  }

  const nonceKey = `${serverId}:${keyId}:${nonce}`;
  if (usedNonces.has(nonceKey)) {
    return deny(params.res, 401, 'ICE service auth nonce was already used');
  }

  const authorizedServer = params.repository.getAuthorizedServer(serverId, keyId);
  if (!authorizedServer || authorizedServer.status === 'disabled') {
    return deny(params.res, 403, 'ICE service server is not active');
  }

  const actualBodySha256 = sha256Base64Url(params.body);
  if (bodySha256 !== actualBodySha256) {
    return deny(params.res, 401, 'ICE service body hash mismatch');
  }

  const url = new URL(params.req.url || '/', 'http://localhost');
  const canon = canonicalString({
    method: params.req.method || 'GET',
    path: url.pathname,
    timestampMs,
    nonce,
    bodySha256
  });
  const expected = hmacSha256Base64Url(Buffer.from(authorizedServer.s2sSharedSecret, 'base64'), canon);

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return deny(params.res, 401, 'ICE service signature mismatch');
  }

  usedNonces.set(nonceKey, now + NONCE_WINDOW_MS);
  return authorizedServer;
}

export function getIceAuthHeader(req: IncomingMessage, name: 'serverId' | 'keyId'): string {
  return header(req, name === 'serverId' ? HEADER_SERVER_ID : HEADER_KEY_ID);
}
