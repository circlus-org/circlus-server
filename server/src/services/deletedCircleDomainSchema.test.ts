import fs from 'node:fs';
import path from 'node:path';

describe('deleted Circle domain tombstone schema', () => {
  it('keeps deletion tombstones outside the tenant foreign-key lifecycle', () => {
    const schemaPath = [
      path.resolve(process.cwd(), 'db/migrations/001_initial_schema.sql'),
      path.resolve(process.cwd(), '../SERVER_PUBLIC_INITIAL_SCHEMA.sql')
    ].find((candidate) => fs.existsSync(candidate));
    if (!schemaPath) throw new Error('Public initial schema not found');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const repository = fs.readFileSync(
      path.resolve(process.cwd(), 'src/db/repositories/familyConfigRepository.ts'),
      'utf8'
    );

    const table = schema.match(/CREATE TABLE (?:public\.)?deleted_circle_domains \(([\s\S]*?)\n\);/)?.[1] || '';
    expect(table).not.toBe('');
    expect(table).not.toMatch(/REFERENCES (?:public\.)?family_config/i);
    expect(repository).toMatch(/INSERT INTO deleted_circle_domains[\s\S]*DELETE FROM family_config/);
  });

  it('deletes announcement-channel dependants before guest links and identities', () => {
    const repository = fs.readFileSync(
      path.resolve(process.cwd(), 'src/db/repositories/familyConfigRepository.ts'),
      'utf8'
    );
    const deleteOrder = repository.match(/const tenantTablesInDeleteOrder = \[([\s\S]*?)\];/)?.[1] || '';
    const indexOf = (table: string) => deleteOrder.indexOf(`'${table}'`);

    for (const table of [
      'announcement_channel_push_outbox',
      'circle_site_publications',
      'announcement_channel_key_envelopes',
      'announcement_channel_posts',
      'announcement_channel_epoch_keys',
      'announcement_channel_subscriptions',
      'announcement_channel_links',
      'announcement_channels'
    ]) {
      expect(indexOf(table)).toBeGreaterThanOrEqual(0);
    }
    expect(indexOf('announcement_channel_links')).toBeLessThan(indexOf('direct_guest_links'));
    expect(indexOf('announcement_channels')).toBeLessThan(indexOf('direct_guest_links'));
    expect(indexOf('announcement_channel_posts')).toBeLessThan(indexOf('identities'));
  });

  it('clears an old deletion tombstone when its host is assigned to a new Circle', () => {
    const repository = fs.readFileSync(
      path.resolve(process.cwd(), 'src/db/repositories/familyDomainRepository.ts'),
      'utf8'
    );
    expect(repository).toContain('DELETE FROM deleted_circle_domains WHERE host = $1');
    expect(repository).not.toContain(
      'DELETE FROM deleted_circle_domains WHERE family_id = $1 AND host = $2'
    );
  });
});
