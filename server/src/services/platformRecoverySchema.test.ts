import fs from 'fs';
import path from 'path';

describe('public platform recovery schema', () => {
  const schemaPath = [
    path.resolve(process.cwd(), 'db/migrations/001_initial_schema.sql'),
    path.resolve(process.cwd(), '../SERVER_PUBLIC_INITIAL_SCHEMA.sql')
  ].find((candidate) => fs.existsSync(candidate));
  if (!schemaPath) throw new Error('Public initial schema not found');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  test('contains bindings, one active anchor per internal platform slot and enrollment proof state', () => {
    expect(schema).toContain('CREATE TABLE public.platform_recovery_bindings');
    expect(schema).toContain('recovery_slot text NOT NULL');
    expect(schema).toContain('CREATE UNIQUE INDEX idx_platform_recovery_one_active_identity_slot');
    expect(schema).toContain('platform_recovery_request jsonb');
    expect(schema).toContain('platform_recovery_proof jsonb');
    expect(schema).toContain("enrollment_kind text DEFAULT 'qr'::text NOT NULL");
    expect(schema).toContain('approval_sender_public_key_value text');
  });
});
