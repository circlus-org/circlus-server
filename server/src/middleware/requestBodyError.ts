import type { ErrorRequestHandler } from 'express';
import { getRequestLogger } from './requestContext';
import type { Logger } from '../utils/logger';

type RawBodyReadError = Error & {
  type?: string;
  status?: number;
};

type RequestBodyErrorHandlerOptions = {
  getLogger?: () => Logger;
};

const handledErrorTypes = new Set(['request.aborted', 'stream.not.readable']);

export function createRequestBodyErrorHandler(
  options: RequestBodyErrorHandlerOptions = {}
): ErrorRequestHandler {
  const resolveLogger = options.getLogger
    || (() => getRequestLogger({ subsystem: 'http' }));

  return (error, req, res, next): void => {
    const bodyError = error as RawBodyReadError;
    if (!handledErrorTypes.has(bodyError?.type || '')) {
      next(error);
      return;
    }

    const connectionClosed = Boolean(req.destroyed || req.aborted || res.destroyed);
    const clientFailure = bodyError.type === 'request.aborted' || connectionClosed;
    const statusCode = clientFailure ? 400 : 500;
    resolveLogger().warn('http_request_body_unavailable', {
      path: req.originalUrl || req.url,
      errorType: bodyError.type,
      errorStatus: bodyError.status,
      contentLength: req.get('content-length'),
      connectionClosed
    });

    if (connectionClosed || res.headersSent) return;

    res.status(statusCode).json({
      error: clientFailure
        ? 'Request body was not fully received'
        : 'Request body is unavailable',
      code: clientFailure ? 'REQUEST_BODY_INCOMPLETE' : 'REQUEST_BODY_UNAVAILABLE'
    });
  };
}

export const requestBodyErrorHandler = createRequestBodyErrorHandler();
