import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appliedMigrationChecksumMatch } from './migrationChecksumPolicy';

const version = '018_device_client_protocols.sql';
const original = '68df1ed1a05963ce74f6699aaccc61b091d6cb8d9114a7b0944275377da98899';
const published = '192d03fdfccc7b5e9723ff3c3ba9dd76d466bee52143d089c3b293446ef7d6d6';
const sha = (sql: string) => crypto.createHash('sha256').update(sql).digest('hex');

describe('Published migration checksum policy', () => {
  it('accepts exact hashes for existing public and original installations', () => {
    expect(appliedMigrationChecksumMatch(version, published, published)).toBe('exact');
    expect(appliedMigrationChecksumMatch(version, original, original)).toBe('exact');
  });
  it('accepts only the audited original-to-published 018 transition', () => {
    expect(appliedMigrationChecksumMatch(version, original, published)).toBe('known_comment_only_change');
    expect(appliedMigrationChecksumMatch(version, published, original)).toBeNull();
    expect(appliedMigrationChecksumMatch('019_tenant_suspension_lifecycle.sql', original, published)).toBeNull();
    expect(appliedMigrationChecksumMatch('000-pre-public/' + version, original, published)).toBeNull();
    expect(appliedMigrationChecksumMatch(version, '0'.repeat(64), published)).toBeNull();
  });
  it('pins both historical bytes and proves the SQL statements did not change', () => {
    const current = fs.readFileSync(path.resolve(process.cwd(), 'db/migrations', version), 'utf8');
    const beforeCommentEdit = current.replace('-- last reported its build. Inspector lists devices',
      '-- last reported its build (CLIENT_SERVER_COMPATIBILITY.md). Inspector lists devices');
    expect(sha(current)).toBe(published);
    expect(sha(beforeCommentEdit)).toBe(original);
    const statements = (sql: string) => sql.split('\n').filter(line => !line.startsWith('--')).join('\n');
    expect(statements(current)).toBe(statements(beforeCommentEdit));
    expect(appliedMigrationChecksumMatch(version, original, sha(current + '\n-- another comment edit\n'))).toBeNull();
    expect(appliedMigrationChecksumMatch(version, original, sha(current.replace('jsonb', 'text')))).toBeNull();
  });
});
