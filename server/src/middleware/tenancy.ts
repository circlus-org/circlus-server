import { Request, Response, NextFunction } from 'express';
import { familyDomainRepository } from '../db/repositories/familyDomainRepository';
import { getSecurityRuntimeConfig } from '../config/serverRuntimeConfig';
import { getRequestLogger, updateRequestContext } from './requestContext';
import { getGlobalTrustedClientOrigins, normalizeTrustedOrigin } from '../utils/trustedOrigins';

export interface TenancyRequest extends Request {
  familyId?: string;
  circleId?: string;
  circleSuspended?: boolean;
}

const SUSPENDED_CIRCLE_ENDPOINTS = new Set([
  'POST /api/devices/list',
  'POST /api/devices/revoke',
  'POST /api/temporary-access/devices/list',
  'POST /api/temporary-access/devices/revoke',
  'POST /api/circle-membership/state',
  'POST /api/circle-membership/state/append',
  'POST /api/identities/delete-self',
  'POST /api/identities/delete-owned-circle'
]);

function isSuspendedCircleEndpoint(req: TenancyRequest): boolean {
  return SUSPENDED_CIRCLE_ENDPOINTS.has(`${req.method.toUpperCase()} ${req.path}`);
}

type HostReadableRequest = {
  get?: (name: string) => string | undefined;
  headers?: Record<string, string | string[] | undefined>;
};

export function normalizeHost(host: string): string {
  // - trim whitespace
  // - lower-case
  // - strip trailing dot
  // - strip port (best-effort)
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) return '';

  // Strip port if present. This is safe for normal hostnames like example.com:443.
  // (We don't try to parse IPv6 bracket forms here; Express typically provides hostnames.)
  return trimmed.split(':')[0];
}

function readHeader(req: HostReadableRequest, name: string): string | null {
  if (typeof req.get === 'function') {
    const value = req.get(name);
    if (value) return value;
  }

  const key = name.toLowerCase();
  const raw = req.headers?.[key];
  if (Array.isArray(raw)) return raw[0] || null;
  return raw || null;
}

export function getRequestHost(req: HostReadableRequest): string | null {
  const trustForwardedHost = getSecurityRuntimeConfig().trustForwardedHost;

  const forwardedHost = trustForwardedHost ? readHeader(req, 'x-forwarded-host') : null;
  // No further fallback here (e.g. to Express's req.hostname): when
  // trust proxy is enabled for hop-count purposes (TRUST_PROXY=1),
  // Express derives req.hostname from X-Forwarded-Host on its own,
  // regardless of TENANCY_TRUST_FORWARDED_HOST. Falling back to it would
  // let a request that omits the Host header smuggle a tenant host via
  // X-Forwarded-Host even when forwarded-host trust is not configured.
  // Fail closed instead.
  const rawHost = forwardedHost || readHeader(req, 'host');

  if (!rawHost) return null;
  // X-Forwarded-Host can be a comma-separated list. Use the first value.
  const first = String(rawHost).split(',')[0] || '';
  const normalized = normalizeHost(first);
  return normalized || null;
}

export function getRequestedCircleId(req: HostReadableRequest & { url?: string }): string | null {
  const header = readHeader(req, 'x-circlus-circle-id');
  if (header) return String(header).trim() || null;
  if (!req.url) return null;
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('circleId')?.trim() || null;
  } catch {
    return null;
  }
}

function applyUnavailableCircleCors(
  req: TenancyRequest,
  res: Response,
  extraTrustedClientOrigins: string[]
): boolean {
  const rawOrigin = req.get('origin');
  if (!rawOrigin) return true;

  const origin = normalizeTrustedOrigin(rawOrigin);
  const allowedOrigins = new Set([
    ...getGlobalTrustedClientOrigins(),
    ...extraTrustedClientOrigins.map((entry) => normalizeTrustedOrigin(entry)).filter(Boolean)
  ]);
  if (!origin || !allowedOrigins.has(origin)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-Inspector-Request-Token,X-Request-ID,X-Circlus-Circle-ID'
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID,X-Circlus-Circle-Suspended');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

/**
 * Middleware to determine and set family_id from request host.
 * The host is normalized and resolved through family_domains.
 * Sets the family_id on the request for downstream use
 */
export async function tenancyMiddleware(
  req: TenancyRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const host = getRequestHost(req);
    if (!host) {
      return res.status(400).json({
        status: 'error',
        error: {
          code: 'INVALID_HOST',
          message: 'Missing or invalid Host header'
        }
      });
    }

    const requestedCircleId = getRequestedCircleId(req);
    const resolution = await familyDomainRepository.resolveActiveFamily(host, requestedCircleId);
    if (resolution.kind === 'ambiguous') {
      return res.status(409).json({
        status: 'error',
        error: { code: 'CIRCLE_ID_REQUIRED', message: 'This origin hosts multiple Circles; specify X-Circlus-Circle-ID' }
      });
    }
    const familyId = resolution.kind === 'found' ? resolution.familyId : null;
    if (!familyId) {
      const deletedDomain = await familyDomainRepository.findDeletedByHost(host, requestedCircleId);
      if (deletedDomain) {
        const originAllowed = applyUnavailableCircleCors(
          req,
          res,
          deletedDomain.extra_trusted_client_origins || []
        );
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') {
          return originAllowed ? res.status(204).end() : res.status(403).end();
        }
        return res.status(410).json({
          status: 'error',
          error: {
            code: 'CIRCLE_DELETED',
            message: 'This Circle was permanently deleted from the server',
            details: { deletedAt: deletedDomain.deleted_at.toISOString() }
          }
        });
      }
      const suspendedDomain = await familyDomainRepository.findSuspendedByHost(host, requestedCircleId);
      if (suspendedDomain) {
        const originAllowed = applyUnavailableCircleCors(
          req,
          res,
          suspendedDomain.extra_trusted_client_origins || []
        );
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') {
          return originAllowed ? res.status(204).end() : res.status(403).end();
        }
        if (originAllowed && isSuspendedCircleEndpoint(req)) {
          req.familyId = suspendedDomain.family_id;
          req.circleId = suspendedDomain.circle_id;
          req.circleSuspended = true;
          updateRequestContext({ familyId: suspendedDomain.family_id });
          res.setHeader('X-Circlus-Circle-Suspended', '1');
          next();
          return;
        }
        return res.status(423).json({
          status: 'error',
          error: {
            code: 'CIRCLE_SUSPENDED',
            message: 'This Circle is temporarily suspended by the server administrator',
            details: { suspendedAt: suspendedDomain.suspended_at.toISOString() }
          }
        });
      }
      return res.status(404).json({
        status: 'error',
        error: {
          code: 'UNKNOWN_FAMILY_DOMAIN',
          message: 'Host is not mapped to an active family domain'
        }
      });
    }

    // Set family_id in request for downstream use
    req.familyId = familyId;
    req.circleId = resolution.kind === 'found' ? resolution.circleId : undefined;
    updateRequestContext({ familyId });

    next();
  } catch (error) {
    getRequestLogger({ subsystem: 'tenancy' }).error('tenancy_resolution_failed', { error });
    return res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to determine family context'
      }
    });
  }
}

/**
 * Resolve family_id from a host using active family domain mappings.
 * The host will be normalized (lower-case, port stripped).
 */
export async function resolveFamilyIdFromHost(host: string, circleId?: string | null): Promise<string | null> {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  return familyDomainRepository.findFamilyIdByActiveHost(normalized, circleId);
}

export async function resolveCircleContextFromHost(
  host: string,
  circleId?: string | null
): Promise<{ familyId: string; circleId: string } | null> {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  const result = await familyDomainRepository.resolveActiveFamily(normalized, circleId);
  return result.kind === 'found'
    ? { familyId: result.familyId, circleId: result.circleId }
    : null;
}
