import path from 'node:path';
import {
  databaseUrl,
  nodeEnvironment,
  optionalString,
  resolvedPath,
  ServerConfigurationError
} from './runtimeConfigParsing';

export type CliDatabaseRuntimeConfig = {
  databaseUrl: string;
};

export type MigrationCliRuntimeConfig = CliDatabaseRuntimeConfig & {
  migrationsDirOverride: string | null;
};

export type CliAttachmentStorageRuntimeConfig = {
  attachmentsRootDir: string;
};

/**
 * Maintenance/development commands may use the local database default outside
 * production. Production commands must always name their target explicitly.
 */
export function loadCliDatabaseRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): CliDatabaseRuntimeConfig {
  const mode = nodeEnvironment(environment);
  return { databaseUrl: databaseUrl(environment, mode) };
}

/** Database migrations are destructive enough to require an explicit target. */
export function loadMigrationCliRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): MigrationCliRuntimeConfig {
  const migrationsDir = optionalString(environment, 'MIGRATIONS_DIR');
  if (!optionalString(environment, 'DATABASE_URL')) {
    throw new ServerConfigurationError('DATABASE_URL', 'is required for database migrations');
  }
  return {
    databaseUrl: databaseUrl(environment, 'production'),
    migrationsDirOverride: migrationsDir ? path.resolve(migrationsDir) : null
  };
}

export function loadCliAttachmentStorageRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): CliAttachmentStorageRuntimeConfig {
  return {
    attachmentsRootDir: resolvedPath(
      environment,
      'ATTACHMENTS_STORAGE_DIR',
      path.resolve(process.cwd(), 'server-data', 'attachments')
    )
  };
}
