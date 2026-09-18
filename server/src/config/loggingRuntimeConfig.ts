import {
  nodeEnvironment,
  optionalString,
  ServerConfigurationError
} from './runtimeConfigParsing';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFormat = 'json' | 'pretty';

export type LoggingRuntimeConfig = {
  level: LogLevel;
  format: LogFormat;
};

export function loadLoggingRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): LoggingRuntimeConfig {
  const mode = nodeEnvironment(environment);
  const level = optionalString(environment, 'LOG_LEVEL')
    || (mode === 'test' ? 'silent' : 'info');
  if (!isLogLevel(level)) {
    throw new ServerConfigurationError(
      'LOG_LEVEL',
      'must be one of debug, info, warn, error, or silent'
    );
  }

  const format = optionalString(environment, 'LOG_FORMAT')
    || (mode === 'production' ? 'json' : 'pretty');
  if (format !== 'json' && format !== 'pretty') {
    throw new ServerConfigurationError('LOG_FORMAT', 'must be json or pretty');
  }

  return { level, format };
}

function isLogLevel(value: string): value is LogLevel {
  return value === 'debug'
    || value === 'info'
    || value === 'warn'
    || value === 'error'
    || value === 'silent';
}
