import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { TenancyRequest } from '../middleware/tenancy';
import { sendApiError } from '../utils/apiResponses';

type TemporaryAccessRequest = AuthRequest<Record<string, unknown>> & TenancyRequest;

export function requestContextError(res: Response) {
  return sendApiError(res, 500, 'INTERNAL_ERROR', 'Request context is incomplete');
}

export function invalidRequestError(res: Response, message: string) {
  return sendApiError(res, 400, 'INVALID_REQUEST', message);
}

export function forbiddenError(res: Response, message: string) {
  return sendApiError(res, 403, 'FORBIDDEN', message);
}

export function forbidGuestIdentity(req: AuthRequest, res: Response): boolean {
  if (req.identity?.role !== 'guest') return false;
  forbiddenError(res, 'Member access required');
  return true;
}

export function notFoundError(res: Response, message: string) {
  return sendApiError(res, 404, 'NOT_FOUND', message);
}

export function invalidStateError(res: Response, message: string) {
  return sendApiError(res, 409, 'INVALID_STATE', message);
}

export function getTrustedDeviceContext(
  req: TemporaryAccessRequest,
  res: Response,
  forbiddenMessage: string
) {
  const familyId = req.familyId;
  if (!familyId || !req.device) {
    requestContextError(res);
    return null;
  }
  if (forbidGuestIdentity(req, res)) return null;
  if (req.device.accessLevel !== 'trusted') {
    forbiddenError(res, forbiddenMessage);
    return null;
  }
  return { familyId, device: req.device };
}
