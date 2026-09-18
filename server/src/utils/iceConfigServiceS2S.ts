import crypto from 'crypto';
import { getIntegrationRuntimeConfig } from '../config/serverRuntimeConfig';

const HEADER_SERVER_ID = 'X-Ice-Server-Id';
const HEADER_KEY_ID = 'X-Ice-Key-Id';
const HEADER_TIMESTAMP = 'X-Ice-Timestamp';
const HEADER_NONCE = 'X-Ice-Nonce';
const HEADER_BODY_SHA256 = 'X-Ice-Body-Sha256';
const HEADER_SIGNATURE = 'X-Ice-Signature';

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

export function signIceConfigServiceRequest(params: {
  method: 'POST';
  path: string;
  body: string;
}): Record<string, string> {
  const config = getIntegrationRuntimeConfig().ice;
  const vpsId = config.vpsId;
  if (!vpsId) {
    throw new Error('VPS_ID or ICE_CONFIG_SERVER_ID is required for ICE config service auth');
  }
  const keyId = config.keyId;
  const secretB64 = config.sharedSecretBase64;
  if (!secretB64) {
    throw new Error('ICE_CONFIG_SHARED_SECRET is required for ICE config service auth');
  }
  const secret = Buffer.from(secretB64, 'base64');

  const timestampMs = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('base64url');
  const bodySha256 = sha256Base64Url(params.body || '');
  const canon = canonicalString({
    method: params.method,
    path: params.path,
    timestampMs,
    nonce,
    bodySha256
  });

  return {
    [HEADER_SERVER_ID]: vpsId,
    [HEADER_KEY_ID]: keyId,
    [HEADER_TIMESTAMP]: timestampMs,
    [HEADER_NONCE]: nonce,
    [HEADER_BODY_SHA256]: bodySha256,
    [HEADER_SIGNATURE]: hmacSha256Base64Url(secret, canon)
  };
}
