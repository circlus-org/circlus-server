import type { AuthRequest } from '../middleware/auth';
import { createNonceStore } from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import { createRateLimiter, ipFamilyKey } from '../middleware/rateLimit';
import {
  getFeaturePolicyRuntimeConfig,
  getRateLimitRuntimeConfig
} from '../config/serverRuntimeConfig';

export type TemporaryChatGrant = { chatId: string; chatType: 'group' | 'direct' };

export function canonicalChatGrants(items: TemporaryChatGrant[]): TemporaryChatGrant[] {
  return [...items]
    .map((item) => ({ chatId: String(item.chatId || '').trim(), chatType: item.chatType }))
    .sort((left, right) => `${left.chatType}:${left.chatId}`.localeCompare(`${right.chatType}:${right.chatId}`));
}

const rateLimits = getRateLimitRuntimeConfig().deviceEnrollments;
export const deviceEnrollmentPolicies = getFeaturePolicyRuntimeConfig().deviceEnrollments;

export const createEnrollmentRateLimiter = createRateLimiter({
  name: 'device-enrollments:create',
  windowMs: rateLimits.windowMs,
  max: rateLimits.createMax,
  keyFn: ipFamilyKey
});

export const readEnrollmentPayloadRateLimiter = createRateLimiter({
  name: 'device-enrollments:payload',
  windowMs: rateLimits.windowMs,
  max: rateLimits.payloadMax,
  keyFn: ipFamilyKey
});

export const usedEnrollmentReadNonces = createNonceStore();
export const usedEnrollmentActivationNonces = createNonceStore();

export function getRequestIp(req: AuthRequest | TenancyRequest): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const firstForwarded = Array.isArray(forwarded)
    ? forwarded[0]
    : String(forwarded || '').split(',')[0]?.trim();
  return firstForwarded || req.ip || null;
}

export function isEnrollmentExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now();
}
