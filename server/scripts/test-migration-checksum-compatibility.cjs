// Run against an explicitly supplied disposable localhost PostgreSQL instance.
// Creates only uniquely named fixture databases; never opens application tables.
const { Client } = require('pg');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const url = new URL(process.env.MIGRATION_FIXTURE_DATABASE_URL || '');
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'Fixture PostgreSQL must be localhost');
  const root = path.resolve(__dirname, '..');
  const published = fs.readFileSync(path.join(root, 'db/migrations/018_device_client_protocols.sql'), 'utf8');
  const original = published.replace('-- last reported its build. Inspector lists devices',
    '-- last reported its build (CLIENT_SERVER_COMPATIBILITY.md). Inspector lists devices');
  const hash = sql => crypto.createHash('sha256').update(sql).digest('hex');
  assert.equal(hash(original), '68df1ed1a05963ce74f6699aaccc61b091d6cb8d9114a7b0944275377da98899');
  assert.equal(hash(published), '192d03fdfccc7b5e9723ff3c3ba9dd76d466bee52143d089c3b293446ef7d6d6');
  const admin = new Client({ connectionString: url.href });
  const created = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'circlus-migration018-'));
  const results = [];
  await admin.connect();
  try {
    for (const scenario of ['original', 'public', 'tampered']) {
      const name = 'circlus_migration018_' + crypto.randomBytes(8).toString('hex');
      await admin.query(`CREATE DATABASE "${name}"`); created.push(name);
      const dbUrl = new URL(url); dbUrl.pathname = '/' + name;
      const client = new Client({ connectionString: dbUrl.href });
      await client.connect();
      try {
        await client.query('CREATE TABLE devices (id integer PRIMARY KEY)');
        const appliedSQL = scenario === 'public' ? published : original;
        await client.query(appliedSQL);
        await client.query(`INSERT INTO devices VALUES (1, '{"fixture":1}', now())`);
        await client.query('CREATE TABLE schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
        await client.query('INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)', ['018_device_client_protocols.sql', hash(appliedSQL)]);
        const directory = path.join(temp, scenario); fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, '018_device_client_protocols.sql'), published
          + (scenario === 'tampered' ? '\nALTER TABLE devices ADD COLUMN unexpected_edit boolean;\n' : ''));
        fs.writeFileSync(path.join(directory, '019_fixture_forward.sql'), 'CREATE TABLE migration018_forward_check (id integer);\n');
        const run = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/scripts/migrate.ts'], {
          cwd: root, env: { ...process.env, DATABASE_URL: dbUrl.href, MIGRATIONS_DIR: directory }, encoding: 'utf8'
        });
        assert.equal(run.status, scenario === 'tampered' ? 1 : 0, `Unexpected migrate result for ${scenario}`);
        if (scenario === 'original') assert.match(run.stderr, /KNOWN_COMMENT_ONLY_MIGRATION_CHECKSUM/);
        if (scenario === 'public') assert.doesNotMatch(run.stderr, /KNOWN_COMMENT_ONLY_MIGRATION_CHECKSUM/);
        if (scenario === 'tampered') assert.match(run.stderr, /Published migrations must not be edited/);
        const recorded = await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', ['018_device_client_protocols.sql']);
        assert.equal(recorded.rows[0].checksum, hash(appliedSQL));
        const data = await client.query('SELECT client_protocols FROM devices WHERE id=1');
        assert.deepEqual(data.rows[0].client_protocols, { fixture: 1 });
        const next = await client.query("SELECT to_regclass('public.migration018_forward_check') AS name");
        assert.equal(Boolean(next.rows[0].name), scenario !== 'tampered');
        const column = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name='devices' AND column_name='unexpected_edit'");
        assert.equal(column.rowCount, 0);
        results.push({ scenario, result: 'passed', originalChecksumRetained: true, dataPreserved: true });
      } finally { await client.end(); }
    }
    console.log(JSON.stringify({ migration018CLI: results }, null, 2));
  } finally {
    for (const name of created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
