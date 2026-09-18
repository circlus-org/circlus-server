import {
  getLoggingRuntimeConfig,
  type LogFormat,
  type LogLevel
} from '../config/serverRuntimeConfig';

export type LogContext = Record<string, unknown>;

export type Logger = {
  debug: (event: string, context?: LogContext) => void;
  info: (event: string, context?: LogContext) => void;
  warn: (event: string, context?: LogContext) => void;
  error: (event: string, context?: LogContext) => void;
  child: (context: LogContext) => Logger;
};

export type LoggerOptions = {
  level: LogLevel;
  format: LogFormat;
  service: string;
  context?: LogContext;
  now?: () => Date;
  write?: (line: string, level: Exclude<LogLevel, 'silent'>) => void;
};

const levelPriority: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const sensitiveKey = /(authorization|cookie|password|secret|token|signature|private.?key|operationId)/i;

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now || (() => new Date());
  const write = options.write || writeLogLine;
  const baseContext = sanitizeContext(options.context || {});

  const emit = (
    level: Exclude<LogLevel, 'silent'>,
    event: string,
    context: LogContext = {}
  ): void => {
    if (!shouldLog(options.level, level)) return;
    const timestamp = now().toISOString();
    const details = {
      ...baseContext,
      ...sanitizeContext(context)
    };
    const entry = {
      ...details,
      timestamp,
      level,
      service: options.service,
      event
    };
    const line = options.format === 'json'
      ? JSON.stringify(entry)
      : formatPrettyLog(timestamp, level, options.service, event, details);
    write(line, level);
  };

  return {
    debug: (event, context) => emit('debug', event, context),
    info: (event, context) => emit('info', event, context),
    warn: (event, context) => emit('warn', event, context),
    error: (event, context) => emit('error', event, context),
    child: (context) => createLogger({
      ...options,
      context: { ...baseContext, ...sanitizeContext(context) },
      now,
      write
    })
  };
}

function shouldLog(configured: LogLevel, requested: Exclude<LogLevel, 'silent'>): boolean {
  return configured !== 'silent' && levelPriority[requested] >= levelPriority[configured];
}

function sanitizeContext(context: LogContext): LogContext {
  return sanitizeValue(context, new WeakSet()) as LogContext;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const sanitized: LogContext = {};
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = sensitiveKey.test(key) ? '[REDACTED]' : sanitizeValue(item, seen);
  }
  seen.delete(value);
  return sanitized;
}

function formatPrettyLog(
  timestamp: string,
  level: Exclude<LogLevel, 'silent'>,
  service: string,
  event: string,
  context: LogContext
): string {
  const details = Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  return `${timestamp} ${level.toUpperCase()} ${service} ${event}${details}`;
}

function writeLogLine(line: string, level: Exclude<LogLevel, 'silent'>): void {
  const output = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  output.write(`${line}\n`);
}

const loggingConfig = getLoggingRuntimeConfig();

export const serverLogger = createLogger({
  ...loggingConfig,
  service: 'circlus-server'
});
