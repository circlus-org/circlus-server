import {
  databaseUrl,
  integerSetting,
  nodeEnvironment,
  parseTrustProxySetting,
  requiredString,
  type NodeEnvironment,
  type TrustProxySetting
} from './runtimeConfigParsing';
import {
  loadSecurityRuntimeConfig,
  loadHttpRuntimeConfig,
  type HttpRuntimeConfig,
  type SecurityRuntimeConfig
} from './securityHttpRuntimeConfig';
import {
  loadCallRuntimeConfig,
  type CallRuntimeConfig,
  type CallRuntimeConfigBundle,
  type WebSocketRuntimeConfig
} from './callRuntimeConfig';
import {
  loadIntegrationRuntimeConfig,
  type IntegrationRuntimeConfig
} from './integrationRuntimeConfig';
import {
  loadCleanupRuntimeConfig,
  loadStorageRuntimeConfig,
  type CleanupRuntimeConfig,
  type StorageRuntimeConfig
} from './storageCleanupRuntimeConfig';
import {
  loadCircleMigrationRuntimeConfig,
  type CircleMigrationRuntimeConfig
} from './circleMigrationRuntimeConfig';
import {
  loadRateLimitRuntimeConfig,
  type RateLimitRuntimeConfig
} from './rateLimitRuntimeConfig';
import {
  loadFeaturePolicyRuntimeConfig,
  type FeaturePolicyRuntimeConfig
} from './featurePolicyRuntimeConfig';
import {
  loadPublicAccessRuntimeConfig,
  type PublicAccessRuntimeConfig
} from './publicAccessRuntimeConfig';
import {
  loadLoggingRuntimeConfig,
  type LoggingRuntimeConfig
} from './loggingRuntimeConfig';

export {
  parseTrustProxySetting,
  ServerConfigurationError
} from './runtimeConfigParsing';
export type { NodeEnvironment, TrustProxySetting } from './runtimeConfigParsing';
export {
  loadSecurityRuntimeConfig,
  loadHttpRuntimeConfig
} from './securityHttpRuntimeConfig';
export type {
  SecurityRuntimeConfig,
  HttpRuntimeConfig
} from './securityHttpRuntimeConfig';
export { loadCallRuntimeConfig } from './callRuntimeConfig';
export type {
  CallRuntimeConfig,
  CallRuntimeConfigBundle,
  WebSocketRuntimeConfig
} from './callRuntimeConfig';
export { loadIntegrationRuntimeConfig } from './integrationRuntimeConfig';
export type { IntegrationRuntimeConfig } from './integrationRuntimeConfig';
export {
  loadCleanupRuntimeConfig,
  loadStorageRuntimeConfig
} from './storageCleanupRuntimeConfig';
export type {
  CleanupRuntimeConfig,
  StorageRuntimeConfig
} from './storageCleanupRuntimeConfig';
export {
  loadCircleMigrationRuntimeConfig
} from './circleMigrationRuntimeConfig';
export type { CircleMigrationRuntimeConfig } from './circleMigrationRuntimeConfig';
export { loadRateLimitRuntimeConfig } from './rateLimitRuntimeConfig';
export type { RateLimitRuntimeConfig } from './rateLimitRuntimeConfig';
export { loadFeaturePolicyRuntimeConfig } from './featurePolicyRuntimeConfig';
export type { FeaturePolicyRuntimeConfig } from './featurePolicyRuntimeConfig';
export { loadPublicAccessRuntimeConfig } from './publicAccessRuntimeConfig';
export type { PublicAccessRuntimeConfig } from './publicAccessRuntimeConfig';
export { loadLoggingRuntimeConfig } from './loggingRuntimeConfig';
export type { LogFormat, LogLevel, LoggingRuntimeConfig } from './loggingRuntimeConfig';

export type ServerIdentityRuntimeConfig = {
  nodeEnvironment: NodeEnvironment;
  vpsId: string;
};

export type CircleAddressRuntimeConfig = {
  managedWildcardBaseDomain: string | null;
};

export function loadCircleAddressRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): CircleAddressRuntimeConfig {
  const normalized = String(environment.CIRCLE_WILDCARD_BASE_DOMAIN || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\.+|\.+$/g, '');
  return { managedWildcardBaseDomain: normalized || null };
}

export type ServerRuntimeConfig = {
  nodeEnvironment: NodeEnvironment;
  databaseUrl: string;
  vpsId: string;
  port: number;
  trustProxy: TrustProxySetting;
  security: SecurityRuntimeConfig;
  http: HttpRuntimeConfig;
  webSocket: WebSocketRuntimeConfig;
  calls: CallRuntimeConfig;
  integrations: IntegrationRuntimeConfig;
  storage: StorageRuntimeConfig;
  cleanup: CleanupRuntimeConfig;
  circleMigration: CircleMigrationRuntimeConfig;
  rateLimits: RateLimitRuntimeConfig;
  featurePolicies: FeaturePolicyRuntimeConfig;
  publicAccess: PublicAccessRuntimeConfig;
  logging: LoggingRuntimeConfig;
  largeJsonRequestLogThresholdBytes: number;
  shutdownGracePeriodMs: number;
};

export function loadServerIdentityRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): ServerIdentityRuntimeConfig {
  return {
    nodeEnvironment: nodeEnvironment(environment),
    vpsId: requiredString(environment, 'VPS_ID')
  };
}

export function loadServerRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): ServerRuntimeConfig {
  const mode = nodeEnvironment(environment);
  const call = loadCallRuntimeConfig(environment);
  return {
    nodeEnvironment: mode,
    databaseUrl: databaseUrl(environment, mode),
    vpsId: requiredString(environment, 'VPS_ID'),
    port: integerSetting({
      environment,
      key: 'PORT',
      defaultValue: 3000,
      min: 1,
      max: 65_535
    }),
    trustProxy: parseTrustProxySetting(environment.TRUST_PROXY),
    security: loadSecurityRuntimeConfig(environment),
    http: loadHttpRuntimeConfig(environment),
    webSocket: call.webSocket,
    calls: call.calls,
    integrations: loadIntegrationRuntimeConfig(environment),
    storage: loadStorageRuntimeConfig(environment),
    cleanup: loadCleanupRuntimeConfig(environment),
    circleMigration: loadCircleMigrationRuntimeConfig(environment),
    rateLimits: loadRateLimitRuntimeConfig(environment),
    featurePolicies: loadFeaturePolicyRuntimeConfig(environment),
    publicAccess: loadPublicAccessRuntimeConfig(environment),
    logging: loadLoggingRuntimeConfig(environment),
    largeJsonRequestLogThresholdBytes: integerSetting({
      environment,
      key: 'LARGE_JSON_REQUEST_LOG_THRESHOLD_BYTES',
      defaultValue: 100 * 1024,
      min: 1,
      max: 1024 * 1024 * 1024
    }),
    shutdownGracePeriodMs: integerSetting({
      environment,
      key: 'SHUTDOWN_GRACE_PERIOD_MS',
      defaultValue: 30_000,
      min: 1_000,
      max: 300_000
    })
  };
}

let activeRuntimeConfig: ServerRuntimeConfig | null = null;

export function initializeServerRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): ServerRuntimeConfig {
  const config = loadServerRuntimeConfig(environment);
  activeRuntimeConfig = config;
  return config;
}

export function getSecurityRuntimeConfig(): SecurityRuntimeConfig {
  return activeRuntimeConfig?.security || loadSecurityRuntimeConfig();
}

export function getCallRuntimeConfig(): CallRuntimeConfigBundle {
  if (activeRuntimeConfig) {
    return {
      webSocket: activeRuntimeConfig.webSocket,
      calls: activeRuntimeConfig.calls
    };
  }
  return loadCallRuntimeConfig();
}

export function getIntegrationRuntimeConfig(): IntegrationRuntimeConfig {
  return activeRuntimeConfig?.integrations || loadIntegrationRuntimeConfig();
}

export function getStorageRuntimeConfig(): StorageRuntimeConfig {
  return activeRuntimeConfig?.storage || loadStorageRuntimeConfig();
}

export function getCleanupRuntimeConfig(): CleanupRuntimeConfig {
  return activeRuntimeConfig?.cleanup || loadCleanupRuntimeConfig();
}

export function getServerIdentityRuntimeConfig(): ServerIdentityRuntimeConfig {
  if (activeRuntimeConfig) {
    return {
      nodeEnvironment: activeRuntimeConfig.nodeEnvironment,
      vpsId: activeRuntimeConfig.vpsId
    };
  }
  return loadServerIdentityRuntimeConfig();
}

export function getCircleAddressRuntimeConfig(): CircleAddressRuntimeConfig {
  return loadCircleAddressRuntimeConfig();
}

export function getCircleMigrationRuntimeConfig(): CircleMigrationRuntimeConfig {
  return activeRuntimeConfig?.circleMigration || loadCircleMigrationRuntimeConfig();
}

export function getRateLimitRuntimeConfig(): RateLimitRuntimeConfig {
  return activeRuntimeConfig?.rateLimits || loadRateLimitRuntimeConfig();
}

export function getFeaturePolicyRuntimeConfig(): FeaturePolicyRuntimeConfig {
  return activeRuntimeConfig?.featurePolicies || loadFeaturePolicyRuntimeConfig();
}

export function getPublicAccessRuntimeConfig(): PublicAccessRuntimeConfig {
  return activeRuntimeConfig?.publicAccess || loadPublicAccessRuntimeConfig();
}

export function getLoggingRuntimeConfig(): LoggingRuntimeConfig {
  return activeRuntimeConfig?.logging || loadLoggingRuntimeConfig();
}
