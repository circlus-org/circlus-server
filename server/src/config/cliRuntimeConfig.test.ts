import fs from 'node:fs';
import path from 'node:path';
import {
  loadCliAttachmentStorageRuntimeConfig,
  loadCliDatabaseRuntimeConfig,
  loadMigrationCliRuntimeConfig
} from './cliRuntimeConfig';
import { ServerConfigurationError } from './runtimeConfigParsing';

describe('CLI runtime config', () => {
  it('keeps the local database default for development and test commands', () => {
    expect(loadCliDatabaseRuntimeConfig({ NODE_ENV: 'test' })).toEqual({
      databaseUrl: 'postgresql://localhost:5432/family_messenger'
    });
  });

  it('requires an explicit database target in production maintenance commands', () => {
    expect(() => loadCliDatabaseRuntimeConfig({ NODE_ENV: 'production' }))
      .toThrow('DATABASE_URL is required in production');
  });

  it('always requires and validates the migration database target', () => {
    expect(() => loadMigrationCliRuntimeConfig({ NODE_ENV: 'test' }))
      .toThrow('DATABASE_URL is required for database migrations');
    expect(() => loadMigrationCliRuntimeConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'mysql://localhost/circlus'
    })).toThrow(ServerConfigurationError);
  });

  it('resolves optional CLI paths once', () => {
    expect(loadMigrationCliRuntimeConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/circlus',
      MIGRATIONS_DIR: './custom-migrations'
    })).toEqual({
      databaseUrl: 'postgresql://localhost/circlus',
      migrationsDirOverride: path.resolve(process.cwd(), 'custom-migrations')
    });
    expect(loadCliAttachmentStorageRuntimeConfig({
      ATTACHMENTS_STORAGE_DIR: './custom-attachments'
    })).toEqual({
      attachmentsRootDir: path.resolve(process.cwd(), 'custom-attachments')
    });
  });

  it('keeps direct environment access out of standalone CLI commands', () => {
    const scriptRoot = path.resolve(process.cwd(), 'src', 'scripts');
    const scripts = [
      'cleanup-expired-invites.ts',
      'create-server-admin-claim.ts',
      'migrate.ts',
      'provision-tenant.ts'
    ];
    if (fs.existsSync(path.join(scriptRoot, 'seed-demo.ts'))) scripts.push('seed-demo.ts');
    for (const script of scripts) {
      expect(fs.readFileSync(path.join(scriptRoot, script), 'utf8')).not.toContain('process.env');
    }
  });
});
