import {
  bodyLimitSetting,
  booleanSetting,
  integerSetting,
  nodeEnvironment
} from './runtimeConfigParsing';

export type SecurityRuntimeConfig = {
  nonceWindowMs: number;
  maxTimestampDriftMs: number;
  allowInsecureHttp: boolean;
  trustForwardedHost: boolean;
};

export type HttpRuntimeConfig = {
  jsonBodyLimits: {
    default: string;
    messageArchive: string;
    vault: string;
  };
  globalRateLimit: { windowMs: number; max: number };
};

export function loadSecurityRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): SecurityRuntimeConfig {
  const mode = nodeEnvironment(environment);
  return {
    nonceWindowMs: integerSetting({
      environment,
      key: 'NONCE_WINDOW_MS',
      defaultValue: 300_000,
      min: 1_000,
      max: 24 * 60 * 60 * 1000
    }),
    maxTimestampDriftMs: integerSetting({
      environment,
      key: 'MAX_TIMESTAMP_DRIFT_MS',
      defaultValue: 60_000,
      min: 1_000,
      max: 60 * 60 * 1000
    }),
    allowInsecureHttp: booleanSetting({
      environment,
      key: 'SECURITY_ALLOW_INSECURE_HTTP',
      defaultValue: mode !== 'production'
    }),
    trustForwardedHost: booleanSetting({
      environment,
      key: 'TENANCY_TRUST_FORWARDED_HOST',
      defaultValue: false
    }) || environment.TRUST_PROXY?.trim().toLowerCase() === 'true'
  };
}

export function loadHttpRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): HttpRuntimeConfig {
  return {
    jsonBodyLimits: {
      default: bodyLimitSetting(environment, 'API_JSON_LIMIT', '1mb'),
      messageArchive: bodyLimitSetting(environment, 'MESSAGE_ARCHIVE_JSON_LIMIT', '2mb'),
      vault: bodyLimitSetting(environment, 'VAULT_JSON_LIMIT', '8mb')
    },
    globalRateLimit: {
      windowMs: integerSetting({
        environment,
        key: 'RATE_LIMIT_GLOBAL_WINDOW_MS',
        defaultValue: 60_000,
        min: 1_000,
        max: 24 * 60 * 60 * 1000
      }),
      max: integerSetting({
        environment,
        key: 'RATE_LIMIT_GLOBAL_MAX',
        defaultValue: 600,
        min: 1,
        max: 1_000_000
      })
    }
  };
}
