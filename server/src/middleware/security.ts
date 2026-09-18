import type { NextFunction, Request, Response } from 'express';
import type { CorsOptions, CorsOptionsDelegate } from 'cors';
import { configService } from '../services/configService';
import type { TenancyRequest } from './tenancy';
import { getEffectiveTrustedClientOrigins, isTrustedClientOrigin } from '../utils/trustedOrigins';
import { getSecurityRuntimeConfig } from '../config/serverRuntimeConfig';
import { getRequestLogger } from './requestContext';

function toWsOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildConnectSrc(): string {
  const origins = getEffectiveTrustedClientOrigins(null);
  const wsOrigins = origins
    .map((origin) => toWsOrigin(origin))
    .filter((origin): origin is string => Boolean(origin));
  return ["'self'", ...origins, ...wsOrigins].join(' ');
}

function allowsInsecureHttp(): boolean {
  return getSecurityRuntimeConfig().allowInsecureHttp;
}

export async function isTrustedClientRequestOrigin(origin: string | null | undefined, familyId?: string): Promise<boolean> {
  if (!origin) return true;

  const config = familyId ? await configService.getFamilyConfig(familyId) : null;
  return isTrustedClientOrigin(origin, config);
}

export function createCorsOptions(): CorsOptionsDelegate<TenancyRequest> {
  return async (req, callback) => {
    const options: CorsOptions = {
      origin(origin, originCallback) {
        void isTrustedClientRequestOrigin(origin, req.familyId).then((allowed) => {
          originCallback(null, allowed);
        }).catch((error) => {
          getRequestLogger({ subsystem: 'cors' }).error('cors_origin_check_failed', {
            familyId: req.familyId,
            error
          });
          originCallback(null, false);
        });
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Inspector-Request-Token',
        'X-Inspector-Session-Pickup',
        'X-Request-ID',
        'X-Circlus-Circle-ID'
      ],
      exposedHeaders: ['X-Request-ID', 'X-Circlus-Circle-Suspended'],
      maxAge: 600
    };
    callback(null, options);
  };
}

/**
 * CSP for public Circle Site pages. These are server-generated HTML documents
 * that carry an inline <style> block (with self-hosted @font-face rules, see
 * publicSiteFonts.ts) and inline JSON-LD — neither of which the strict
 * API-wide CSP allows. Everything loads same-origin.
 */
export function setPublicSiteSecurityHeaders(res: Response): void {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "media-src 'self'",
    "connect-src 'self'",
    "form-action 'self'"
  ].join('; '));
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  const cspDirectives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    `connect-src ${buildConnectSrc()}`,
    "form-action 'self'"
  ];
  const csp = cspDirectives.join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', [
    'accelerometer=()',
    'camera=(self)',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=(self)',
    'payment=()',
    'usb=()'
  ].join(', '));
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  if (!allowsInsecureHttp()) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}
