import fs from 'node:fs';
import path from 'node:path';
import {
  PRE_PUBLIC_BASELINE_COMPLETION_VERSION,
  PUBLIC_INITIAL_SCHEMA_VERSION,
  shouldAdoptPublicInitialSchema
} from './migrationBaselinePolicy';

describe('Public migration baseline adoption', () => {
  it('adopts 001 when the complete pre-public baseline is already applied', () => {
    expect(shouldAdoptPublicInitialSchema(
      PUBLIC_INITIAL_SCHEMA_VERSION,
      new Set([PRE_PUBLIC_BASELINE_COMPLETION_VERSION])
    )).toBe(true);
  });

  it('does not adopt 001 from an incomplete pre-public database', () => {
    expect(shouldAdoptPublicInitialSchema(
      PUBLIC_INITIAL_SCHEMA_VERSION,
      new Set(['000-pre-public/107_channel_engagement_cursors.sql'])
    )).toBe(false);
  });

  it('requires the latest private migration before adopting the public baseline', () => {
    expect(shouldAdoptPublicInitialSchema(PUBLIC_INITIAL_SCHEMA_VERSION,
      new Set(['000-pre-public/150_invite_expiry_timestamptz.sql',
        '000-pre-public/151_signed_operation_reliability.sql']))).toBe(false);
    const directory = path.resolve(process.cwd(), 'db/migrations/000-pre-public');
    // The exported repository intentionally contains no private migration history.
    if (fs.existsSync(directory)) {
      const migrations = fs.readdirSync(directory).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
      expect(PRE_PUBLIC_BASELINE_COMPLETION_VERSION).toBe('000-pre-public/' + migrations.at(-1));
      expect(fs.readdirSync(path.dirname(directory)).filter(name => /^\d{3}_.+\.sql$/.test(name))).toEqual([]);
    }
  });

  it('does not baseline later public migrations', () => {
    expect(shouldAdoptPublicInitialSchema(
      '002_example.sql',
      new Set([PRE_PUBLIC_BASELINE_COMPLETION_VERSION])
    )).toBe(false);
  });
});

