import type { Request, Response, NextFunction } from 'express';
import type { AuthRequest } from './auth';
import type { RateLimitRuntimeConfig } from '../config/rateLimitRuntimeConfig';
import { createRateLimiter } from './rateLimit';

// These are signed operation types, verified against the HTTP route by auth.
// Everything else in these namespaces consumes the mutation budget, including
// read/received acknowledgments and key claims which write to the database.
const READ_TYPES = new Set([
  'msg:reactions:list', 'msg:http:key-fetch', 'msg:http:list', 'msg:http:status-list',
  'msg:http:clear-boundary',
  'grp:reactions:list', 'grp:list', 'grp:keys:fetch', 'grp:keys:coverage',
  'grp:leave-check', 'grp:message:readers', 'grp:messages:list',
  'grp:messages:clear-boundary', 'grp:participants:list', 'grp:state:list',
  'announcement-channels:mine', 'announcement-channels:posts:activity',
  'announcement-channels:posts:list', 'announcement-channels:post-engagement',
  'announcement-channels:keys:fetch', 'announcement-channels:keys:missing',
  'announcement-channels:recipients', 'announcement-channels:removed-recipients',
  'announcement-channels:reactions:list', 'announcement-channels:reactions:readers'
]);

export function communicationRequestBudget(type: string): 'read' | 'write' | null {
  if (!['msg:', 'grp:', 'announcement-channels:'].some(prefix => type.startsWith(prefix))) return null;
  return READ_TYPES.has(type) ? 'read' : 'write';
}

/** Shared across chats, channels and devices; one pair of buckets per tenant/identity.
 * Like the existing IP limiter, counters live in this server process.
 * Must run after signature verification and active identity resolution.
 */
export function createCommunicationIdentityRateLimiter(config: RateLimitRuntimeConfig['communicationIdentity']) {
  const keyFn = (request: Request) => {
    const req = request as AuthRequest;
    return JSON.stringify([req.familyId, req.identity!.identityId]);
  };
  const read = createRateLimiter({ name: 'communication:identity:read', windowMs: config.windowMs, max: config.readMax, keyFn });
  const write = createRateLimiter({ name: 'communication:identity:write', windowMs: config.windowMs, max: config.writeMax, keyFn });
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const budget = communicationRequestBudget(req.signedRequest?.type || '');
    if (!budget) return next();
    if (!req.familyId || !req.identity || req.identity.identityId !== req.device?.identityId) {
      res.status(401).json({ status: 'error', error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }
    return (budget === 'read' ? read : write)(req, res, next);
  };
}
