import { Request, Response, NextFunction } from 'express';
import { familyDomainRepository } from '../db/repositories/familyDomainRepository';
import { getSecurityRuntimeConfig } from '../config/serverRuntimeConfig';
import { getRequestLogger, updateRequestContext } from './requestContext';
import { getGlobalTrustedClientOrigins, normalizeTrustedOrigin } from '../utils/trustedOrigins';
import { isTrustedClientRequestOrigin } from './security';

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
  const rawHeader = req.headers?.['x-circlus-circle-id'];
  if (Array.isArray(rawHeader) && rawHeader.length > 1) throw new Error('CIRCLE_ID_SELECTOR_MISMATCH');
  const header = String(readHeader(req, 'x-circlus-circle-id') || '').trim();
  let queryCircleId = '';
  if (req.url) {
    try {
      const values = new URL(req.url, 'http://localhost').searchParams.getAll('circleId');
      if (values.length > 1) throw new Error('CIRCLE_ID_SELECTOR_MISMATCH');
      queryCircleId = values[0]?.trim() || '';
    } catch (error) {
      if (error instanceof Error && error.message === 'CIRCLE_ID_SELECTOR_MISMATCH') throw error;
    }
  }
  if (header.includes(',') || (header && queryCircleId && header !== queryCircleId)) {
    throw new Error('CIRCLE_ID_SELECTOR_MISMATCH');
  }
  return header || queryCircleId || null;
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
    'Content-Type,Authorization,X-Inspector-Request-Token,X-Request-ID,X-Circlus-Circle-ID,X-Circlus-Client-Version'
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
    if (!requestedCircleId) {
      if (req.method === 'OPTIONS') {
        // Browser preflight carries the header name, never its Circle ID value.
        // Check the origin against hosted Circles without selecting a tenant.
        const origin = req.get('origin');
        const candidates = (await familyDomainRepository.listByHost(host))
          .filter((domain) => domain.status === 'active');
        if (candidates.length > 0) {
          const trusted = !origin || (await Promise.all(
            candidates.map((domain) => isTrustedClientRequestOrigin(origin, domain.family_id))
          )).some(Boolean);
          if (!trusted || !applyUnavailableCircleCors(req, res, origin ? [origin] : [])) {
            return res.status(403).end();
          }
          return res.status(204).end();
        }
        const unavailableDomain = await familyDomainRepository.findDeletedByHost(host, null)
          || await familyDomainRepository.findSuspendedByHost(host, null);
        if (unavailableDomain) {
          const allowed = applyUnavailableCircleCors(req, res, unavailableDomain.extra_trusted_client_origins || []);
          return allowed ? res.status(204).end() : res.status(403).end();
        }
        return res.status(404).json({
          status: 'error',
          error: { code: 'UNKNOWN_FAMILY_DOMAIN', message: 'Host is not mapped to a family domain' }
        });
      }
      getRequestLogger({ subsystem: 'tenancy' }).warn('circle_route_context_missing', {
        operation: 'tenancyMiddleware', reason: 'missing_route_fields',
        missingFields: ['circleId'], host, path: req.path
      });
      return res.status(400).json({
        status: 'error',
        error: { code: 'CIRCLE_ID_REQUIRED', message: 'Specify X-Circlus-Circle-ID' }
      });
    }
    const resolution = await familyDomainRepository.resolveActiveFamily(host, requestedCircleId);
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
    if (error instanceof Error && error.message === 'CIRCLE_ID_SELECTOR_MISMATCH') {
      getRequestLogger({ subsystem: 'tenancy' }).warn('circle_route_context_invalid', {
        operation: 'tenancyMiddleware', reason: 'circle_id_selector_mismatch'
      });
      return res.status(400).json({
        status: 'error',
        error: { code: 'CIRCLE_ID_SELECTOR_MISMATCH', message: 'Circle ID selectors disagree' }
      });
    }
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
export async function resolveFamilyIdFromHost(host: string, circleId: string): Promise<string | null> {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  return familyDomainRepository.findFamilyIdByActiveHost(normalized, circleId);
}

export async function resolveCircleContextFromHost(
  host: string,
  circleId: string
): Promise<{ familyId: string; circleId: string } | null> {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  const result = await familyDomainRepository.resolveActiveFamily(normalized, circleId);
  return result.kind === 'found'
    ? { familyId: result.familyId, circleId: result.circleId }
    : null;
}
