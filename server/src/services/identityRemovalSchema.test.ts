import fs from 'node:fs';
import path from 'node:path';

describe('identity removal schema migration', () => {
  const schemaPath = [
    path.resolve(process.cwd(), 'db/migrations/001_initial_schema.sql'),
    path.resolve(process.cwd(), '../SERVER_PUBLIC_INITIAL_SCHEMA.sql')
  ].find((candidate) => fs.existsSync(candidate));
  if (!schemaPath) throw new Error('Public initial schema not found');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  test('adds a terminal identity status with audit metadata', () => {
    const identities = schema.match(/CREATE TABLE (?:public\.)?identities \(([\s\S]*?)\n\);/)?.[1] || '';
    expect(identities).toContain("'removed'");
    expect(identities).toMatch(/removed_at timestamp with time zone/i);
    expect(identities).toMatch(/removed_by_identity_id character varying\(255\)/i);
  });
});
