import type { NextFunction, Request, Response } from 'express';
import type { ApiResponse, ErrorCode } from '../../../shared/types';
import type { TenancyRequest } from './tenancy';

export type RateLimitKeyFn = (req: Request) => string;

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAtMs: number;
  windowMs: number;
  key: string;
  name: string;
}

export interface RateLimiterOptions {
  name: string;
  windowMs: number;
  max: number;
  keyFn: RateLimitKeyFn;
  /**
   * Optional hook to customize 429 response.
   * If omitted, returns `{ status: 'error', error: { code: 'RATE_LIMITED', ... } }`.
   */
  onRateLimited?: (req: Request, res: Response, info: RateLimitInfo) => void;
}

type Bucket = {
  count: number;
  resetAtMs: number;
};

function normalizeKeyPart(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function ipKey(req: Request): string {
  // Express handles trust proxy via app.set('trust proxy', ...).
  // We intentionally rely on req.ip to avoid trusting spoofable headers.
  return `ip:${normalizeKeyPart(req.ip || 'unknown')}`;
}

export function familyKey(req: Request): string {
  const familyId = (req as TenancyRequest).familyId || 'unknown-family';
  return `family:${normalizeKeyPart(familyId)}`;
}

export function ipFamilyKey(req: Request): string {
  const familyId = (req as TenancyRequest).familyId || 'unknown-family';
  return `${ipKey(req)}|family:${normalizeKeyPart(familyId)}`;
}

export function deviceFamilyKey(req: Request): string {
  const familyId = (req as TenancyRequest).familyId || 'unknown-family';
  const deviceId = (req as Request & { device?: { deviceId?: string } }).device?.deviceId || 'unknown-device';
  return `device:${normalizeKeyPart(deviceId)}|family:${normalizeKeyPart(familyId)}`;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const buckets = new Map<string, Bucket>();
  let tick = 0;

  function maybePrune(nowMs: number) {
    // Best-effort pruning to avoid unbounded growth.
    // Runs roughly every 1000 requests.
    tick = (tick + 1) % 1000;
    if (tick !== 0) return;

    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAtMs <= nowMs) {
        buckets.delete(key);
      }
    }
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const nowMs = Date.now();
    maybePrune(nowMs);

    const key = options.keyFn(req);
    const windowMs = options.windowMs;
    const limit = options.max;

    const existing = buckets.get(key);
    if (!existing || existing.resetAtMs <= nowMs) {
      buckets.set(key, { count: 1, resetAtMs: nowMs + windowMs });

      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - 1)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil((nowMs + windowMs) / 1000)));
      return next();
    }

    if (existing.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));

      const info: RateLimitInfo = {
        limit,
        remaining: 0,
        resetAtMs: existing.resetAtMs,
        windowMs,
        key,
        name: options.name
      };

      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(existing.resetAtMs / 1000)));

      if (options.onRateLimited) {
        return options.onRateLimited(req, res, info);
      }

      const body: ApiResponse = {
        status: 'error',
        error: {
          code: 'RATE_LIMITED' as ErrorCode,
          message: 'Too many requests'
        }
      };

      return res.status(429).json(body);
    }

    existing.count += 1;

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - existing.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(existing.resetAtMs / 1000)));

    return next();
  };
}
