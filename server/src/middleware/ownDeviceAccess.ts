import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth';

/** Managing one's devices does not grant membership or temporary delegation. */
export function requireOwnDeviceManagement(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.device && req.device.accessLevel !== 'temporary'
    && ['owner', 'member', 'guest'].includes(req.identity?.role || '')) {
    next();
    return;
  }
  res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN', message: 'A trusted identity device is required' } });
}

export function requireOwnDeviceEnrollmentMode(req: AuthRequest, res: Response, next: NextFunction): void {
  const payload = req.signedRequest?.payload as { accessMode?: string } | undefined;
  if (req.identity?.role === 'guest' && payload?.accessMode !== 'full_circle') {
    res.status(403).json({ status: 'error', error: { code: 'FORBIDDEN', message: 'Guests can only connect their own trusted devices' } });
    return;
  }
  next();
}
