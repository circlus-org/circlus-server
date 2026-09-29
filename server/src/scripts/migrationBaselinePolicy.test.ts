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
      expect(fs.readdirSync(path.dirname(directory)).filter(name => /^\d{3}_.+\.sql$/.test(name))).toEqual([
        '002_managed_push_configuration.sql',
        '003_archive_legacy_circle_membership_v1.sql',
        '004_remove_server_admin_owner_recovery.sql',
        '005_forbid_plaintext_identity_names.sql',
        '006_encrypt_circle_names_and_statuses.sql',
        '007_correct_avatar_storage_comment.sql',
        '008_remove_legacy_plaintext_and_quota_fields.sql',
        '009_require_group_chat_protocol_v2.sql',
        '010_delete_legacy_identity_backups.sql',
        '011_encrypt_private_link_and_device_metadata.sql',
        '012_encrypt_channel_metadata_and_reaction_codes.sql',
        '013_call_handling_blocking_session.sql',
        '014_direct_message_read_proof.sql'
      ]);
    }
  });

  it('does not baseline later public migrations', () => {
    expect(shouldAdoptPublicInitialSchema(
      '002_example.sql',
      new Set([PRE_PUBLIC_BASELINE_COMPLETION_VERSION])
    )).toBe(false);
  });

  it('removes unsigned owner recovery without invalidating historical ownership rows', () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'db/migrations/004_remove_server_admin_owner_recovery.sql'),
      'utf8'
    );
    expect(migration).toContain('DROP TABLE IF EXISTS circle_owner_recovery_claims');
    expect(migration).toContain("CHECK (method = 'voluntary_transfer') NOT VALID");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+circle_owner_changes/i);
  });

  it('forbids plaintext participant names in legacy compatibility columns', () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'db/migrations/005_forbid_plaintext_identity_names.sql'),
      'utf8'
    );
    expect(migration).toMatch(/UPDATE identities[\s\S]+identity_name = NULL/i);
    expect(migration).toContain('CHECK (identity_name IS NULL)');
    expect(migration).toContain('CHECK (accepted_identity_name IS NULL)');
    expect(migration).toContain('CHECK (publish_identity = FALSE)');
    expect(migration).toMatch(/UPDATE family_config[\s\S]+no_names_on_server = TRUE/i);
  });

  it('removes plaintext Circle names and status text', () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'db/migrations/006_encrypt_circle_names_and_statuses.sql'),
      'utf8'
    );
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS circle_encrypted_shared_metadata');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS circle_encrypted_identity_statuses');
    expect(migration).toMatch(/family_id UUID/i);
    expect(migration).toContain('REFERENCES circle_profile_epochs(family_id, epoch)');
    expect(migration).toMatch(/UPDATE identities SET status_text = NULL/i);
    expect(migration).toMatch(/UPDATE family_config[\s\S]+SET server_name = COALESCE/i);
    expect(migration).toContain("fd.role = 'primary'");
    expect(migration).not.toContain('domain_kind');
    expect(migration).toContain('CHECK (status_text IS NULL)');
  });

  it('removes obsolete identity, invite, recovery, and attachment compatibility storage', () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'db/migrations/008_remove_legacy_plaintext_and_quota_fields.sql'),
      'utf8'
    );
    for (const column of ['status_text', 'status_updated_at', 'invite_quota', 'invite_used']) {
      expect(migration).toContain(`DROP COLUMN IF EXISTS ${column}`);
    }
    for (const column of [
      'accepted_by_identity_id',
      'accepted_by_public_key',
      'accepted_identity_name',
      'accepted_at',
      'title'
    ]) {
      expect(migration).toContain(`DROP COLUMN IF EXISTS ${column}`);
    }
    expect(migration).toContain('DROP TABLE IF EXISTS circle_membership_v1_recovery_archive');
    expect(migration).toContain('RENAME COLUMN plaintext_sha256 TO ciphertext_sha256');
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS blob_purpose TEXT NOT NULL DEFAULT 'encrypted_payload'");
    expect(migration).toContain("blob_purpose IN ('encrypted_payload', 'public_presentation')");
  });

  it('prevents creation of legacy protocol-v1 group chats', () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'db/migrations/009_require_group_chat_protocol_v2.sql'),
      'utf8'
    );
    expect(migration).toMatch(/ALTER COLUMN protocol_version SET DEFAULT 2/i);
    expect(migration).toContain('CHECK (protocol_version = 2) NOT VALID');
  });

  it('deletes backups created before lookup-secret storage moved into the encrypted vault', () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'db/migrations/010_delete_legacy_identity_backups.sql'),
      'utf8'
    );
    expect(migration).toMatch(/DELETE FROM identity_backups/i);
  });
});
