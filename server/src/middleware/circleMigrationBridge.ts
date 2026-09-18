import type { NextFunction, Request, Response } from 'express';
import {
  circleMigrationRepository,
  type FamilyMigrationRedirectRecord
} from '../db/repositories/circleMigrationRepository';
import { getRequestHost } from './tenancy';
import { getRequestLogger, updateRequestContext } from './requestContext';

const BRIDGE_CONTEXT_KEY = 'circleMigrationRedirect';

type BridgeLocals = {
  [BRIDGE_CONTEXT_KEY]?: FamilyMigrationRedirectRecord | null;
};

/**
 * Resolve the old Circle host before CORS so per-Circle trusted origins remain
 * able to read the signed CIRCLE_MOVED response after the active domain mapping
 * has moved to the destination server.
 */
export async function circleMigrationBridgeContextMiddleware(
  req: Request & { familyId?: string },
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const host = getRequestHost(req);
    const redirect = host
      ? await circleMigrationRepository.findActiveRedirectByHost(host)
      : null;
    (res.locals as BridgeLocals)[BRIDGE_CONTEXT_KEY] = redirect;
    if (redirect) {
      req.familyId = redirect.family_id;
      updateRequestContext({ familyId: redirect.family_id });
    }
    next();
  } catch (error) {
    getRequestLogger({ subsystem: 'circle_migration_bridge' }).error(
      'circle_migration_bridge_context_lookup_failed',
      { error }
    );
    res.status(503).json({
      status: 'error',
      error: {
        code: 'MIGRATION_STATE_UNAVAILABLE',
        message: 'Could not verify Circle migration redirect'
      }
    });
  }
}

export async function circleMigrationBridgeMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const locals = res.locals as BridgeLocals;
    const contextWasResolved = Object.prototype.hasOwnProperty.call(locals, BRIDGE_CONTEXT_KEY);
    const host = contextWasResolved ? null : getRequestHost(req);
    const redirect = contextWasResolved
      ? locals[BRIDGE_CONTEXT_KEY] || null
      : host
        ? await circleMigrationRepository.findActiveRedirectByHost(host)
        : null;
    if (!redirect) {
      next();
      return;
    }

    const proof = redirect.owner_signed_migration_proof as {
      payload?: Record<string, unknown>;
      signature?: string;
    };
    const details = {
      targetPublicBaseUrl: redirect.moved_to,
      familyId: redirect.family_id,
      movedAt: redirect.migrated_at.toISOString(),
      bridgeExpiresAt: redirect.bridge_expires_at.toISOString(),
      migrationProof: {
        payload: proof?.payload || {},
        ownerPublicKey: redirect.owner_public_key,
        ownerSignature: proof?.signature || ''
      }
    };

    if (req.path.startsWith('/api/') || req.path === '/ws') {
      res.status(410).json({
        status: 'error',
        error: {
          code: 'CIRCLE_MOVED',
          message: 'Circle moved to another server',
          details
        }
      });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const destination = new URL(req.originalUrl || req.url || '/', redirect.moved_to);
      res.redirect(301, destination.toString());
      return;
    }
    res.status(410).json({
      status: 'error',
      error: {
        code: 'CIRCLE_MOVED',
        message: 'Circle moved to another server',
        details
      }
    });
  } catch (error) {
    getRequestLogger({ subsystem: 'circle_migration_bridge' }).error(
      'circle_migration_bridge_lookup_failed',
      { error }
    );
    res.status(503).json({
      status: 'error',
      error: {
        code: 'MIGRATION_STATE_UNAVAILABLE',
        message: 'Could not verify Circle migration redirect'
      }
    });
  }
}
