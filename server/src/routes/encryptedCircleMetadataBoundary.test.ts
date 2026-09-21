import fs from 'node:fs';
import path from 'node:path';

describe('Encrypted Circle metadata boundary', () => {
  it('stores status ciphertext and never writes plaintext status text', () => {
    const route = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/status.ts'), 'utf8');
    expect(route).toContain('circle_encrypted_identity_statuses');
    expect(route).toContain('encryptedStatus');
    expect(route).not.toContain('updateStatusText');
    expect(route).not.toMatch(/status_text\s*=/i);
  });

  it('publishes shared metadata only through the owner-authorized Circle route', () => {
    const route = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/circleMembership.ts'), 'utf8');
    expect(route).toContain("router.post('/shared-metadata/publish'");
    expect(route).toMatch(/shared-metadata\/publish'[\s\S]{0,200}requireAdmin/);
    expect(route).toContain('circle_encrypted_shared_metadata');

    const adminConfigRoute = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/adminConfigRoutes.ts'), 'utf8');
    const serverAdminRoute = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/serverAdmin.ts'), 'utf8');
    expect(adminConfigRoute.match(/Circle names must use encrypted shared metadata/g)?.length).toBe(1);
    expect(serverAdminRoute).toContain('Circle names must be changed by the Circle owner using encrypted shared metadata');
  });

  it('clears and permanently rejects legacy plaintext status values', () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'db/migrations/006_encrypt_circle_names_and_statuses.sql'),
      'utf8'
    );
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS circle_encrypted_shared_metadata');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS circle_encrypted_identity_statuses');
    expect(migration).toMatch(/family_id UUID/i);
    expect(migration).toContain('REFERENCES identities(family_id, identity_id)');
    expect(migration).toContain('REFERENCES circle_profile_epochs(family_id, epoch)');
    expect(migration).toMatch(/UPDATE identities SET status_text = NULL/i);
    expect(migration).toMatch(/CHECK \(status_text IS NULL\)/i);
    const cleanupMigration = fs.readFileSync(
      path.resolve(process.cwd(), 'db/migrations/008_remove_legacy_plaintext_and_quota_fields.sql'),
      'utf8'
    );
    expect(cleanupMigration).toMatch(/DROP COLUMN IF EXISTS status_text/i);
    expect(cleanupMigration).toMatch(/DROP COLUMN IF EXISTS status_updated_at/i);
  });
});
