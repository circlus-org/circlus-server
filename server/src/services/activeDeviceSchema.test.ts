import fs from 'node:fs';
import path from 'node:path';

describe('active device schema', () => {
  it('requires modern key material and attestation for every active device', () => {
    const schemaPath = [
      path.resolve(process.cwd(), 'db/migrations/001_initial_schema.sql'),
      path.resolve(process.cwd(), '../SERVER_PUBLIC_INITIAL_SCHEMA.sql')
    ].find((candidate) => fs.existsSync(candidate));
    if (!schemaPath) throw new Error('Public initial schema not found');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    expect(schema).toContain('devices_active_modern_key_material_check');
    expect(schema).toMatch(/status\)?(?:::\w+)?\s*<>\s*'active'/);
    expect(schema).toMatch(/public_key_algorithm\)?(?:::\w+)?\s*=\s*'ed25519'/);
    expect(schema).toMatch(/encryption_public_key_algorithm\)?(?:::\w+)?\s*=\s*'x25519'/);
    expect(schema).toContain('registration_attestation IS NOT NULL');
    expect(schema).toMatch(/COALESCE\(\(?jsonb_typeof\(registration_attestation\)/);
    expect(schema).toContain("registration_attestation ->> 'version'");
    expect(schema).toContain("registration_attestation -> 'identitySignedRequest'");
    expect(schema).toContain("registration_attestation -> 'deviceKeyBinding'");
  });
});
