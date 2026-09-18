#!/usr/bin/env tsx
import '../env';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { shouldAdoptPublicInitialSchema } from './migrationBaselinePolicy';
import { loadMigrationCliRuntimeConfig } from '../config/cliRuntimeConfig';

type MigrationFile = {
  version: string;
  path: string;
  checksum: string;
  sql: string;
};

function resolveMigrationsDir(migrationsDirOverride: string | null): string {
  const candidates = [
    migrationsDirOverride,
    path.resolve(process.cwd(), 'db/migrations'),
    path.resolve(process.cwd(), 'server/db/migrations'),
    path.resolve(__dirname, '../../db/migrations'),
    path.resolve(__dirname, '../../../../db/migrations')
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error(`Could not find db/migrations directory. Tried: ${candidates.join(', ')}`);
}

function discoverMigrationFiles(migrationsDir: string): MigrationFile[] {
  const migrationNamePattern = /^[0-9]{3}_.+\.sql$/;
  const files: string[] = [];

  const subdirs = fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const subdir of subdirs) {
    const fullSubdir = path.join(migrationsDir, subdir);
    for (const file of fs.readdirSync(fullSubdir).sort()) {
      if (migrationNamePattern.test(file)) {
        files.push(path.join(fullSubdir, file));
      }
    }
  }

  for (const file of fs.readdirSync(migrationsDir).sort()) {
    if (migrationNamePattern.test(file)) {
      files.push(path.join(migrationsDir, file));
    }
  }

  return files.map((filePath) => {
    const sql = fs.readFileSync(filePath, 'utf8');
    return {
      version: path.relative(migrationsDir, filePath).split(path.sep).join('/'),
      path: filePath,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      sql
    };
  });
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function hasExistingApplicationTables(client: Client): Promise<boolean> {
  const result = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name <> 'schema_migrations'
  `);
  return Number(result.rows[0]?.count || 0) > 0;
}

async function getAppliedMigrations(client: Client): Promise<Map<string, string>> {
  const result = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM public.schema_migrations'
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

function shouldBaselineExistingMigration(migration: MigrationFile): boolean {
  if (migration.version.startsWith('000-pre-public/')) {
    return true;
  }
  return migration.version === '001_initial_schema.sql';
}

async function recordMigration(client: Client, migration: MigrationFile): Promise<void> {
  await client.query(
    `INSERT INTO public.schema_migrations (version, checksum)
     VALUES ($1, $2)
     ON CONFLICT (version) DO NOTHING`,
    [migration.version, migration.checksum]
  );
}

async function applyMigration(client: Client, migration: MigrationFile): Promise<void> {
  await client.query('BEGIN');
  try {
    // A pg_dump baseline changes the session search_path to ''. Each following
    // migration must start with the application schema again.
    await client.query('SET LOCAL search_path = public');
    await client.query(migration.sql);
    await recordMigration(client, migration);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const { databaseUrl, migrationsDirOverride } = loadMigrationCliRuntimeConfig();
  const migrationsDir = resolveMigrationsDir(migrationsDirOverride);
  const migrations = discoverMigrationFiles(migrationsDir);
  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${migrationsDir}`);
  }

  console.log('=========================================');
  console.log('Circlus Server - Database Migrations');
  console.log('=========================================');
  console.log(`Migrations: ${migrationsDir}`);
  console.log('');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('circlus_server_migrations'))`);

    const existingApplicationTables = await hasExistingApplicationTables(client);
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const baselineExistingDatabase = existingApplicationTables && applied.size === 0;

    let appliedCount = 0;
    let skippedCount = 0;
    let baselinedCount = 0;

    for (const migration of migrations) {
      const appliedChecksum = applied.get(migration.version);
      if (appliedChecksum) {
        if (appliedChecksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version} was already applied with checksum ${appliedChecksum}, ` +
            `but the file now has checksum ${migration.checksum}. Published migrations must not be edited.`
          );
        }
        console.log(`Skipping ${migration.version} (already applied)`);
        skippedCount += 1;
        continue;
      }

      if (baselineExistingDatabase && shouldBaselineExistingMigration(migration)) {
        await recordMigration(client, migration);
        applied.set(migration.version, migration.checksum);
        console.log(`Recording ${migration.version} as already present in existing database`);
        baselinedCount += 1;
        continue;
      }

      if (shouldAdoptPublicInitialSchema(migration.version, new Set(applied.keys()))) {
        await recordMigration(client, migration);
        applied.set(migration.version, migration.checksum);
        console.log(
          `Recording ${migration.version} as already present from the completed pre-public baseline`
        );
        baselinedCount += 1;
        continue;
      }

      console.log(`Applying ${migration.version}...`);
      await applyMigration(client, migration);
      applied.set(migration.version, migration.checksum);
      appliedCount += 1;
    }

    console.log('');
    console.log(`Applied: ${appliedCount}, skipped: ${skippedCount}, baselined: ${baselinedCount}`);
    console.log('Database migrations complete.');
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext('circlus_server_migrations'))`);
    } finally {
      await client.end();
    }
  }
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
