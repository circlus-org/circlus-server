import type { RequestHandler } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { reliableOperation } from './reliableOperation';

/** Temporary server-first rollout adapter. Remove after old clients update.
 * Authentication must run first. Only registration may omit operationId;
 * supplied IDs remain subject to strict validation and replay protection.
 */
export function compatiblePushRegistration(
  handler: RequestHandler,
  resource?: (req: any) => string
): RequestHandler {
  const strict = reliableOperation(handler, resource);
  return (req: AuthRequest, res, next) => {
    const signed = req.signedRequest;
    if (signed && ['push:subscribe', 'mobile:device:delivery-token:register'].includes(signed.type)
        && !Object.prototype.hasOwnProperty.call(signed, 'operationId')) {
      return handler(req, res, next);
    }
    return strict(req, res, next);
  };
}
