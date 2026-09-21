import type { NextFunction, Response } from 'express';
import type { AuthRequest } from './auth';
import { circleMigrationRepository } from '../db/repositories/circleMigrationRepository';
import { getCircleMigrationRuntimeConfig } from '../config/serverRuntimeConfig';
import { getRequestLogger } from './requestContext';

export interface CircleFreezeState {
  migrationId: string;
  migrationStatus: string;
  targetPublicBaseUrl: string;
}

type CachedFreezeState = {
  value: CircleFreezeState | null;
  expiresAt: number;
};

const activeRequests = new Map<string, number>();
const forcedFreezeStates = new Map<string, CircleFreezeState>();
const freezeCache = new Map<string, CachedFreezeState>();

function isReadAllowedDuringFreeze(method: string, path: string): boolean {
  if (method === 'GET') {
    return (
      path === '/config/capabilities'
      || path === '/config/ice-servers'
      || /^\/identities\/[^/]+\/avatar$/.test(path)
    );
  }
  if (method !== 'POST') return false;
  if ([
    '/config/server-name',
    '/identities/presence-settings',
    '/circle-membership/directory',
    '/messages/key/fetch',
    '/messages/list',
    '/messages/reactions/list',
    '/messages/status-list',
    '/system-events/list',
    '/attachments/policy',
    '/backup/list',
    '/status/get',
    '/status/my',
    '/vault/head',
    '/vault/get'
  ].includes(path)) {
    return true;
  }
  return (
    /^\/attachments\/blobs\/[^/]+\/(read|metadata)$/.test(path)
    || /^\/announcement-channels\/[^/]+\/reactions\/(list|readers)$/.test(path)
    || path === '/group-chats/list'
    || /^\/group-chats\/[^/]+\/participants\/list$/.test(path)
    || /^\/group-chats\/[^/]+\/keys\/(fetch|coverage)$/.test(path)
    || /^\/group-chats\/[^/]+\/messages\/list$/.test(path)
    || /^\/group-chats\/[^/]+\/reactions\/list$/.test(path)
    || /^\/group-chats\/[^/]+\/messages\/[^/]+\/readers$/.test(path)
  );
}

function requestFinished(familyId: string): void {
  const next = Math.max(0, (activeRequests.get(familyId) || 1) - 1);
  if (next === 0) activeRequests.delete(familyId);
  else activeRequests.set(familyId, next);
}

export async function getCircleFreezeState(familyId: string): Promise<CircleFreezeState | null> {
  const forced = forcedFreezeStates.get(familyId);
  if (forced) return forced;
  const cached = freezeCache.get(familyId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const migration = await circleMigrationRepository.findFrozenSourceMigrationByFamily(familyId);
  const value = migration
    ? {
        migrationId: migration.migration_id,
        migrationStatus: migration.status,
        targetPublicBaseUrl: migration.destination_public_base_url
      }
    : null;
  freezeCache.set(familyId, { value, expiresAt: Date.now() + 1000 });
  return value;
}

export function activateCircleFreeze(familyId: string, state: CircleFreezeState): void {
  forcedFreezeStates.set(familyId, state);
  freezeCache.set(familyId, { value: state, expiresAt: Number.POSITIVE_INFINITY });
}

export function updateCircleFreezeStatus(familyId: string, migrationStatus: string): void {
  const current = forcedFreezeStates.get(familyId);
  if (!current) return;
  const next = { ...current, migrationStatus };
  forcedFreezeStates.set(familyId, next);
  freezeCache.set(familyId, { value: next, expiresAt: Number.POSITIVE_INFINITY });
}

export function deactivateCircleFreeze(familyId: string): void {
  forcedFreezeStates.delete(familyId);
  freezeCache.delete(familyId);
}

export async function waitForCircleRequestsToDrain(familyId: string): Promise<void> {
  const timeoutMs = getCircleMigrationRuntimeConfig().freezeDrainTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  while ((activeRequests.get(familyId) || 0) > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${activeRequests.get(familyId)} active Circle requests`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function circleMigrationFreezeMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const familyId = req.familyId;
  if (!familyId || req.path.startsWith('/admin/migration/')) {
    next();
    return;
  }
  try {
    const freeze = await getCircleFreezeState(familyId);
    if (freeze) {
      if (isReadAllowedDuringFreeze(req.method, req.path)) {
        next();
        return;
      }
      res.status(409).json({
        status: 'error',
        error: {
          code: 'CIRCLE_MIGRATING',
          message: 'Circle migration is in progress',
          details: {
            migrationStatus: freeze.migrationStatus,
            targetPublicBaseUrl: freeze.targetPublicBaseUrl,
            retryAfterSeconds: 300
          }
        }
      });
      return;
    }
    if (isReadAllowedDuringFreeze(req.method, req.path)) {
      next();
      return;
    }
    activeRequests.set(familyId, (activeRequests.get(familyId) || 0) + 1);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      requestFinished(familyId);
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  } catch (error) {
    getRequestLogger({ subsystem: 'circle_migration_freeze' }).error(
      'circle_migration_freeze_check_failed',
      { familyId: req.familyId, error }
    );
    res.status(503).json({
      status: 'error',
      error: {
        code: 'MIGRATION_STATE_UNAVAILABLE',
        message: 'Could not verify Circle migration state'
      }
    });
  }
}
