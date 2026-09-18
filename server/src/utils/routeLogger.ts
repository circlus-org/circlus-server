import { getRequestLogger } from '../middleware/requestContext';
import type { LogContext, Logger } from './logger';

type LoggerFactory = (context?: LogContext) => Logger;

export function createRouteLogFunctions(
  loggerFactory: LoggerFactory = getRequestLogger
): {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
} {
  const write = (
    level: 'error' | 'warn' | 'info',
    event: 'http_route_failed' | 'http_route_warning' | 'http_route_info',
    args: unknown[]
  ): void => {
    const { operation, context } = parseRouteLogArguments(args);
    loggerFactory({ subsystem: 'http_route' })[level](event, {
      operation,
      ...context
    });
  };

  return {
    error: (...args) => write('error', 'http_route_failed', args),
    warn: (...args) => write('warn', 'http_route_warning', args),
    info: (...args) => write('info', 'http_route_info', args)
  };
}

export const routeLogger = createRouteLogFunctions();

export const logRouteError = routeLogger.error;
export const logRouteWarning = routeLogger.warn;
export const logRouteInfo = routeLogger.info;

function parseRouteLogArguments(args: unknown[]): {
  operation: string;
  context: LogContext;
} {
  const [label, ...details] = args;
  const context: LogContext = {};
  const errors = details.filter((detail): detail is Error => detail instanceof Error);
  const structured = details.filter(isLogContext);

  if (errors.length === 1) context.error = errors[0];
  if (errors.length > 1) context.errors = errors;
  if (structured.length === 1) context.details = structured[0];
  if (structured.length > 1) context.details = structured;

  return {
    operation: normalizeOperation(label),
    context
  };
}

function normalizeOperation(value: unknown): string {
  if (typeof value !== 'string') return 'unspecified';
  const normalized = value
    .replace(/\[([^\]]+)\]/g, ' $1 ')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 96);
  return normalized || 'unspecified';
}

function isLogContext(value: unknown): value is LogContext {
  return Boolean(value) && typeof value === 'object' && !(value instanceof Error) && !Array.isArray(value);
}
