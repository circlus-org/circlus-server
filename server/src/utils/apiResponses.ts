import type { Response } from 'express';
import type { ApiResponse, ErrorCode } from '../../../shared/types';

/**
 * Keep the public error envelope identical across route modules.
 * Domain-specific helpers should delegate here instead of rebuilding JSON shapes.
 */
export function sendApiError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown
) {
  return res.status(status).json({
    status: 'error',
    error: { code, message, ...(details === undefined ? {} : { details }) }
  } as ApiResponse);
}
