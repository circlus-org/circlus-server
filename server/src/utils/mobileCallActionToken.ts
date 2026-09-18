import crypto from 'crypto';
import { getIntegrationRuntimeConfig } from '../config/serverRuntimeConfig';

export type MobileCallActionTokenPayload = {
  familyId: string;
  callSessionId: string;
  targetIdentityId: string;
  action: 'decline';
  exp: number;
};

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function getMobileCallActionSecret(): Buffer {
  const raw = getIntegrationRuntimeConfig().mobileCalls.actionSecret;
  if (!raw) {
    throw new Error('MOBILE_CALL_ACTION_SECRET must be configured');
  }
  return Buffer.from(raw, 'utf8');
}

function signEncodedPayload(encodedPayload: string, secret: Buffer): string {
  return crypto.createHmac('sha256', secret).update(encodedPayload, 'utf8').digest('base64url');
}

export function issueMobileCallActionToken(payload: MobileCallActionTokenPayload): string {
  const secret = getMobileCallActionSecret();
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signEncodedPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyMobileCallActionToken(token: string): MobileCallActionTokenPayload | null {
  try {
    const trimmed = String(token || '').trim();
    const separator = trimmed.lastIndexOf('.');
    if (separator <= 0) return null;
    const encodedPayload = trimmed.slice(0, separator);
    const actualSignature = trimmed.slice(separator + 1);
    if (!encodedPayload || !actualSignature) return null;

    const secret = getMobileCallActionSecret();
    const expectedSignature = signEncodedPayload(encodedPayload, secret);
    const actualBuf = Buffer.from(actualSignature, 'utf8');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
      return null;
    }

    const parsed = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<MobileCallActionTokenPayload>;
    const familyId = String(parsed.familyId || '').trim();
    const callSessionId = String(parsed.callSessionId || '').trim();
    const targetIdentityId = String(parsed.targetIdentityId || '').trim();
    const action = parsed.action === 'decline' ? 'decline' : null;
    const exp = Number(parsed.exp || 0);
    if (!familyId || !callSessionId || !targetIdentityId || !action || !Number.isFinite(exp)) {
      return null;
    }
    if (Date.now() >= exp) {
      return null;
    }

    return { familyId, callSessionId, targetIdentityId, action, exp };
  } catch {
    return null;
  }
}
