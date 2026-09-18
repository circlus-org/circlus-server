import { routeLogger } from '../utils/routeLogger';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import type { NextFunction, Response } from 'express';
import type { ApiResponse, ErrorCode } from '@shared/types';
import { circleInspectorRepository, type InspectorSessionRecord } from '../db/repositories/circleInspectorRepository';
import { query } from '../db';
import type { AuthRequest } from '../middleware/auth';
import { getPublicAccessRuntimeConfig, getSecurityRuntimeConfig } from '../config/serverRuntimeConfig';

export type InspectorRequest = AuthRequest & {
  inspectorSession?: InspectorSessionRecord;
};

export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyTokenHash(token: string, expectedHash: string | null | undefined): boolean {
  if (!expectedHash) return false;
  const actual = Buffer.from(tokenHash(token), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createToken(prefix: string): string {
  return `${prefix}_${nanoid(40)}`;
}

// Forwarded headers are honoured on the same terms as tenant resolution:
// X-Forwarded-Host only when TENANCY_TRUST_FORWARDED_HOST is set, and the
// protocol through req.protocol, which follows X-Forwarded-Proto only under a
// configured TRUST_PROXY. The host keeps its port, so local HTTP setups still
// produce a reachable approve URL.
export function getServerUrl(req: AuthRequest): string {
  const trustForwardedHost = getSecurityRuntimeConfig().trustForwardedHost;
  const forwardedHost = trustForwardedHost ? req.headers['x-forwarded-host'] : null;
  const rawHost = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  const host = String(rawHost || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.protocol || 'https').trim() || 'https';
  return `${proto}://${host}`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export async function buildApproveUrl(
  req: AuthRequest,
  requestId: string,
  requestToken: string
): Promise<string> {
  const appOpenBase = getPublicAccessRuntimeConfig().appOpenUrl;
  const params = new URLSearchParams({
    type: 'circle-inspector-request',
    server: stripTrailingSlash(getServerUrl(req)),
    requestId,
    secret: requestToken
  });
  return `${appOpenBase}#${params.toString()}`;
}

export function jsonOk<T>(res: Response, result: T) {
  return res.json({ status: 'ok', result } as ApiResponse<T>);
}

export function jsonError(res: Response, status: number, code: ErrorCode, message: string) {
  return res.status(status).json({
    status: 'error',
    error: { code, message }
  } as ApiResponse);
}

export async function requireInspectorSession(req: InspectorRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const familyId = req.familyId;
    if (!familyId) {
      jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Family context is missing');
      return;
    }

    const authorization = String(req.headers.authorization || '');
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();
    if (!token) {
      jsonError(res, 401, 'UNAUTHORIZED' as ErrorCode, 'Inspector session token is required');
      return;
    }

    const now = Date.now();
    const session = await circleInspectorRepository.findActiveSessionByTokenHash(familyId, tokenHash(token), now);
    if (!session) {
      jsonError(res, 401, 'UNAUTHORIZED' as ErrorCode, 'Inspector session is invalid or expired');
      return;
    }

    req.inspectorSession = session;
    await circleInspectorRepository.touchSession(familyId, session.session_id, now);
    next();
  } catch (error) {
    routeLogger.error('Inspector auth error:', error);
    jsonError(res, 500, 'INTERNAL_ERROR' as ErrorCode, 'Internal server error');
  }
}

export function clampLimit(raw: unknown, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

export function optionalNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function tableBlock(params: {
  table: string;
  title: string;
  description: string;
  sql: string;
  values?: unknown[];
}) {
  const result = await query(params.sql, params.values || []);
  return {
    table: params.table,
    title: params.title,
    description: params.description,
    rows: result.rows
  };
}
