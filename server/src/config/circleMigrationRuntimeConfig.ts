import net from 'node:net';
import path from 'node:path';
import {
  integerSetting,
  optionalFixedBase64Secret,
  optionalString,
  resolvedPath,
  ServerConfigurationError
} from './runtimeConfigParsing';

export type CircleMigrationRuntimeConfig = {
  secretKeyBase64: string | null;
  exportDir: string;
  importDir: string;
  httpTimeoutMs: number;
  freezeDrainTimeoutMs: number;
  /**
   * Test environments only: destination hostnames that may resolve to a
   * private address. Production servers must leave this empty; the private
   * address block is the protection against requests into the server's own
   * network (SSRF). HTTPS and certificate verification still apply.
   */
  testPrivateEndpointHosts: string[];
};

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function testPrivateEndpointHosts(environment: NodeJS.ProcessEnv): string[] {
  const key = 'CIRCLE_MIGRATION_TEST_PRIVATE_ENDPOINT_HOSTS';
  const hosts = (optionalString(environment, key) || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  for (const host of hosts) {
    if (!HOSTNAME.test(host) || net.isIP(host) !== 0) {
      throw new ServerConfigurationError(key, 'must list hostnames without scheme, port or IP addresses');
    }
  }
  return hosts;
}

export function loadCircleMigrationRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): CircleMigrationRuntimeConfig {
  return {
    secretKeyBase64: optionalFixedBase64Secret(
      environment,
      'CIRCLE_MIGRATION_SECRET_KEY_BASE64',
      32
    ),
    testPrivateEndpointHosts: testPrivateEndpointHosts(environment),
    exportDir: resolvedPath(
      environment,
      'CIRCLE_MIGRATION_EXPORT_DIR',
      path.resolve(process.cwd(), 'server-data', 'circle-migrations')
    ),
    importDir: resolvedPath(
      environment,
      'CIRCLE_MIGRATION_IMPORT_DIR',
      path.resolve(process.cwd(), 'server-data', 'circle-migration-imports')
    ),
    httpTimeoutMs: integerSetting({
      environment, key: 'CIRCLE_MIGRATION_HTTP_TIMEOUT_MS', defaultValue: 10_000, min: 1_000, max: 60_000
    }),
    freezeDrainTimeoutMs: integerSetting({
      environment,
      key: 'CIRCLE_MIGRATION_FREEZE_DRAIN_TIMEOUT_MS',
      defaultValue: 60_000,
      min: 5_000,
      max: 5 * 60 * 1000
    })
  };
}
