import crypto from 'crypto';
import { getIntegrationRuntimeConfig } from '../config/serverRuntimeConfig';

const HEADER_CLIENT_ID = 'X-Push-Client-Id';
const HEADER_KEY_ID = 'X-Push-Key-Id';
const HEADER_TIMESTAMP = 'X-Push-Timestamp';
const HEADER_NONCE = 'X-Push-Nonce';
const HEADER_BODY_SHA256 = 'X-Push-Body-Sha256';
const HEADER_SIGNATURE = 'X-Push-Signature';

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

export function signPushServiceRequest(params: {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body: string;
}): Record<string, string> {
  const config = getIntegrationRuntimeConfig().push;
  const clientId = config.clientId;
  if (!clientId) {
    throw new Error('PUSH_SERVICE_CLIENT_ID is required for push-service S2S auth');
  }
  const keyId = config.keyId;
  const secretB64 = config.sharedSecretBase64;
  if (!secretB64) {
    throw new Error('PUSH_SERVICE_SHARED_SECRET is required for push-service S2S auth');
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
  const signature = hmacSha256Base64Url(secret, canon);

  return {
    [HEADER_CLIENT_ID]: clientId,
    [HEADER_KEY_ID]: keyId,
    [HEADER_TIMESTAMP]: timestampMs,
    [HEADER_NONCE]: nonce,
    [HEADER_BODY_SHA256]: bodySha256,
    [HEADER_SIGNATURE]: signature
  };
}

export const PUSH_SERVICE_S2S_HEADERS = {
  HEADER_CLIENT_ID,
  HEADER_KEY_ID,
  HEADER_TIMESTAMP,
  HEADER_NONCE,
  HEADER_BODY_SHA256,
  HEADER_SIGNATURE
};
