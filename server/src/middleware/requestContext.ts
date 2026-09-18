import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { serverLogger, type LogContext, type Logger } from '../utils/logger';

export type HttpRequestContext = {
  requestId: string;
  method: string;
  familyId?: string;
};

type RequestContextMiddlewareOptions = {
  logger?: Logger;
  createRequestId?: () => string;
  now?: () => number;
};

const requestContextStorage = new AsyncLocalStorage<HttpRequestContext>();
const acceptedRequestId = /^[A-Za-z0-9._:-]{1,128}$/;

export function createRequestContextMiddleware(
  options: RequestContextMiddlewareOptions = {}
): RequestHandler {
  const logger = options.logger || serverLogger.child({ subsystem: 'http' });
  const createRequestId = options.createRequestId || randomUUID;
  const now = options.now || Date.now;

  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = resolveRequestId(req.get('x-request-id'), createRequestId);
    const context: HttpRequestContext = { requestId, method: req.method };
    const startedAt = now();
    let completed = false;
    const logCompletion = (): void => {
      if (completed) return;
      completed = true;
      logger.info('http_request_completed', {
        ...context,
        statusCode: res.statusCode,
        durationMs: Math.max(0, now() - startedAt),
        aborted: !res.writableEnded
      });
    };

    res.setHeader('X-Request-ID', requestId);
    requestContextStorage.run(context, () => {
      res.once('finish', logCompletion);
      res.once('close', logCompletion);
      next();
    });
  };
}

export const requestContextMiddleware = createRequestContextMiddleware();

export function getRequestContext(): Readonly<HttpRequestContext> | null {
  return requestContextStorage.getStore() || null;
}

export function updateRequestContext(context: Partial<Pick<HttpRequestContext, 'familyId'>>): void {
  const active = requestContextStorage.getStore();
  if (!active) return;
  if (context.familyId !== undefined) active.familyId = context.familyId;
}

export function getRequestLogger(context: LogContext = {}): Logger {
  return serverLogger.child({
    ...(requestContextStorage.getStore() || {}),
    ...context
  });
}

function resolveRequestId(value: string | undefined, createRequestId: () => string): string {
  const normalized = value?.trim();
  return normalized && acceptedRequestId.test(normalized) ? normalized : createRequestId();
}
