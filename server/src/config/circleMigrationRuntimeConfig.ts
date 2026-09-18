import path from 'node:path';
import {
  integerSetting,
  optionalFixedBase64Secret,
  resolvedPath
} from './runtimeConfigParsing';

export type CircleMigrationRuntimeConfig = {
  secretKeyBase64: string | null;
  exportDir: string;
  importDir: string;
  httpTimeoutMs: number;
  freezeDrainTimeoutMs: number;
};

export function loadCircleMigrationRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): CircleMigrationRuntimeConfig {
  return {
    secretKeyBase64: optionalFixedBase64Secret(
      environment,
      'CIRCLE_MIGRATION_SECRET_KEY_BASE64',
      32
    ),
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
